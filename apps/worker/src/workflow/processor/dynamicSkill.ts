import crypto from "node:crypto";
import child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool } from "pg";
import type { EgressEvent, NetworkPolicy, RuntimeLimits } from "./runtime";
import { isAllowedEgress } from "./runtime";
import { stableStringify } from "./common";
import { parseToolRef } from "./tooling";
import { decryptSecretPayload } from "../../secrets/envelope";

type DynamicSkillExecResult = {
  output: any;
  egress: EgressEvent[];
  depsDigest: string;
  runtimeBackend: "process" | "container" | "remote" | "local";
  degraded: boolean;
};

function getSkillRoots() {
  const raw = String(process.env.SKILL_PACKAGE_ROOTS ?? "");
  const parts = raw
    .split(/[;,]/g)
    .map((x) => x.trim())
    .filter(Boolean);
  const reg = String(process.env.SKILL_REGISTRY_DIR ?? "").trim();
  const registryRoot = path.resolve(reg || path.resolve(process.cwd(), ".data", "skill-registry"));
  if (parts.length) return Array.from(new Set([...parts.map((p) => path.resolve(p)), registryRoot]));
  return [path.resolve(process.cwd(), "skills"), registryRoot];
}

function isWithinRoot(root: string, target: string) {
  const r = path.resolve(root).replaceAll("/", "\\").toLowerCase();
  const t = path.resolve(target).replaceAll("/", "\\").toLowerCase();
  const r2 = r.endsWith("\\") ? r : `${r}\\`;
  return t === r || t.startsWith(r2);
}

function resolveArtifactDir(artifactRef: string) {
  const trimmed = artifactRef.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) throw new Error("policy_violation:artifact_url_not_allowed");
  if (trimmed.startsWith("artifact:")) {
    const artifactId = trimmed.slice("artifact:".length).trim();
    if (!artifactId) throw new Error("policy_violation:artifact_ref_invalid");
    const reg = String(process.env.SKILL_REGISTRY_DIR ?? "").trim();
    const registryRoot = path.resolve(reg || path.resolve(process.cwd(), ".data", "skill-registry"));
    return path.resolve(registryRoot, artifactId);
  }
  if (trimmed.startsWith("file://")) return fileURLToPath(trimmed);
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(process.cwd(), trimmed);
}

async function loadManifest(artifactDir: string) {
  const p = path.join(artifactDir, "manifest.json");
  const raw = await fs.readFile(p, "utf8");
  const manifest = JSON.parse(raw);
  return { manifest, raw };
}

async function computeDepsDigest(params: { artifactDir: string; manifest: any }) {
  const manifestStable = stableStringify(params.manifest);
  const entryRel = String(params.manifest?.entry ?? "");
  const entryPath = entryRel ? path.resolve(params.artifactDir, entryRel) : "";
  const entryBytes = entryPath ? await fs.readFile(entryPath) : Buffer.from("");
  const h = crypto.createHash("sha256");
  h.update(Buffer.from(manifestStable, "utf8"));
  h.update(Buffer.from("\n", "utf8"));
  h.update(entryBytes);
  return `sha256:${h.digest("hex")}`;
}

function pickExecute(mod: any) {
  if (mod && typeof mod.execute === "function") return mod.execute as (req: any) => Promise<any>;
  if (mod && mod.default && typeof mod.default.execute === "function") return mod.default.execute as (req: any) => Promise<any>;
  if (mod && typeof mod.default === "function") return mod.default as (req: any) => Promise<any>;
  return null;
}

async function loadTrustedSkillKeys(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query(
    "SELECT key_id, public_key_pem FROM skill_trusted_keys WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC",
    [params.tenantId],
  );
  const out = new Map<string, crypto.KeyObject>();
  for (const row of res.rows as any[]) {
    const keyId = String(row.key_id ?? "").trim();
    const pem = String(row.public_key_pem ?? "").trim();
    if (!keyId || !pem) continue;
    try {
      out.set(keyId, crypto.createPublicKey(pem));
    } catch {}
  }
  return out;
}

