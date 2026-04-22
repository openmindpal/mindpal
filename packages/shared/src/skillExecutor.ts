/**
 * skillExecutor.ts — 统一 Skill 沙箱执行框架
 *
 * 将 Runner 的进程池管理 + IPC 协议 + 超时/心跳 + 错误分类逻辑提取为共享库，
 * 消除 Runner 与 Worker 的双重沙箱实现。
 *
 * @module @openslin/shared/skillExecutor
 */
import child_process, { type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ServiceError, classifyError } from "./serviceError";
import { ErrorCategory } from "./serviceError";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillExecuteRequest {
  skillName: string;
  skillVersion: string;
  artifactDir: string;
  entryPoint: string;
  input: Record<string, unknown>;
  timeout: number;
  memoryLimitMb?: number;
  env?: Record<string, string>;
  traceId?: string;
  /** IPC payload forwarded directly to the child process (overrides auto-built payload when provided) */
  ipcPayload?: Record<string, unknown>;
}

export interface SkillExecuteResponse {
  output: Record<string, unknown>;
  durationMs: number;
  memoryUsedMb?: number;
  logs?: string[];
  egress?: unknown[];
  depsDigest?: string;
}

export interface SandboxExecutor {
  execute(request: SkillExecuteRequest): Promise<SkillExecuteResponse>;
  shutdown(): Promise<void>;
}

export interface SandboxExecutorOptions {
  maxProcesses?: number;
  idleTimeoutMs?: number;
  defaultTimeoutMs?: number;
  defaultMemoryLimitMb?: number;
  /** Absolute path to the child sandbox script (the file that child_process.fork() will run) */
  childScriptPath?: string;
  /** Extra execArgv for the child process (e.g. ["-r", "tsx/cjs"]) */
  childExecArgv?: string[];
  /** Max uses per process before recycling */
  maxUses?: number;
}

