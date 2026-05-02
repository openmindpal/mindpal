/**
 * 插件共享工具函数 — 从 desktopPlugin.ts 提取的纯工具代码。
 * 不依赖外部运行时状态，仅依赖 Node.js 内置模块。
 */
import { sha256_8 } from "@mindpal/shared";
import childProcess from "node:child_process";
import path from "node:path";

// ── 类型 ──────────────────────────────────────────────────────────

export type DesktopCaptureOptions = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  windowId?: string;
};

export type DesktopBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopWindowInfo = {
  id: string;
  title: string;
  appName: string;
  bounds: DesktopBounds | null;
};

export type DesktopBackendStatus = {
  platform: NodeJS.Platform;
  windowBackend: string | null;
  fileDialogBackend: string | null;
  screenshotBackend: string | null;
  missingCommands: string[];
  accessibilityRequired: boolean;
};

// ── 工具函数 ──────────────────────────────────────────────────────

export { sha256_8 };

export function normalizeRoots(v: any) {
  const roots = Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  const canon = roots.map((r) => path.resolve(r));
  return Array.from(new Set(canon));
}

export function isWithinRoots(filePath: string, roots: string[]) {
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

export function getHost(urlText: string) {
  const u = new URL(urlText);
  return u.hostname.toLowerCase();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function finiteNumberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

export async function runPowerShell(script: string, opts?: { sta?: boolean }): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
    if (opts?.sta) args.push("-Sta");
    args.push("-Command", script);
    const p = childProcess.spawn("powershell", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    p.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `powershell_exit_${code}`)));
  });
}

export async function runPowerShellJson<T>(script: string, opts?: { sta?: boolean }): Promise<T> {
  const stdout = await runPowerShell(script, opts);
  return JSON.parse(stdout || "null") as T;
}

export async function runProcess(command: string, args: string[], opts?: { stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const p = childProcess.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    p.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts?.stdin !== undefined) {
      p.stdin.write(opts.stdin);
    }
    p.stdin.end();
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    const result = await runProcess(checker, [command]);
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function runOsaScript(script: string, language: "JavaScript" | "AppleScript" = "JavaScript"): Promise<string> {
  const args = language === "JavaScript" ? ["-l", "JavaScript", "-e", script] : ["-e", script];
  const result = await runProcess("osascript", args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `osascript_exit_${result.code}`);
  return result.stdout.trim();
}

export function normalizeBounds(value: any): DesktopBounds | null {
  if (!value || typeof value !== "object") return null;
  const x = Number((value as any).x);
  const y = Number((value as any).y);
  const width = Number((value as any).width);
  const height = Number((value as any).height);
  if ([x, y, width, height].some((item) => !Number.isFinite(item))) return null;
  return { x, y, width, height };
}