function verifySkillManifestTrust(params: { toolName: string; depsDigest: string; manifest: any; unsafeBypass: boolean; trustedKeys: Map<string, crypto.KeyObject> }) {
  if (params.unsafeBypass) return;
  const enforceRaw = String(process.env.SKILL_TRUST_ENFORCE ?? "").trim().toLowerCase();
  const enforce = process.env.NODE_ENV === "production" && !(enforceRaw === "0" || enforceRaw === "false" || enforceRaw === "no");
  if (!enforce) return;

  const sig = params.manifest?.signature;
  const alg = String(sig?.alg ?? "").toLowerCase();
  const keyId = String(sig?.keyId ?? "");
  const sigBase64 = String(sig?.sigBase64 ?? "");
  const signedDigest = String(sig?.signedDigest ?? "");
  if (!alg || !keyId || !sigBase64 || !signedDigest) throw new Error("policy_violation:skill_untrusted:missing_signature");
  if (alg !== "ed25519") throw new Error("policy_violation:skill_untrusted:unsupported_alg");
  if (signedDigest !== params.depsDigest) throw new Error("policy_violation:skill_untrusted:signed_digest_mismatch");

  const pub = params.trustedKeys.get(keyId);
  if (!pub) throw new Error("policy_violation:skill_untrusted:unknown_key");

  const msg = `openslin:skill:${params.toolName}:${signedDigest}`;
  const ok = crypto.verify(null, Buffer.from(msg, "utf8"), pub, Buffer.from(sigBase64, "base64"));
  if (!ok) throw new Error("policy_violation:skill_untrusted:bad_signature");
}

async function resolveSandboxChildEntry() {
  const jsPath = path.resolve(__dirname, "..", "skillSandboxChild.js");
  try {
    const st = await fs.stat(jsPath);
    if (st.isFile()) return { entry: jsPath, execArgv: [] as string[] };
  } catch {}
  const tsPath = path.resolve(__dirname, "..", "skillSandboxChild.ts");
  return { entry: tsPath, execArgv: ["-r", "tsx/cjs"] as string[] };
}

async function executeDynamicSkillSandboxed(params: {
  toolRef: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  idempotencyKey: string | null;
  input: any;
  limits: RuntimeLimits;
  networkPolicy: NetworkPolicy;
  artifactRef: string;
  depsDigest: string;
  entryPath: string;
  signal: AbortSignal;
}): Promise<DynamicSkillExecResult> {
  const childInfo = await resolveSandboxChildEntry();
  const memArgv =
    typeof params.limits.memoryMb === "number" && Number.isFinite(params.limits.memoryMb) && params.limits.memoryMb > 0
      ? [`--max-old-space-size=${Math.max(32, Math.round(params.limits.memoryMb))}`]
      : [];
  const child = child_process.fork(childInfo.entry, [], {
    execArgv: [...childInfo.execArgv, ...memArgv],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });

  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  };
  if (params.signal.aborted) kill();
  params.signal.addEventListener("abort", kill, { once: true });

  const result = await new Promise<any>((resolve, reject) => {
    const onExit = (code: number | null) => {
      const c = typeof code === "number" ? code : null;
      if (c === 134 || c === 137) {
        reject(new Error("resource_exhausted:memory"));
        return;
      }
      reject(new Error(`skill_sandbox_exited:${code ?? "null"}`));
    };
    const onMessage = (m: any) => {
      if (!m || typeof m !== "object") return;
      if (m.type !== "result") return;
      child.off("exit", onExit);
      child.off("message", onMessage);
      resolve(m);
    };
    child.on("exit", onExit);
    child.on("message", onMessage);
    child.send({
      type: "execute",
      payload: {
        toolRef: params.toolRef,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        subjectId: params.subjectId,
        traceId: params.traceId,
        idempotencyKey: params.idempotencyKey,
        input: params.input,
        limits: params.limits,
        networkPolicy: params.networkPolicy,
        artifactRef: params.artifactRef,
        depsDigest: params.depsDigest,
        entryPath: params.entryPath,
      },
    });
  }).finally(() => {
    params.signal.removeEventListener("abort", kill);
    kill();
  });

  if (!result?.ok) {
    const msg = String(result?.error?.message ?? "skill_sandbox_error");
    throw new Error(msg);
  }
  return {
    output: result.output,
    egress: Array.isArray(result.egress) ? result.egress : [],
    depsDigest: String(result.depsDigest ?? params.depsDigest),
    runtimeBackend: "process",
    degraded: false,
  };
}