/** Skill 版本切换描述，用于热更新流程协调 */
export interface SkillVersionSwitch {
  skillId: string;
  fromVersion: string;
  toVersion: string;
  /** 切换策略：graceful_drain 等待当前任务完成后排空；immediate 立即终止 */
  strategy: 'graceful_drain' | 'immediate';
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool internals
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_POOL_SIZE = 3;
const DEFAULT_MAX_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_USES = 50;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MAX_MISSES = 3;
const ZOMBIE_SCAN_INTERVAL_MS = 60_000;

interface PoolEntry {
  child: ChildProcess;
  uses: number;
  createdAt: number;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface ActiveEntry {
  child: ChildProcess;
  missedHeartbeats: number;
  heartbeatTimer: ReturnType<typeof setInterval>;
  onFailure: (() => void) | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Child entry resolution
// ─────────────────────────────────────────────────────────────────────────────

interface ChildEntryInfo {
  entry: string;
  execArgv: string[];
}

async function resolveChildEntry(
  scriptPath: string | undefined,
  extraExecArgv: string[],
): Promise<ChildEntryInfo> {
  if (scriptPath) {
    return { entry: scriptPath, execArgv: [...extraExecArgv] };
  }
  // Fallback: look for skillSandboxChild.js/.ts relative to CWD
  const jsPath = path.resolve(process.cwd(), "dist", "skillSandboxChild.js");
  try {
    const st = await fs.stat(jsPath);
    if (st.isFile()) return { entry: jsPath, execArgv: [...extraExecArgv] };
  } catch {}
  const tsPath = path.resolve(process.cwd(), "src", "skillSandboxChild.ts");
  return { entry: tsPath, execArgv: ["-r", "tsx/cjs", ...extraExecArgv] };
}

// ─────────────────────────────────────────────────────────────────────────────
// SkillProcessPool
// ─────────────────────────────────────────────────────────────────────────────

export class SkillProcessPool {
  private readonly poolSize: number;
  private readonly maxIdleMs: number;
  private readonly maxUses: number;
  private readonly idle: PoolEntry[] = [];
  private readonly active = new Map<number, ActiveEntry>();
  private zombieScanTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  /** 标记正在 draining 的进程（用于版本热更新），替代 as any 标记 */
  private readonly drainingSet = new WeakSet<ChildProcess>();

  private readonly childScriptPath: string | undefined;
  private readonly childExecArgv: string[];
  private _childEntryCache: ChildEntryInfo | null = null;

  constructor(opts?: SandboxExecutorOptions) {
    this.poolSize = opts?.maxProcesses ?? DEFAULT_POOL_SIZE;
    this.maxIdleMs = opts?.idleTimeoutMs ?? DEFAULT_MAX_IDLE_MS;
    this.maxUses = opts?.maxUses ?? DEFAULT_MAX_USES;
    this.childScriptPath = opts?.childScriptPath;
    this.childExecArgv = opts?.childExecArgv ?? [];
  }

  private async getChildEntry(): Promise<ChildEntryInfo> {
    if (this._childEntryCache) return this._childEntryCache;
    this._childEntryCache = await resolveChildEntry(this.childScriptPath, this.childExecArgv);
    return this._childEntryCache;
  }

  /** Warm up the process pool + start zombie scanner */
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
   * Acquire a child process from the pool.
   * @param limits optional memory limit (only used when a new process must be forked)
   */
  async acquire(limits?: { memoryMb?: number }): Promise<{ child: ChildProcess; _poolEntry: PoolEntry | null }> {
    if (this.shuttingDown) throw new ServiceError({
      category: ErrorCategory.INTERNAL,
      code: "POOL_SHUTDOWN",
      httpStatus: 503,
      message: "skill_process_pool_shutdown",
    });

    // 负载感知分配：从空闲池中选择剩余使用次数最多的进程（寿命最长、最不容易被回收）
    // 先过滤掉 draining 和已死进程，再按 remainingUses 降序排列
    this.idle.sort((a, b) => {
      const remainA = this.maxUses - a.uses;
      const remainB = this.maxUses - b.uses;
      return remainB - remainA;
    });

    while (this.idle.length > 0) {
      const entry = this.idle.shift()!;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
      if (!entry.child.connected || entry.child.killed) continue;
      if (this.drainingSet.has(entry.child)) {
        // draining 进程不再分配，直接 kill
        this.killChild(entry.child);
        continue;
      }
      return { child: entry.child, _poolEntry: entry };
    }

    const childInfo = await this.getChildEntry();
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

  /** Start heartbeat monitoring for an active child process */
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

  /** Stop heartbeat for a given pid */
  stopHeartbeat(pid: number): void {
    const entry = this.active.get(pid);
    if (!entry) return;
    clearInterval(entry.heartbeatTimer);
    this.active.delete(pid);
  }

  /** Release a process back to the pool */
  release(child: ChildProcess, poolEntry: PoolEntry | null): void {
    if (this.shuttingDown) {
      this.killChild(child);
      return;
    }

    // draining 进程：完成当前任务后直接 kill，不归还 idle 池
    if (this.drainingSet.has(child)) {
      this.drainingSet.delete(child);
      this.killChild(child);
      return;
    }

    if (poolEntry) {
      poolEntry.uses += 1;
      poolEntry.lastUsedAt = Date.now();
      if (poolEntry.uses >= this.maxUses || !child.connected || child.killed) {
        this.killChild(child);
        this.spawnToIdle().catch(() => {});
        return;
      }
      if (this.idle.length >= this.poolSize) {
        this.killChild(child);
        return;
      }
      poolEntry.idleTimer = setTimeout(() => this.evictEntry(poolEntry), this.maxIdleMs);
      poolEntry.idleTimer.unref?.();
      this.idle.push(poolEntry);
    } else {
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
      entry.idleTimer = setTimeout(() => this.evictEntry(entry), this.maxIdleMs);
      entry.idleTimer.unref?.();
      this.idle.push(entry);
    }
  }

  /** Kill a process immediately (error path) */
  discard(child: ChildProcess): void {
    this.killChild(child);
  }

  /**
   * 优雅排空所有现有进程，用于 Skill 版本热更新。
   *
   * 功能目标：在 Skill 代码更新时，安全地排空旧版本进程池，
   * 使后续请求使用新 fork 的进程（加载新版本代码），实现零停机热重载。
   *
   * 流程：
   * 1. 立即清空 idle 池（kill 所有空闲进程）
   * 2. 标记所有 active 进程为 draining
   * 3. draining 进程完成当前任务后由 release() 自动 kill
   * 4. 新请求通过 acquire() fork 新进程（新版本代码）
   */
  async gracefulDrain(): Promise<void> {
    // 立即清空 idle 池：kill 所有空闲进程
    for (const entry of this.idle) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this.killChild(entry.child);
    }
    this.idle.length = 0;

    // 标记所有 active 进程为 draining，完成当前任务后不再重用
    for (const [, entry] of this.active) {
      this.drainingSet.add(entry.child);
    }

    // 清除子进程入口缓存，使后续 fork 加载新版本代码
    this._childEntryCache = null;

    console.log(
      `[skillProcessPool] gracefulDrain: killed idle processes, marked ${this.active.size} active process(es) as draining`,
    );
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.zombieScanTimer) {
      clearInterval(this.zombieScanTimer);
      this.zombieScanTimer = null;
    }
    for (const [_pid, entry] of this.active) {
      clearInterval(entry.heartbeatTimer);
      this.killChild(entry.child);
    }
    this.active.clear();
    for (const entry of this.idle) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this.killChild(entry.child);
    }
    this.idle.length = 0;
    console.log("[skillProcessPool] shutdown complete");
  }

