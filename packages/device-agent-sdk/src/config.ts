import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

export type DeviceType = "desktop" | "mobile" | "iot" | "robot" | "vehicle" | "home" | "gateway";

/**
 * 插件配置（元数据驱动：由配对时写入 + 云端策略下发 + 心跳同步更新）
 * 替代原有 DEVICE_AGENT_BUILTIN_PLUGINS 环境变量的静态控制
 */
export type PluginConfig = {
  /** 内置插件列表，如 ["desktop"] 或 ["file","browser",...] */
  builtinPlugins: string[];
  /** 外部插件目录列表（可选） */
  pluginDirs?: string[];
  /** 本地 Skill 目录列表（可选） */
  skillDirs?: string[];
  /** 插件配置最后更新时间 */
  updatedAt?: string;
  /** 配置来源：local=本地默认 | cloud=云端策略下发 */
  source?: "local" | "cloud";
};

export type DeviceAgentConfig = {
  apiBase: string;
  deviceId: string;
  deviceToken: string;
  enrolledAt: string;
  deviceType: DeviceType;
  os: string;
  agentVersion: string;
  /** 插件配置（元数据驱动，替代环境变量） */
  pluginConfig?: PluginConfig;
};

export function defaultConfigPath() {
  return path.join(os.homedir(), ".openslin", "device-agent.json");
}

export function defaultLockPath() {
  return path.join(os.homedir(), ".openslin", "device-agent.lock");
}

// 锁文件结构：包含 PID 和心跳时间戳
export type LockInfo = {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  hostname: string;
};

// 锁文件过期时间（毫秒）—— 如果心跳超过这个时间没更新，认为进程已死
const LOCK_STALE_MS = 90_000; // 90秒

// 心跳更新间隔
const LOCK_HEARTBEAT_INTERVAL_MS = 30_000; // 30秒

let lockHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** 读取锁文件信息 */
async function readLockInfo(): Promise<LockInfo | null> {
  const lockPath = defaultLockPath();
  try {
    const content = await fs.readFile(lockPath, "utf8");
    const info = JSON.parse(content);
    if (typeof info.pid === "number") {
      return info as LockInfo;
    }
    // 兼容旧格式（纯 PID 数字）
    const pid = parseInt(content.trim(), 10);
    if (Number.isFinite(pid)) {
      return { pid, startedAt: "", heartbeatAt: "", hostname: "" };
    }
    return null;
  } catch {
    return null;
  }
}

/** 写入锁文件信息 */
async function writeLockInfo(info: LockInfo): Promise<void> {
  const lockPath = defaultLockPath();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(info), "utf8");
}

/** 检查进程是否存活 */
function isProcessAlive(pid: number): boolean {
  try {
    // 发送信号 0 可以检查进程是否存在而不影响它
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 强制终止进程（跨平台） */
async function forceKillProcess(pid: number): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      // Windows 使用 taskkill
      await new Promise<void>((resolve, reject) => {
        const p = childProcess.spawn("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
        p.on("error", reject);
        p.on("exit", () => resolve());
      });
    } else {
      // Unix 系统使用 SIGKILL
      process.kill(pid, "SIGKILL");
    }
    return true;
  } catch {
    return false;
  }
}

/** 检查并清理已有实例，返回是否有旧实例被清理 */
export async function killExistingInstance(): Promise<boolean> {
  const lockInfo = await readLockInfo();
  if (!lockInfo) return false;

  const { pid, heartbeatAt } = lockInfo;

  // 如果是当前进程，不需要清理
  if (pid === process.pid) return false;

  // 检查进程是否存活
  const alive = isProcessAlive(pid);
  if (!alive) {
    // 进程已死，清理过期锁文件
    await fs.unlink(defaultLockPath()).catch(() => {});
    return false;
  }

  // 检查心跳是否过期
  const heartbeatTime = heartbeatAt ? new Date(heartbeatAt).getTime() : 0;
  const isStale = Date.now() - heartbeatTime > LOCK_STALE_MS;

  if (isStale) {
    // 心跳过期，强制终止旧进程
    console.log(`[config] 发现过期实例（PID=${pid}，心跳过期），强制终止...`);
    await forceKillProcess(pid);
    await new Promise((r) => setTimeout(r, 500));
    await fs.unlink(defaultLockPath()).catch(() => {});
    return true;
  }

  // 进程存活且心跳正常，发送 SIGTERM 优雅终止
  console.log(`[config] 发现活跃实例（PID=${pid}），请求终止...`);
  try {
    process.kill(pid, "SIGTERM");
    // 等待旧进程退出
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (!isProcessAlive(pid)) {
        await fs.unlink(defaultLockPath()).catch(() => {});
        return true;
      }
    }
    // 优雅终止失败，强制终止
    console.log(`[config] 优雅终止超时，强制终止 PID=${pid}...`);
    await forceKillProcess(pid);
    await new Promise((r) => setTimeout(r, 500));
    await fs.unlink(defaultLockPath()).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** 创建锁文件并启动心跳 */
export async function acquireLock(): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    await writeLockInfo({
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
      hostname: os.hostname(),
    });

    // 启动心跳定时器
    if (lockHeartbeatTimer) {
      clearInterval(lockHeartbeatTimer);
    }
    lockHeartbeatTimer = setInterval(async () => {
      const info = await readLockInfo();
      if (info && info.pid === process.pid) {
        info.heartbeatAt = new Date().toISOString();
        await writeLockInfo(info).catch(() => {});
      }
    }, LOCK_HEARTBEAT_INTERVAL_MS);

    return true;
  } catch {
    return false;
  }
}

/** 释放锁文件并停止心跳 */
export async function releaseLock(): Promise<void> {
  // 停止心跳
  if (lockHeartbeatTimer) {
    clearInterval(lockHeartbeatTimer);
    lockHeartbeatTimer = null;
  }

  const lockPath = defaultLockPath();
  try {
    const info = await readLockInfo();
    // 只删除自己创建的锁
    if (info && info.pid === process.pid) {
      await fs.unlink(lockPath);
    }
  } catch {
    // 忽略
  }
}

/** 检查是否已有其他实例在运行（不终止它） */
export async function isAnotherInstanceRunning(): Promise<boolean> {
  const lockInfo = await readLockInfo();
  if (!lockInfo) return false;

  const { pid, heartbeatAt } = lockInfo;
  if (pid === process.pid) return false;

  // 检查进程是否存活
  if (!isProcessAlive(pid)) return false;

  // 检查心跳是否过期
  const heartbeatTime = heartbeatAt ? new Date(heartbeatAt).getTime() : 0;
  if (Date.now() - heartbeatTime > LOCK_STALE_MS) return false;

  return true;
}

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