function getSkillRuntimeBackendPref(): "process" | "container" | "remote" | "auto" {
  const raw = String(process.env.SKILL_RUNTIME_BACKEND ?? "").trim().toLowerCase();
  if (raw === "container") return "container";
  if (raw === "remote") return "remote";
  if (raw === "auto") return "auto";
  if (raw === "process") return "process";
  return process.env.NODE_ENV === "production" ? "auto" : "process";
}

function getSkillRuntimeContainerImage() {
  const raw = String(process.env.SKILL_RUNTIME_CONTAINER_IMAGE ?? "").trim();
  return raw || "node:20-alpine";
}

function getSkillRuntimeContainerUser() {
  const raw = String(process.env.SKILL_RUNTIME_CONTAINER_USER ?? "").trim();
  return raw || "1000:1000";
}

function getSkillRuntimeRemoteEndpointOverride() {
  const raw = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
  return raw || null;
}

function masterKey() {
  const raw = String(process.env.API_MASTER_KEY ?? "").trim();
  if (!raw) throw new Error("policy_violation:missing_api_master_key");
  return raw;
}

async function loadRemoteRunnerConfig(params: { pool: Pool; tenantId: string }) {
  const endpointOverride = getSkillRuntimeRemoteEndpointOverride();
  if (endpointOverride) return { endpoint: endpointOverride, bearerToken: null };

  const res = await params.pool.query(
    "SELECT endpoint, auth_secret_id FROM skill_runtime_runners WHERE tenant_id = $1 AND enabled = true ORDER BY created_at DESC LIMIT 1",
    [params.tenantId],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  const endpoint = String(r.endpoint ?? "");
  const authSecretId = r.auth_secret_id ? String(r.auth_secret_id) : "";
  if (!endpoint) return null;

  if (!authSecretId) return { endpoint, bearerToken: null };

  const sr = await params.pool.query(
    `
      SELECT scope_type, scope_id, status, key_version, enc_format, encrypted_payload
      FROM secret_records
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [params.tenantId, authSecretId],
  );
  if (!sr.rowCount) throw new Error("policy_violation:remote_runner_secret_not_found");
  const row = sr.rows[0] as any;
  if (String(row.status) !== "active") throw new Error("policy_violation:remote_runner_secret_not_active");
  const decrypted = await decryptSecretPayload({
    pool: params.pool,
    tenantId: params.tenantId,
    masterKey: masterKey(),
    scopeType: String(row.scope_type),
    scopeId: String(row.scope_id),
    keyVersion: Number(row.key_version),
    encFormat: String(row.enc_format ?? "legacy.a256gcm"),
    encryptedPayload: row.encrypted_payload,
  });
  const obj = decrypted && typeof decrypted === "object" ? (decrypted as Record<string, unknown>) : {};
  const token = typeof obj.bearerToken === "string" ? obj.bearerToken : typeof obj.token === "string" ? obj.token : "";
  if (!token) throw new Error("policy_violation:remote_runner_secret_missing_token");
  return { endpoint, bearerToken: token };
}

function allowSkillRuntimeContainerFallback() {
  const raw = String(process.env.SKILL_RUNTIME_CONTAINER_FALLBACK ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return process.env.NODE_ENV !== "production";
}

function buildContainerRunnerScript() {
  const js = `
    function pickExecute(mod){
      if(mod&&typeof mod.execute==='function') return mod.execute;
      if(mod&&mod.default&&typeof mod.default.execute==='function') return mod.default.execute;
      if(mod&&typeof mod.default==='function') return mod.default;
      return null;
    }
    function isAllowed(net, url, method){
      let u;
      try { u = new URL(url); } catch { return { allowed:false, host:'', method, reason:'policy_violation:egress_invalid_url' }; }
      const host = String(u.hostname||'').toLowerCase();
      const protocol = String(u.protocol||'');
      if (protocol !== 'http:' && protocol !== 'https:') return { allowed:false, host, method:String(method||'GET').toUpperCase(), reason:'policy_violation:egress_invalid_protocol:'+protocol.replace(':','') };
      const pathName = String(u.pathname||'/') || '/';
      const m = String(method||'GET').toUpperCase();
      const allowedDomains = net && Array.isArray(net.allowedDomains) ? net.allowedDomains : [];
      const byDomain = allowedDomains.some(d=>String(d||'').toLowerCase()===host.toLowerCase());
      if (byDomain) return { allowed:true, host, method:m, reason:null, match:{ kind:'allowedDomain' } };
      const rules = net && Array.isArray(net.rules) ? net.rules : [];
      for (const r of rules) {
        if (!r || typeof r !== 'object') continue;
        const rh = String(r.host||'');
        if (!rh) continue;
        if (rh.toLowerCase() !== host.toLowerCase()) continue;
        const pp0 = r.pathPrefix ? String(r.pathPrefix) : '';
        const pp = pp0 ? (pp0.startsWith('/') ? pp0 : ('/' + pp0)) : '';
        if (pp && !pathName.startsWith(pp)) continue;
        const methods0 = Array.isArray(r.methods) ? r.methods.map(x=>String(x).trim().toUpperCase()).filter(Boolean) : null;
        if (methods0 && methods0.length && !methods0.includes(m)) continue;
        return { allowed:true, host, method:m, reason:null, match:{ kind:'rule', rulePathPrefix: pp || undefined, ruleMethods: methods0 || undefined } };
      }
      return { allowed:false, host, method:m, reason:'policy_violation:egress_denied:'+host };
    }
    let input='';
    process.stdin.on('data',c=>{ input+=c; });
    process.stdin.on('end', async ()=>{
      const payload = input ? JSON.parse(input) : {};
      const egress = [];
      const net = payload.networkPolicy || { allowedDomains: [] };
      const originalFetch = globalThis.fetch;
      if (typeof originalFetch !== 'function') throw new Error('skill_sandbox_missing_fetch');
      globalThis.fetch = async (input0, init0)=>{
        const maxEgressRequests = payload && payload.limits && typeof payload.limits.maxEgressRequests === 'number' && Number.isFinite(payload.limits.maxEgressRequests) ? Math.max(0, Math.round(payload.limits.maxEgressRequests)) : null;
        if (maxEgressRequests !== null && egress.length >= maxEgressRequests) throw new Error('resource_exhausted:max_egress_requests');
        const url = typeof input0 === 'string' ? input0 : input0 && input0.url ? String(input0.url) : '';
        const method = String((init0&&init0.method) || (input0&&input0.method) || 'GET').toUpperCase();
        const chk = isAllowed(net, url, method);
        if (!chk.allowed) {
          egress.push({ host: chk.host, method: chk.method, allowed:false, errorCategory:'policy_violation' });
          throw new Error(chk.reason || 'policy_violation:egress_denied');
        }
        const res = await originalFetch(input0, init0);
        egress.push({ host: chk.host, method: chk.method, allowed:true, policyMatch: chk.match, status: res && res.status });
        return res;
      };
      try {
        let mod;
        try { mod = require(payload.entryPath); } catch { mod = await import('file://' + payload.entryPath); }
        const exec = pickExecute(mod);
        if (!exec) throw new Error('policy_violation:skill_missing_execute');
        const output = await exec({
          toolRef: payload.toolRef,
          tenantId: payload.tenantId,
          spaceId: payload.spaceId,
          subjectId: payload.subjectId,
          traceId: payload.traceId,
          idempotencyKey: payload.idempotencyKey,
          input: payload.input,
          limits: payload.limits,
          networkPolicy: payload.networkPolicy,
          artifactRef: payload.artifactRef,
          depsDigest: payload.depsDigest,
        });
        process.stdout.write(JSON.stringify({ type:'result', ok:true, output, egress, depsDigest: payload.depsDigest }));
      } catch(e) {
        const msg = String(e && e.message ? e.message : e);
        process.stdout.write(JSON.stringify({ type:'result', ok:false, error:{ message: msg }, egress, depsDigest: payload.depsDigest }));
      }
    });
  `;
  return js.replace(/\\s+/g, " ").trim();
}

async function executeDynamicSkillContainered(params: {
  toolRef: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  idempotencyKey: string | null;
  input: any;
  limits: RuntimeLimits;
  networkPolicy: NetworkPolicy;
  artifactRef: string;
  depsDigest: string;
  entryPath: string;
  artifactDir: string;
  signal: AbortSignal;
}): Promise<DynamicSkillExecResult> {
  const image = getSkillRuntimeContainerImage();
  const dockerArgs: string[] = [
    "run",
    "--rm",
    "-i",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit",
    "256",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--user",
    getSkillRuntimeContainerUser(),
    "-v",
    `${params.artifactDir}:/skill:ro`,
    "-w",
    "/skill",
  ];
  if (typeof params.limits.memoryMb === "number" && Number.isFinite(params.limits.memoryMb) && params.limits.memoryMb > 0) {
    dockerArgs.push("--memory", `${Math.max(32, Math.round(params.limits.memoryMb))}m`);
  }
  if (typeof params.limits.cpuMs === "number" && Number.isFinite(params.limits.cpuMs) && params.limits.cpuMs > 0) {
    const cpus = Math.max(0.1, Math.min(8, params.limits.cpuMs / 1000));
    dockerArgs.push("--cpus", String(cpus));
  }
  dockerArgs.push(image, "node", "-e", buildContainerRunnerScript());

  const child = child_process.spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", "ignore"] });
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  };
  if (params.signal.aborted) kill();
  params.signal.addEventListener("abort", kill, { once: true });

  const payload = {
    toolRef: params.toolRef,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    traceId: params.traceId,
    idempotencyKey: params.idempotencyKey,
    input: params.input,
    limits: params.limits,
    networkPolicy: params.networkPolicy,
    artifactRef: params.artifactRef,
    depsDigest: params.depsDigest,
    entryPath: params.entryPath.replaceAll("\\\\", "/").replaceAll(params.artifactDir.replaceAll("\\\\", "/"), "/skill"),
  };
  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch {}

  let out = "";
  child.stdout.on("data", (c) => {
    out += String(c);
  });

  const code: number = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (c) => resolve(typeof c === "number" ? c : 1));
  }).finally(() => {
    params.signal.removeEventListener("abort", kill);
    kill();
  });

  if (code !== 0 && !out.trim()) throw new Error(`policy_violation:container_runtime_failed:${code}`);
  let parsed: any;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    throw new Error("policy_violation:container_runtime_bad_output");
  }
  if (!parsed?.ok) throw new Error(String(parsed?.error?.message ?? "skill_sandbox_error"));
  return {
    output: parsed.output,
    egress: Array.isArray(parsed.egress) ? parsed.egress : [],
    depsDigest: String(parsed.depsDigest ?? params.depsDigest),
    runtimeBackend: "container",
    degraded: false,
  };
}

async function executeDynamicSkillRemote(params: {
  endpoint: string;
  bearerToken: string | null;
  toolRef: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  idempotencyKey: string | null;
  input: any;
  limits: RuntimeLimits;
  networkPolicy: NetworkPolicy;
  artifactRef: string;
  depsDigest: string;
  signal: AbortSignal;
}): Promise<DynamicSkillExecResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (params.bearerToken) headers.authorization = `Bearer ${params.bearerToken}`;

  const payload = {
    toolRef: params.toolRef,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    traceId: params.traceId,
    idempotencyKey: params.idempotencyKey,
    input: params.input,
    limits: params.limits,
    networkPolicy: params.networkPolicy,
    artifactRef: params.artifactRef,
    depsDigest: params.depsDigest,
  };

  let res: Response;
  try {
    res = await fetch(params.endpoint, { method: "POST", headers, body: JSON.stringify(payload), signal: params.signal } as any);
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "remote_runtime_error");
    throw new Error(`policy_violation:remote_runtime_failed:${msg}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`policy_violation:remote_runtime_http_${res.status}`);
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("policy_violation:remote_runtime_bad_output");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("policy_violation:remote_runtime_bad_output");
  if (parsed.ok === false) throw new Error(String(parsed?.error?.message ?? "skill_sandbox_error"));

  return {
    output: parsed.output,
    egress: Array.isArray(parsed.egress) ? parsed.egress : [],
    depsDigest: String(parsed.depsDigest ?? params.depsDigest),
    runtimeBackend: "remote",
    degraded: false,
  };
}

export async function executeDynamicSkill(params: {
  pool: Pool;
  toolRef: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  idempotencyKey: string | null;
  input: any;
  limits: RuntimeLimits;
  networkPolicy: NetworkPolicy;
  artifactRef: string;
  depsDigest: string | null;
  egress: EgressEvent[];
  signal: AbortSignal;
}): Promise<{ output: any; depsDigest: string; runtimeBackend: DynamicSkillExecResult["runtimeBackend"]; degraded: boolean }> {
  const unsafeAllowedRaw = String(process.env.SKILL_RUNTIME_UNSAFE_ALLOW ?? "").trim().toLowerCase();
  const unsafeAllowed = unsafeAllowedRaw === "1" || unsafeAllowedRaw === "true" || unsafeAllowedRaw === "yes";

  const minIsolationRaw = String(process.env.SKILL_ISOLATION_MIN ?? "").trim().toLowerCase();
  const minIsolation: "process" | "container" | "remote" =
    minIsolationRaw === "remote" ? "remote" : minIsolationRaw === "container" ? "container" : "process";

  const roots = getSkillRoots();
  const artifactDir = resolveArtifactDir(params.artifactRef);
  if (!roots.some((r) => isWithinRoot(r, artifactDir))) throw new Error("policy_violation:artifact_outside_allowlist");

  const loaded = await loadManifest(artifactDir);
  const name = String(loaded.manifest?.identity?.name ?? "");
  if (!name || name !== parseToolRef(params.toolRef)?.name) throw new Error("policy_violation:manifest_name_mismatch");

  const computed = await computeDepsDigest({ artifactDir, manifest: loaded.manifest });
  if (params.depsDigest && params.depsDigest !== computed) throw new Error("policy_violation:deps_digest_mismatch");

  const trustedKeys = await loadTrustedSkillKeys({ pool: params.pool, tenantId: params.tenantId });
  verifySkillManifestTrust({ toolName: name, depsDigest: computed, manifest: loaded.manifest, unsafeBypass: unsafeAllowed, trustedKeys });

  const entryRel = String(loaded.manifest?.entry ?? "");
  if (!entryRel) throw new Error("policy_violation:manifest_missing_entry");
  const entryPath = path.resolve(artifactDir, entryRel);
  const entryText = await fs.readFile(entryPath, "utf8");
  const forbidden = ["node:child_process", "child_process", "node:net", "net", "node:tls", "tls", "node:dns", "dns", "node:http", "http", "node:https", "https", "node:dgram", "dgram"];
  for (const modName of forbidden) {
    const base = modName.startsWith("node:") ? modName.slice("node:".length) : modName;
    const hits =
      entryText.includes(`"${modName}"`) ||
      entryText.includes(`'${modName}'`) ||
      entryText.includes(`"${base}"`) ||
      entryText.includes(`'${base}'`) ||
      entryText.includes(`require("${modName}")`) ||
      entryText.includes(`require('${modName}')`) ||
      entryText.includes(`require("${base}")`) ||
      entryText.includes(`require('${base}')`) ||
      entryText.includes(`from "${modName}"`) ||
      entryText.includes(`from '${modName}'`) ||
      entryText.includes(`from "${base}"`) ||
      entryText.includes(`from '${base}'`);
    if (hits) throw new Error(`policy_violation:skill_forbidden_import:${base}`);
  }

  let res: DynamicSkillExecResult | null = null;
  const pref = getSkillRuntimeBackendPref();
  try {
    const allowFallback = allowSkillRuntimeContainerFallback();
    const wantRemote = pref === "remote" || pref === "auto";
    const wantContainer = pref === "container" || pref === "auto";
    let executed = false;

    if (wantRemote) {
      const remote = await loadRemoteRunnerConfig({ pool: params.pool, tenantId: params.tenantId });
      if (remote) {
        try {
          res = await executeDynamicSkillRemote({
            endpoint: remote.endpoint,
            bearerToken: remote.bearerToken,
            toolRef: params.toolRef,
            tenantId: params.tenantId,
            spaceId: params.spaceId,
            subjectId: params.subjectId,
            traceId: params.traceId,
            idempotencyKey: params.idempotencyKey,
            input: params.input,
            limits: params.limits,
            networkPolicy: params.networkPolicy,
            artifactRef: params.artifactRef,
            depsDigest: computed,
            signal: params.signal,
          });
          executed = true;
        } catch (e) {
          if (pref === "remote") throw e;
        }
      } else if (pref === "remote") {
        throw new Error("policy_violation:remote_runtime_not_configured");
      }
    }
    if (minIsolation === "remote" && !executed) {
      throw new Error("policy_violation:isolation_required");
    }

    if (!executed && wantContainer) {
      try {
        res = await executeDynamicSkillContainered({
          toolRef: params.toolRef,
          tenantId: params.tenantId,
          spaceId: params.spaceId,
          subjectId: params.subjectId,
          traceId: params.traceId,
          idempotencyKey: params.idempotencyKey,
          input: params.input,
          limits: params.limits,
          networkPolicy: params.networkPolicy,
          artifactRef: params.artifactRef,
          depsDigest: computed,
          entryPath,
          artifactDir,
          signal: params.signal,
        });
      } catch (e) {
        if (!allowFallback) throw e;
        if (minIsolation === "container") throw new Error("policy_violation:isolation_required");
        const tmp = await executeDynamicSkillSandboxed({
          toolRef: params.toolRef,
          tenantId: params.tenantId,
          spaceId: params.spaceId,
          subjectId: params.subjectId,
          traceId: params.traceId,
          idempotencyKey: params.idempotencyKey,
          input: params.input,
          limits: params.limits,
          networkPolicy: params.networkPolicy,
          artifactRef: params.artifactRef,
          depsDigest: computed,
          entryPath,
          signal: params.signal,
        });
        res = { ...tmp, runtimeBackend: "process", degraded: true };
      }
      executed = true;
    }

    if (!executed) {
      if (minIsolation === "container") throw new Error("policy_violation:isolation_required");
      res = await executeDynamicSkillSandboxed({
        toolRef: params.toolRef,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        subjectId: params.subjectId,
        traceId: params.traceId,
        idempotencyKey: params.idempotencyKey,
        input: params.input,
        limits: params.limits,
        networkPolicy: params.networkPolicy,
        artifactRef: params.artifactRef,
        depsDigest: computed,
        entryPath,
        signal: params.signal,
      });
    }
  } catch (e) {
    if (pref === "remote") throw e;
    if (process.env.NODE_ENV === "production") throw e;
    if (minIsolation !== "process") throw e;
    const localEgress: EgressEvent[] = [];
    const originalFetch = globalThis.fetch;
    const wrappedFetch = async (input: any, init?: any) => {
      const maxEgressRequests =
        typeof params.limits.maxEgressRequests === "number" && Number.isFinite(params.limits.maxEgressRequests)
          ? Math.max(0, Math.round(params.limits.maxEgressRequests))
          : null;
      if (maxEgressRequests !== null && localEgress.length >= maxEgressRequests) {
        throw new Error("resource_exhausted:max_egress_requests");
      }
      const url = typeof input === "string" ? input : input?.url ? String(input.url) : "";
      const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
      const chk = isAllowedEgress({ policy: params.networkPolicy, url, method });
      if (!chk.allowed) {
        localEgress.push({ host: chk.host, method: chk.method, allowed: false, errorCategory: "policy_violation" });
        throw new Error(chk.reason ?? "policy_violation:egress_denied");
      }
      const resp = await originalFetch(input as any, init as any);
      localEgress.push({ host: chk.host, method: chk.method, allowed: true, policyMatch: chk.match, status: (resp as any)?.status });
      return resp;
    };

    try {
      if (typeof originalFetch === "function") globalThis.fetch = wrappedFetch as any;
      const mod = await import(pathToFileURL(entryPath).href);
      const exec = pickExecute(mod);
      if (!exec) throw new Error("policy_violation:skill_missing_execute");
      const output = await exec({
        toolRef: params.toolRef,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        subjectId: params.subjectId,
        traceId: params.traceId,
        idempotencyKey: params.idempotencyKey,
        input: params.input,
        limits: params.limits,
        networkPolicy: params.networkPolicy,
        artifactRef: params.artifactRef,
        depsDigest: computed,
      });
      res = { output, egress: localEgress, depsDigest: computed, runtimeBackend: "local", degraded: true };
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  }
  if (!res) throw new Error("internal:dynamic_skill_no_result");
  for (const ev of res.egress) params.egress.push(ev);
  return { output: res.output, depsDigest: computed, runtimeBackend: res.runtimeBackend, degraded: res.degraded };
}