  /* ── internal ─────────────────────────────────────────────── */

  private async spawnToIdle(): Promise<void> {
    const childInfo = await this.getChildEntry();
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
    entry.idleTimer = setTimeout(() => this.evictEntry(entry), this.maxIdleMs);
    entry.idleTimer.unref?.();
    this.idle.push(entry);
  }

  private evictEntry(entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    const idx = this.idle.indexOf(entry);
    if (idx !== -1) this.idle.splice(idx, 1);
    this.killChild(entry.child);
    if (!this.shuttingDown && this.idle.length < this.poolSize) {
      this.spawnToIdle().catch(() => {});
    }
  }

  private killChild(child: ChildProcess): void {
    try { child.kill("SIGKILL"); } catch {}
  }

  private startZombieScan(): void {
    if (this.zombieScanTimer) return;
    this.zombieScanTimer = setInterval(() => {
      let removed = 0;
      for (let i = this.idle.length - 1; i >= 0; i--) {
        const entry = this.idle[i];
        if (!this.isChildAlive(entry.child)) {
          if (entry.idleTimer) clearTimeout(entry.idleTimer);
          this.idle.splice(i, 1);
          removed++;
          console.warn(`[skillProcessPool] zombie cleanup: removed dead idle process pid=${entry.child.pid}`);
        }
      }
      if (!this.shuttingDown && removed > 0) {
        const deficit = Math.max(0, this.poolSize - this.idle.length);
        for (let i = 0; i < deficit; i++) {
          this.spawnToIdle().catch(() => {});
        }
      }
    }, ZOMBIE_SCAN_INTERVAL_MS);
    this.zombieScanTimer.unref?.();
  }

