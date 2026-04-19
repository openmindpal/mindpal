import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EgressEvent, NetworkPolicy } from "./runtime";
import { stableStringify } from "./common";
import { getProcessPool } from "./skillProcessPool";

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
  const sep = path.sep;
  const r = path.resolve(root).toLowerCase();
  const t = path.resolve(target).toLowerCase();
  const r2 = r.endsWith(sep) ? r : `${r}${sep}`;
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

/* ── 依赖摘要缓存（附 mtime 校验） ─────────────────────────── */
interface DigestCacheEntry {
  digest: string;
  manifestMtimeMs: number;
  entryMtimeMs: number;
}
const _digestCache = new Map<string, DigestCacheEntry>();

async function computeDepsDigest(params: { artifactDir: string; manifest: any }) {
  const manifestStable = stableStringify(params.manifest);
  const entryRel = String(params.manifest?.entry ?? "");
  const entryPath = entryRel ? path.resolve(params.artifactDir, entryRel) : "";
  const manifestPath = path.join(params.artifactDir, "manifest.json");

  // mtime 校验
  const [manifestStat, entryStat] = await Promise.all([
    fs.stat(manifestPath).catch(() => null),
    entryPath ? fs.stat(entryPath).catch(() => null) : Promise.resolve(null),
  ]);
  const manifestMtimeMs = manifestStat?.mtimeMs ?? 0;
  const entryMtimeMs = entryStat?.mtimeMs ?? 0;
  const cacheKey = params.artifactDir;
  const cached = _digestCache.get(cacheKey);
  if (
    cached &&
    cached.manifestMtimeMs === manifestMtimeMs &&
    cached.entryMtimeMs === entryMtimeMs
  ) {
    return cached.digest;
  }

  const entryBytes = entryPath ? await fs.readFile(entryPath) : Buffer.from("");
  const h = crypto.createHash("sha256");
  h.update(Buffer.from(manifestStable, "utf8"));
  h.update(Buffer.from("\n", "utf8"));
  h.update(entryBytes);
  const digest = `sha256:${h.digest("hex")}`;

  _digestCache.set(cacheKey, { digest, manifestMtimeMs, entryMtimeMs });
  return digest;
}


export async function executeSkillInSandbox(params: {
  toolRef: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  idempotencyKey: string | null;
  input: any;
  limits: any;
  networkPolicy: NetworkPolicy;
  artifactRef: string;
  expectedDepsDigest: string | null;
  signal: AbortSignal;
}): Promise<{ output: any; egress: EgressEvent[]; depsDigest: string }> {
  const artifactDir = resolveArtifactDir(params.artifactRef);
  const roots = getSkillRoots();
  if (!roots.some((r) => isWithinRoot(r, artifactDir))) throw new Error("policy_violation:artifact_outside_roots");
  const loaded = await loadManifest(artifactDir);
  const depsDigest = await computeDepsDigest({ artifactDir, manifest: loaded.manifest });
  if (params.expectedDepsDigest && depsDigest !== params.expectedDepsDigest) throw new Error("policy_violation:deps_digest_mismatch");
  const entryRel = String(loaded.manifest?.entry ?? "");
  if (!entryRel) throw new Error("policy_violation:skill_manifest_missing_entry");
  const entryPath = path.resolve(artifactDir, entryRel);
  if (!isWithinRoot(artifactDir, entryPath)) throw new Error("policy_violation:skill_entry_outside_artifact");

  // 从进程池获取子进程（冷启动时自动 fork）
  const pool = getProcessPool();
  const { child, _poolEntry } = await pool.acquire(params.limits);

  let executionFailed = false;
  const kill = () => {
    pool.discard(child);
  };
  if (params.signal.aborted) kill();
  params.signal.addEventListener("abort", kill, { once: true });

  const cpuTimeLimitMs =
    typeof params.limits?.cpuTimeLimitMs === "number" && Number.isFinite(params.limits.cpuTimeLimitMs) && params.limits.cpuTimeLimitMs > 0
      ? Math.max(1, Math.floor(params.limits.cpuTimeLimitMs))
      : null;

  const result = await new Promise<any>((resolve, reject) => {
    const onExit = (code: number | null) => {
      executionFailed = true;
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
        cpuTimeLimitMs,
        networkPolicy: params.networkPolicy,
        artifactRef: params.artifactRef,
        depsDigest,
        entryPath,
      },
    });
  }).finally(() => {
    params.signal.removeEventListener("abort", kill);
  });

  // 执行成功：归还进程到池；失败：kill 进程
  if (!result?.ok || executionFailed) {
    pool.discard(child);
  } else {
    pool.release(child, _poolEntry);
  }

  if (!result?.ok) {
    const msg = String(result?.error?.message ?? "skill_sandbox_error");
    const e: any = new Error(msg);
    e.egress = Array.isArray(result.egress) ? result.egress : [];
    throw e;
  }
  return { output: result.output, egress: Array.isArray(result.egress) ? result.egress : [], depsDigest: String(result.depsDigest ?? depsDigest) };
}
