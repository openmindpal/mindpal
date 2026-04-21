/**
 * skillProcessPool.ts — Skill 沙箱子进程预热池
 *
 * 维护一组预先 fork 的 skillSandboxChild 进程，避免每次 Skill 调用都
 * 经历 fork + 初始化的冷启动开销。空闲进程在执行完毕后回归池中复用，
 * 超过 maxIdleMs 或 maxUses 后自动回收并替换。
 */
import child_process, { type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";

/* ── 配置 ──────────────────────────────────────────────────── */
const DEFAULT_POOL_SIZE = 3;
const DEFAULT_MAX_IDLE_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_MAX_USES = 50;
const HEARTBEAT_INTERVAL_MS = 30_000;       // 心跳发送间隔 30 秒
const HEARTBEAT_MAX_MISSES = 3;             // 连续 3 次无响应判定卡死
const ZOMBIE_SCAN_INTERVAL_MS = 60_000;     // 僵尸进程扫描周期 60 秒

interface PoolEntry {
  child: ChildProcess;
  uses: number;
  createdAt: number;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** 活跃进程心跳追踪状态 */
interface ActiveEntry {
  child: ChildProcess;
  missedHeartbeats: number;
  heartbeatTimer: ReturnType<typeof setInterval>;
  onFailure: (() => void) | null;
}

interface PoolOptions {
  poolSize?: number;
  maxIdleMs?: number;
  maxUses?: number;
}

/* ── 解析沙箱子进程入口（与 executeSkill.ts 同逻辑） ────────── */
let _childEntryCache: { entry: string; execArgv: string[] } | null = null;

async function resolveSandboxChildEntry(): Promise<{ entry: string; execArgv: string[] }> {
  if (_childEntryCache) return _childEntryCache;
  const jsPath = path.resolve(__dirname, "skillSandboxChild.js");
  try {
    const st = await fs.stat(jsPath);
    if (st.isFile()) {
      _childEntryCache = { entry: jsPath, execArgv: [] };
      return _childEntryCache;
    }
  } catch {}
  const tsPath = path.resolve(__dirname, "skillSandboxChild.ts");
  _childEntryCache = { entry: tsPath, execArgv: ["-r", "tsx/cjs"] };
  return _childEntryCache;
}

/* ── SkillProcessPool ──────────────────────────────────────── */
export class SkillProcessPool {
  private readonly poolSize: number;
  private readonly maxIdleMs: number;
  private readonly maxUses: number;
  private readonly idle: PoolEntry[] = [];
  private readonly active = new Map<number, ActiveEntry>(); // pid → 心跳状态
  private zombieScanTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(opts?: PoolOptions) {
    this.poolSize = opts?.poolSize ?? DEFAULT_POOL_SIZE;
    this.maxIdleMs = opts?.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
    this.maxUses = opts?.maxUses ?? DEFAULT_MAX_USES;
  }

  /** 启动时预热进程池 + 启动僵尸进程扫描定时器 */
  async warmup(): Promise<void> {
    const count = Math.max(0, this.poolSize - this.idle.length);
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      tasks.push(this.spawnToIdle());
    }
    await Promise.all(tasks);
    this.startZombieScan();
    console.log(`[skillProcessPool] warmed up ${count} process(es), pool size=${this.idle.length}`);
  }

  /**
   * 从池中获取一个可用子进程。
   * @param limits 可选，用于设置 --max-old-space-size（仅在池为空、需新建进程时生效）
   */
  async acquire(limits?: { memoryMb?: number }): Promise<{ child: ChildProcess; _poolEntry: PoolEntry | null }> {
    if (this.shuttingDown) throw new Error("skill_process_pool_shutdown");

    // 尝试从空闲池取一个
    while (this.idle.length > 0) {
      const entry = this.idle.pop()!;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = null;

      // 检查进程是否仍然活跃
      if (!entry.child.connected || entry.child.killed) {
        continue; // 跳过已死进程
      }
      return { child: entry.child, _poolEntry: entry };
    }

    // 池空，fork 新进程（支持 memory 限制）
    const childInfo = await resolveSandboxChildEntry();
    const memArgv =
      typeof limits?.memoryMb === "number" && Number.isFinite(limits.memoryMb) && limits.memoryMb > 0
        ? [`--max-old-space-size=${Math.max(32, Math.round(limits.memoryMb))}`]
        : [];
    const child = child_process.fork(childInfo.entry, [], {
      execArgv: [...childInfo.execArgv, ...memArgv],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    return { child, _poolEntry: null };
  }

  /**
   * 为已获取的进程启动心跳监控。
   * @param onStuck 进程卡死时的回调（触发任务失败）
   */
  startHeartbeat(child: ChildProcess, onStuck?: () => void): void {
    const pid = child.pid;
    if (pid == null) return;

    const ackHandler = (m: any) => {
      if (m?.type === "heartbeat_ack") {
        const entry = this.active.get(pid);
        if (entry) entry.missedHeartbeats = 0;
      }
    };
    child.on("message", ackHandler);

    const timer = setInterval(() => {
      const entry = this.active.get(pid);
      if (!entry) return;
      // 发送心跳
      try {
        if (entry.child.connected) {
          entry.child.send({ type: "heartbeat" });
        }
      } catch {}
      entry.missedHeartbeats += 1;
      if (entry.missedHeartbeats >= HEARTBEAT_MAX_MISSES) {
        console.warn(`[skillProcessPool] heartbeat timeout: pid=${pid}, missed=${entry.missedHeartbeats}, force killing`);
        this.stopHeartbeat(pid);
        this.killChild(entry.child);
        entry.onFailure?.();
      }
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();

    this.active.set(pid, {
      child,
      missedHeartbeats: 0,
      heartbeatTimer: timer,
      onFailure: onStuck ?? null,
    });
  }

  /** 停止指定进程的心跳监控（正常退出/归还时调用） */
  stopHeartbeat(pid: number): void {
    const entry = this.active.get(pid);
    if (!entry) return;
    clearInterval(entry.heartbeatTimer);
    this.active.delete(pid);
  }

  /**
   * 归还进程到池中（执行完毕后调用）。
   * 如果进程已超 maxUses 或池已满，则直接 kill。
   */
  release(child: ChildProcess, poolEntry: PoolEntry | null): void {
    if (this.shuttingDown) {
      this.killChild(child);
      return;
    }

    if (poolEntry) {
      poolEntry.uses += 1;
      poolEntry.lastUsedAt = Date.now();

      if (poolEntry.uses >= this.maxUses || !child.connected || child.killed) {
        this.killChild(child);
        // 异步补充一个新进程
        this.spawnToIdle().catch(() => {});
        return;
      }
      if (this.idle.length >= this.poolSize) {
        this.killChild(child);
        return;
      }
      // 设置空闲超时
      poolEntry.idleTimer = setTimeout(() => {
        this.evictEntry(poolEntry);
      }, this.maxIdleMs);
      poolEntry.idleTimer.unref?.();
      this.idle.push(poolEntry);
    } else {
      // 新 fork 的进程也可以回收
      if (this.idle.length >= this.poolSize || !child.connected || child.killed) {
        this.killChild(child);
        return;
      }
      const entry: PoolEntry = {
        child,
        uses: 1,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        idleTimer: null,
      };
      entry.idleTimer = setTimeout(() => {
        this.evictEntry(entry);
      }, this.maxIdleMs);
      entry.idleTimer.unref?.();
      this.idle.push(entry);
    }
  }

  /** 杀死进程（出错时直接调用，不归还到池） */
  discard(child: ChildProcess): void {
    this.killChild(child);
  }

  /** 优雅关闭：先停定时器，再清理所有进程 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // 停止僵尸扫描
    if (this.zombieScanTimer) {
      clearInterval(this.zombieScanTimer);
      this.zombieScanTimer = null;
    }

    // 停止所有活跃进程心跳并 kill
    for (const [pid, entry] of this.active) {
      clearInterval(entry.heartbeatTimer);
      this.killChild(entry.child);
    }
    this.active.clear();

    // 清理空闲池
    for (const entry of this.idle) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this.killChild(entry.child);
    }
    this.idle.length = 0;
    console.log("[skillProcessPool] shutdown complete");
  }

  /* ── 内部方法 ─────────────────────────────────────────────── */

  private async spawnToIdle(): Promise<void> {
    const childInfo = await resolveSandboxChildEntry();
    const child = child_process.fork(childInfo.entry, [], {
      execArgv: [...childInfo.execArgv],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const entry: PoolEntry = {
      child,
      uses: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      idleTimer: null,
    };
    entry.idleTimer = setTimeout(() => {
      this.evictEntry(entry);
    }, this.maxIdleMs);
    entry.idleTimer.unref?.();
    this.idle.push(entry);
  }

  private evictEntry(entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    const idx = this.idle.indexOf(entry);
    if (idx !== -1) this.idle.splice(idx, 1);
    this.killChild(entry.child);
    // 自动补充
    if (!this.shuttingDown && this.idle.length < this.poolSize) {
      this.spawnToIdle().catch(() => {});
    }
  }

  private killChild(child: ChildProcess): void {
    try {
      child.kill("SIGKILL");
    } catch {}
  }

  /**
   * 僵尸进程扫描：60 秒周期检查空闲池中已退出但未清理的进程，
   * 将其移除、释放资源并记录告警日志。
   */
  private startZombieScan(): void {
    if (this.zombieScanTimer) return;
    this.zombieScanTimer = setInterval(() => {
      let removed = 0;
      for (let i = this.idle.length - 1; i >= 0; i--) {
        const entry = this.idle[i];
        const alive = this.isChildAlive(entry.child);
        if (!alive) {
          if (entry.idleTimer) clearTimeout(entry.idleTimer);
          this.idle.splice(i, 1);
          removed++;
          console.warn(`[skillProcessPool] zombie cleanup: removed dead idle process pid=${entry.child.pid}`);
        }
      }
      // 补充池
      if (!this.shuttingDown && removed > 0) {
        const deficit = Math.max(0, this.poolSize - this.idle.length);
        for (let i = 0; i < deficit; i++) {
          this.spawnToIdle().catch(() => {});
        }
      }
    }, ZOMBIE_SCAN_INTERVAL_MS);
    this.zombieScanTimer.unref?.();
  }

  /** 检测子进程是否仍然存活（signal 0 探测） */
  private isChildAlive(child: ChildProcess): boolean {
    if (child.killed || child.exitCode !== null) return false;
    try {
      // signal 0 不发送信号，仅检测进程是否存在
      child.kill(0 as any);
      return true;
    } catch {
      return false;
    }
  }
}

/* ── 单例 ──────────────────────────────────────────────────── */
let _instance: SkillProcessPool | null = null;

export function getProcessPool(): SkillProcessPool {
  if (!_instance) {
    _instance = new SkillProcessPool();
  }
  return _instance;
}

export async function shutdownPool(): Promise<void> {
  if (_instance) {
    await _instance.shutdown();
    _instance = null;
  }
}