  private isChildAlive(child: ChildProcess): boolean {
    if (child.killed || child.exitCode !== null) return false;
    try { child.kill(0 as any); return true; } catch { return false; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SandboxExecutor implementation
// ─────────────────────────────────────────────────────────────────────────────

class ProcessPoolSandboxExecutor implements SandboxExecutor {
  private readonly pool: SkillProcessPool;
  private readonly defaultTimeoutMs: number;

  constructor(pool: SkillProcessPool, opts?: SandboxExecutorOptions) {
    this.pool = pool;
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 30_000;
  }

  async execute(request: SkillExecuteRequest): Promise<SkillExecuteResponse> {
    const timeoutMs = request.timeout > 0 ? request.timeout : this.defaultTimeoutMs;
    const memoryMb = request.memoryLimitMb;

    const { child, _poolEntry } = await this.pool.acquire({ memoryMb });

    let executionFailed = false;
    let heartbeatKilled = false;
    const startMs = Date.now();

    const kill = () => { this.pool.discard(child); };

    // Heartbeat
    this.pool.startHeartbeat(child, () => { heartbeatKilled = true; });

    // Build IPC payload
    const ipcPayload = request.ipcPayload ?? {
      toolRef: request.skillName,
      tenantId: request.env?.["TENANT_ID"] ?? "",
      traceId: request.traceId ?? "",
      input: request.input,
      entryPath: request.entryPoint,
    };

    const result = await new Promise<any>((resolve, reject) => {
      // Timeout guard
      const timer = setTimeout(() => {
        executionFailed = true;
        kill();
        reject(new ServiceError({
          category: ErrorCategory.TIMEOUT,
          code: "SANDBOX_TIMEOUT",
          httpStatus: 504,
          message: `skill_sandbox_timeout:${timeoutMs}ms`,
        }));
      }, timeoutMs);
      timer.unref?.();

      const onExit = (code: number | null) => {
        clearTimeout(timer);
        executionFailed = true;
        if (heartbeatKilled) {
          reject(new ServiceError({
            category: ErrorCategory.TIMEOUT,
            code: "HEARTBEAT_TIMEOUT",
            httpStatus: 504,
            message: "skill_sandbox_heartbeat_timeout",
          }));
        } else if (code === 134 || code === 137) {
          reject(new ServiceError({
            category: ErrorCategory.RESOURCE_EXHAUSTED,
            code: "MEMORY_EXHAUSTED",
            httpStatus: 429,
            message: "resource_exhausted:memory",
          }));
        } else {
          reject(classifyError(new Error(`skill_sandbox_exited:${code ?? "null"}`)));
        }
      };
      const onMessage = (m: any) => {
        if (!m || typeof m !== "object") return;
        if (m.type !== "result") return;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("message", onMessage);
        resolve(m);
      };
      child.on("exit", onExit);
      child.on("message", onMessage);
      child.send({ type: "execute", payload: ipcPayload });
    }).finally(() => {
      if (child.pid != null) this.pool.stopHeartbeat(child.pid);
    });

    // Release or discard
    if (!result?.ok || executionFailed) {
      this.pool.discard(child);
    } else {
      this.pool.release(child, _poolEntry);
    }

    const durationMs = Date.now() - startMs;

    if (!result?.ok) {
      const msg = String(result?.error?.message ?? "skill_sandbox_error");
      const err = classifyError(new Error(msg));
      (err as any).egress = Array.isArray(result.egress) ? result.egress : [];
      throw err;
    }

    return {
      output: result.output,
      durationMs,
      egress: Array.isArray(result.egress) ? result.egress : [],
      depsDigest: result.depsDigest != null ? String(result.depsDigest) : undefined,
    };
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a unified sandbox executor backed by a process pool.
 *
 * @param options pool sizing, timeouts, and child script configuration
 * @returns SandboxExecutor instance
 */
export function createSandboxExecutor(options?: SandboxExecutorOptions): SandboxExecutor {
  const pool = new SkillProcessPool(options);
  return new ProcessPoolSandboxExecutor(pool, options);
}

/**
 * Create a sandbox executor and return both the executor and the underlying pool
 * (useful when the caller needs direct pool access for warmup/heartbeat control).
 */
export function createSandboxExecutorWithPool(options?: SandboxExecutorOptions): {
  executor: SandboxExecutor;
  pool: SkillProcessPool;
} {
  const pool = new SkillProcessPool(options);
  const executor = new ProcessPoolSandboxExecutor(pool, options);
  return { executor, pool };
}
