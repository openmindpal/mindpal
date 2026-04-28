/**
 * Device-OS 内核模块 #1：设备身份与配对
 *
 * 统一管理设备生命周期：
 * - enrollment（首次注册）
 * - pairing（配对）
 * - revoke（吊销）
 * - rotation（Token 刷新）
 * - re-enroll（重新注册）
 *
 * @layer kernel
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import type { DeviceAgentConfig, DeviceType } from "./types";
// [SDK迁移] 原 `from "../log"` → 改为内核本地 log 模块
import { safeLog, safeError } from "./log";

// ── 配置路径 ─────────────────────────────────────────────────

export function defaultConfigPath() {
  return path.join(os.homedir(), ".openslin", "device-agent.json");
}

export function defaultLockPath() {
  return path.join(os.homedir(), ".openslin", "device-agent.lock");
}

// ── 配置读写 ─────────────────────────────────────────────────

export async function loadConfigFile(p: string): Promise<DeviceAgentConfig | null> {
  try {
    const txt = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as DeviceAgentConfig;
  } catch {
    return null;
  }
}

export async function saveConfigFile(p: string, cfg: DeviceAgentConfig) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2), "utf8");
}

// ── 锁文件管理 ──────────────────────────────────────────────

export type LockInfo = {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  hostname: string;
};

const LOCK_STALE_MS = 90_000;
const LOCK_HEARTBEAT_INTERVAL_MS = 30_000;
let lockHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function readLockInfo(): Promise<LockInfo | null> {
  const lockPath = defaultLockPath();
  try {
    const content = await fs.readFile(lockPath, "utf8");
    const info = JSON.parse(content);
    if (typeof info.pid === "number") return info as LockInfo;
    const pid = parseInt(content.trim(), 10);
    if (Number.isFinite(pid)) return { pid, startedAt: "", heartbeatAt: "", hostname: "" };
    return null;
  } catch {
    return null;
  }
}

async function writeLockInfo(info: LockInfo): Promise<void> {
  const lockPath = defaultLockPath();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(info), "utf8");
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function forceKillProcess(pid: number): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const p = childProcess.spawn("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
        p.on("error", reject);
        p.on("exit", () => resolve());
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
    return true;
  } catch {
    return false;
  }
}

export async function killExistingInstance(): Promise<boolean> {
  const lockInfo = await readLockInfo();
  if (!lockInfo) return false;
  const { pid, heartbeatAt } = lockInfo;
  if (pid === process.pid) return false;
  const alive = isProcessAlive(pid);
  if (!alive) { await fs.unlink(defaultLockPath()).catch(() => {}); return false; }
  const heartbeatTime = heartbeatAt ? new Date(heartbeatAt).getTime() : 0;
  const isStale = Date.now() - heartbeatTime > LOCK_STALE_MS;
  if (isStale) {
    safeLog(`[identity] 发现过期实例（PID=${pid}），强制终止...`);
    await forceKillProcess(pid);
    await new Promise((r) => setTimeout(r, 500));
    await fs.unlink(defaultLockPath()).catch(() => {});
    return true;
  }
  safeLog(`[identity] 发现活跃实例（PID=${pid}），请求终止...`);
  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (!isProcessAlive(pid)) { await fs.unlink(defaultLockPath()).catch(() => {}); return true; }
    }
    await forceKillProcess(pid);
    await new Promise((r) => setTimeout(r, 500));
    await fs.unlink(defaultLockPath()).catch(() => {});
    return true;
  } catch { return false; }
}

export async function acquireLock(): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    await writeLockInfo({ pid: process.pid, startedAt: now, heartbeatAt: now, hostname: os.hostname() });
    if (lockHeartbeatTimer) clearInterval(lockHeartbeatTimer);
    lockHeartbeatTimer = setInterval(async () => {
      const info = await readLockInfo();
      if (info && info.pid === process.pid) { info.heartbeatAt = new Date().toISOString(); await writeLockInfo(info).catch(() => {}); }
    }, LOCK_HEARTBEAT_INTERVAL_MS);
    return true;
  } catch { return false; }
}

export async function releaseLock(): Promise<void> {
  if (lockHeartbeatTimer) { clearInterval(lockHeartbeatTimer); lockHeartbeatTimer = null; }
  try {
    const info = await readLockInfo();
    if (info && info.pid === process.pid) await fs.unlink(defaultLockPath());
  } catch {}
}

export async function isAnotherInstanceRunning(): Promise<boolean> {
  const lockInfo = await readLockInfo();
  if (!lockInfo) return false;
  const { pid, heartbeatAt } = lockInfo;
  if (pid === process.pid) return false;
  if (!isProcessAlive(pid)) return false;
  const heartbeatTime = heartbeatAt ? new Date(heartbeatAt).getTime() : 0;
  if (Date.now() - heartbeatTime > LOCK_STALE_MS) return false;
  return true;
}

// ── 设备身份生命周期 ─────────────────────────────────────────

export type EnrollmentState = "unenrolled" | "pairing" | "paired" | "revoked";

/**
 * DeviceIdentity — 设备身份管理器
 *
 * 统一 enrollment → pair → revoke → rotation → re-enroll 五个生命周期。
 */
