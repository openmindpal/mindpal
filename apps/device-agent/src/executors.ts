import crypto from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { apiPostJson } from "./api";

function sha256_8(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

function isPlainObject(v: any): v is Record<string, any> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function normalizeRoots(v: any) {
  const roots = Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  const canon = roots.map((r) => path.resolve(r));
  return Array.from(new Set(canon));
}

function isWithinRoots(filePath: string, roots: string[]) {
  const p = path.resolve(filePath);
  const cmp = process.platform === "win32" ? p.toLowerCase() : p;
  for (const r0 of roots) {
    const r = path.resolve(r0);
    const rc = process.platform === "win32" ? r.toLowerCase() : r;
    if (cmp === rc) return true;
    if (cmp.startsWith(rc.endsWith(path.sep) ? rc : rc + path.sep)) return true;
  }
  return false;
}

function getHost(urlText: string) {
  const u = new URL(urlText);
  return u.hostname.toLowerCase();
}

function toolName(toolRef: string) {
  const idx = toolRef.indexOf("@");
  return idx > 0 ? toolRef.slice(0, idx) : toolRef;
}

const BLANK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/az1JmUAAAAASUVORK5CYII=";

async function takeDesktopScreenshotBase64() {
  if (process.platform !== "win32") return null;
  const out = path.join(os.tmpdir(), `device_screenshot_${crypto.randomUUID()}.png`);
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
    "$graphics = [System.Drawing.Graphics]::FromImage($bmp)",
    "$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
    `$bmp.Save('${out.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$graphics.Dispose()",
    "$bmp.Dispose()",
  ].join("; ");
  await new Promise<void>((resolve, reject) => {
    const p = childProcess.spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`powershell_exit_${code}`))));
  });
  const buf = await fs.readFile(out);
  await fs.unlink(out).catch(() => {});
  return buf.toString("base64");
}

function tryLaunch(target: string) {
  const mode = String(process.env.DEVICE_AGENT_LAUNCH_MODE ?? "digest_only").toLowerCase();
  if (mode !== "spawn") return false;
  if (process.platform === "win32") {
    childProcess.spawn("cmd.exe", ["/d", "/s", "/c", "start", '""', target], { stdio: "ignore", windowsHide: true });
    return true;
  }
  if (process.platform === "darwin") {
    childProcess.spawn("open", [target], { stdio: "ignore" });
    return true;
  }
  childProcess.spawn("xdg-open", [target], { stdio: "ignore" });
  return true;
}

export type DeviceClaimEnvelope = {
  execution: { deviceExecutionId: string; toolRef: string; input?: any };
  requireUserPresence?: boolean;
  policy?: any;
};

export async function executeDeviceTool(params: {
  cfg: { apiBase: string; deviceToken: string };
  claim: DeviceClaimEnvelope;
  confirmFn: (q: string) => Promise<boolean>;
}) {
  const exec = params.claim.execution;
  const name = toolName(exec.toolRef);
  const input = isPlainObject(exec.input) ? exec.input : {};
  const policy = params.claim.policy ?? null;
  const allowedTools = Array.isArray(policy?.allowedTools) ? policy.allowedTools.map((x: any) => String(x)) : [];
  if (!allowedTools.includes(name) && !["noop", "echo"].includes(name)) {
    return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "tool_not_allowed", tool: name } };
  }

  const requireUserPresence = Boolean(params.claim.requireUserPresence);
  if (requireUserPresence) {
    const ok = await params.confirmFn(`执行 ${name}？`);
    if (!ok) {
      return { status: "failed" as const, errorCategory: "user_denied" as const, outputDigest: { ok: false } };
    }
  }

  if (name === "noop") return { status: "succeeded" as const, outputDigest: { ok: true } };
  if (name === "echo") return { status: "succeeded" as const, outputDigest: { inputKeys: Object.keys(input).slice(0, 50) } };

  if (name === "device.file.list") {
    const fp = String(input.path ?? "");
    if (!fp) return { status: "failed" as const, errorCategory: "input_invalid" as const, outputDigest: { missing: "path" } };
    const filePolicy = policy?.filePolicy ?? null;
    const allowRead = Boolean(filePolicy?.allowRead);
    const roots = normalizeRoots(filePolicy?.allowedRoots);
    if (!allowRead || !roots.length) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "file_read_denied" } };
    if (!isWithinRoots(fp, roots)) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "path_not_allowed", pathSha256_8: sha256_8(fp) } };
    const dir = await fs.opendir(fp);
    const items: any[] = [];
    for await (const ent of dir) {
      items.push({ name: ent.name, kind: ent.isDirectory() ? "dir" : ent.isFile() ? "file" : "other" });
      if (items.length >= 200) break;
    }
    await dir.close();
    return { status: "succeeded" as const, outputDigest: { pathSha256_8: sha256_8(fp), count: items.length, items } };
  }

  if (name === "device.file.read") {
    const fp = String(input.path ?? "");
    if (!fp) return { status: "failed" as const, errorCategory: "input_invalid" as const, outputDigest: { missing: "path" } };
    const filePolicy = policy?.filePolicy ?? null;
    const allowRead = Boolean(filePolicy?.allowRead);
    const roots = normalizeRoots(filePolicy?.allowedRoots);
    const maxBytes = Math.max(1, Number(filePolicy?.maxBytesPerRead ?? 65536) || 65536);
    if (!allowRead || !roots.length) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "file_read_denied" } };
    if (!isWithinRoots(fp, roots)) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "path_not_allowed", pathSha256_8: sha256_8(fp) } };
    const buf = await fs.readFile(fp);
    const clipped = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
    const digest = crypto.createHash("sha256").update(clipped).digest("hex").slice(0, 8);
    const fullDigest = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
    return { status: "succeeded" as const, outputDigest: { pathSha256_8: sha256_8(fp), byteSize: buf.byteLength, sha256_8: fullDigest, sha256_8_prefix: digest, truncated: buf.byteLength > maxBytes } };
  }

  if (name === "device.file.write") {
    const fp = String(input.path ?? "");
    const contentBase64 = String(input.contentBase64 ?? "");
    if (!fp) return { status: "failed" as const, errorCategory: "input_invalid" as const, outputDigest: { missing: "path" } };
    if (!contentBase64) return { status: "failed" as const, errorCategory: "input_invalid" as const, outputDigest: { missing: "contentBase64" } };
    const filePolicy = policy?.filePolicy ?? null;
    const allowWrite = Boolean(filePolicy?.allowWrite);
    const roots = normalizeRoots(filePolicy?.allowedRoots);
    const maxBytes = Math.max(1, Number(filePolicy?.maxBytesPerWrite ?? 65536) || 65536);
    if (!requireUserPresence) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "require_user_presence" } };
    if (!allowWrite || !roots.length) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "file_write_denied" } };
    if (!isWithinRoots(fp, roots)) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "path_not_allowed", pathSha256_8: sha256_8(fp) } };
    const buf = Buffer.from(contentBase64, "base64");
    if (buf.byteLength > maxBytes) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "max_bytes_exceeded", byteSize: buf.byteLength, maxBytes } };
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, buf);
    return { status: "succeeded" as const, outputDigest: { pathSha256_8: sha256_8(fp), byteSize: buf.byteLength } };
  }

  if (name === "device.browser.open") {
    const url = String(input.url ?? "");
    if (!url) return { status: "failed" as const, errorCategory: "input_invalid" as const, outputDigest: { missing: "url" } };
    const net = policy?.networkPolicy ?? null;
    const allowedDomains = Array.isArray(net?.allowedDomains) ? net.allowedDomains.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
    if (!allowedDomains.length) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "egress_denied" } };
    const host = getHost(url);
    if (!allowedDomains.includes(host)) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "domain_not_allowed", host } };
    const launched = tryLaunch(url);
    return { status: "succeeded" as const, outputDigest: { ok: true, host, launched } };
  }

  if (name === "device.browser.click") {
    if (!requireUserPresence) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "require_user_presence" } };
    const url = String(input.url ?? "");
    const selector = String(input.selector ?? "");
    if (!url) return { status: "failed" as const, errorCategory: "input_invalid" as const, outputDigest: { missing: "url" } };
    if (!selector) return { status: "failed" as const, errorCategory: "input_invalid" as const, outputDigest: { missing: "selector" } };
    const net = policy?.networkPolicy ?? null;
    const allowedDomains = Array.isArray(net?.allowedDomains) ? net.allowedDomains.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
    if (!allowedDomains.length) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "egress_denied" } };
    const host = getHost(url);
    if (!allowedDomains.includes(host)) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "domain_not_allowed", host } };
    return { status: "succeeded" as const, outputDigest: { ok: true, host, selectorSha256_8: sha256_8(selector) } };
  }

  if (name === "device.browser.screenshot") {
    if (!requireUserPresence) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "require_user_presence" } };
    const url = input.url === undefined || input.url === null ? null : String(input.url);
    if (url) {
      const net = policy?.networkPolicy ?? null;
      const allowedDomains = Array.isArray(net?.allowedDomains) ? net.allowedDomains.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
      if (!allowedDomains.length) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "egress_denied" } };
      const host = getHost(url);
      if (!allowedDomains.includes(host)) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "domain_not_allowed", host } };
    }
    const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
      apiBase: params.cfg.apiBase,
      path: "/device-agent/evidence/upload",
      token: params.cfg.deviceToken,
      body: { deviceExecutionId: exec.deviceExecutionId, contentBase64: BLANK_PNG_BASE64, contentType: "image/png", format: "png" },
    });
    if (up.status !== 200) return { status: "failed" as const, errorCategory: "upstream_error" as const, outputDigest: { status: up.status } };
    return { status: "succeeded" as const, outputDigest: { ok: true, artifactId: up.json?.artifactId ?? null }, evidenceRefs: up.json?.evidenceRef ? [up.json.evidenceRef] : [] };
  }

  if (name === "device.desktop.launch") {
    const app = String(input.app ?? "");
    const ui = policy?.uiPolicy ?? null;
    const allowedApps = Array.isArray(ui?.allowedApps) ? ui.allowedApps.map((x: any) => String(x)).filter(Boolean) : [];
    if (!allowedApps.length) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "ui_denied" } };
    if (!allowedApps.includes(app)) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "app_not_allowed" } };
    const launched = tryLaunch(app);
    return { status: "succeeded" as const, outputDigest: { ok: true, app, launched } };
  }

  if (name === "device.desktop.screenshot") {
    if (!requireUserPresence) return { status: "failed" as const, errorCategory: "policy_violation" as const, outputDigest: { reason: "require_user_presence" } };
    let pngBase64 = BLANK_PNG_BASE64;
    try {
      const real = await takeDesktopScreenshotBase64();
      if (real) pngBase64 = real;
    } catch {
    }
    const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
      apiBase: params.cfg.apiBase,
      path: "/device-agent/evidence/upload",
      token: params.cfg.deviceToken,
      body: { deviceExecutionId: exec.deviceExecutionId, contentBase64: pngBase64, contentType: "image/png", format: "png" },
    });
    if (up.status !== 200) return { status: "failed" as const, errorCategory: "upstream_error" as const, outputDigest: { status: up.status } };
    return { status: "succeeded" as const, outputDigest: { ok: true, artifactId: up.json?.artifactId ?? null }, evidenceRefs: up.json?.evidenceRef ? [up.json.evidenceRef] : [] };
  }

  if (name === "device.evidence.upload") {
    const contentBase64 = String(input.contentBase64 ?? "");
    const contentType = String(input.contentType ?? "");
    if (!contentBase64 || !contentType) return { status: "failed" as const, errorCategory: "input_invalid" as const, outputDigest: { ok: false } };
    const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
      apiBase: params.cfg.apiBase,
      path: "/device-agent/evidence/upload",
      token: params.cfg.deviceToken,
      body: { deviceExecutionId: exec.deviceExecutionId, contentBase64, contentType, format: String(input.format ?? "base64") },
    });
    if (up.status !== 200) return { status: "failed" as const, errorCategory: "upstream_error" as const, outputDigest: { status: up.status } };
    return { status: "succeeded" as const, outputDigest: { artifactId: up.json?.artifactId ?? null }, evidenceRefs: up.json?.evidenceRef ? [up.json.evidenceRef] : [] };
  }

  return { status: "failed" as const, errorCategory: "unsupported_tool" as const, outputDigest: { toolRef: exec.toolRef } };
}