export class DeviceIdentity {
  private _state: EnrollmentState = "unenrolled";
  private _config: DeviceAgentConfig | null = null;
  private _configPath: string;

  constructor(configPath?: string) {
    this._configPath = configPath ?? defaultConfigPath();
  }

  get state(): EnrollmentState { return this._state; }
  get config(): DeviceAgentConfig | null { return this._config; }
  get deviceId(): string | null { return this._config?.deviceId ?? null; }
  get deviceToken(): string | null { return this._config?.deviceToken ?? null; }

  /** 从磁盘加载已有身份 */
  async load(): Promise<boolean> {
    const cfg = await loadConfigFile(this._configPath);
    if (cfg && cfg.deviceId && cfg.deviceToken) {
      this._config = cfg;
      this._state = "paired";
      return true;
    }
    this._state = "unenrolled";
    return false;
  }

  /** enrollment + pair：使用配对码完成注册 */
  async pair(params: {
    pairingCode: string;
    apiBase: string;
    deviceType: DeviceType;
    os: string;
    agentVersion: string;
    apiPostFn: (p: { apiBase: string; path: string; body: any }) => Promise<{ status: number; json: any }>;
  }): Promise<{ success: boolean; error?: string }> {
    this._state = "pairing";
    try {
      const r = await params.apiPostFn({
        apiBase: params.apiBase,
        path: "/device-agent/pair",
        body: {
          pairingCode: params.pairingCode,
          deviceType: params.deviceType,
          os: params.os,
          agentVersion: params.agentVersion,
        },
      });
      if (r.status !== 200) { this._state = "unenrolled"; return { success: false, error: `pair_failed_${r.status}` }; }
      const deviceId = String(r.json?.deviceId ?? "");
      const deviceToken = String(r.json?.deviceToken ?? "");
      if (!deviceId || !deviceToken) { this._state = "unenrolled"; return { success: false, error: "pair_invalid_response" }; }
      const config: DeviceAgentConfig = {
        apiBase: params.apiBase,
        deviceId,
        deviceToken,
        enrolledAt: new Date().toISOString(),
        deviceType: params.deviceType,
        os: params.os,
        agentVersion: params.agentVersion,
      };
      this._config = config;
      await saveConfigFile(this._configPath, config);
      this._state = "paired";
      return { success: true };
    } catch (e: any) {
      this._state = "unenrolled";
      return { success: false, error: e?.message ?? "unknown" };
    }
  }

  /** 吊销设备身份 */
  async revoke(params?: {
    apiPostFn?: (p: { apiBase: string; path: string; token: string; body: any }) => Promise<{ status: number; json: any }>;
  }): Promise<void> {
    if (this._config && params?.apiPostFn) {
      try {
        await params.apiPostFn({
          apiBase: this._config.apiBase,
          path: "/device-agent/revoke",
          token: this._config.deviceToken,
          body: { deviceId: this._config.deviceId },
        });
      } catch { /* best effort */ }
    }
    this._state = "revoked";
    this._config = null;
    try { await fs.unlink(this._configPath); } catch {}
  }

  /** Token 轮换 */
  async rotateToken(params: {
    apiPostFn: (p: { apiBase: string; path: string; token: string; body: any }) => Promise<{ status: number; json: any }>;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this._config) return { success: false, error: "not_paired" };
    try {
      const r = await params.apiPostFn({
        apiBase: this._config.apiBase,
        path: "/device-agent/token/rotate",
        token: this._config.deviceToken,
        body: { deviceId: this._config.deviceId },
      });
      if (r.status !== 200) return { success: false, error: `rotate_failed_${r.status}` };
      const newToken = String(r.json?.deviceToken ?? "");
      if (!newToken) return { success: false, error: "rotate_invalid_response" };
      this._config = { ...this._config, deviceToken: newToken };
      await saveConfigFile(this._configPath, this._config);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message ?? "unknown" };
    }
  }

  /** 重新注册（revoke + re-pair） */
  async reEnroll(params: Parameters<DeviceIdentity["pair"]>[0]): Promise<{ success: boolean; error?: string }> {
    await this.revoke();
    return this.pair(params);
  }
}
