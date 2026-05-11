/**
 * skillExecutor.ts — 统一 Skill 沙箱执行框架（编排入口）
 *
 * 将 Runner 的进程池管理 + IPC 协议 + 超时/心跳 + 错误分类逻辑提取为共享库，
 * 消除 Runner 与 Worker 的双重沙箱实现。
 *
 * 本文件保留对外暴露的执行接口、超时管理、结果聚合。
 * 进程池管理 → skillProcessPool.ts
 * IPC 协议与运行入口 → skillIpc.ts
 *
 * @module @mindpal/shared/skillExecutor
 */
import { ServiceError, classifyError } from "./serviceError";
import { ErrorCategory } from "./serviceError";
import { SkillProcessPool } from "./skillProcessPool";
import type { SandboxExecutorOptions, PoolEntry } from "./skillProcessPool";

// Re-export from sub-modules for backward compatibility
export { SkillProcessPool } from "./skillProcessPool";
export type { SandboxExecutorOptions, SkillVersionSwitch } from "./skillProcessPool";
export {
  buildApiFetch,
  createEgressWrappedFetch,
  runSkillEntry,
} from "./skillIpc";
export type {
  SandboxIpcExecuteMessage,
  SandboxIpcHeartbeatMessage,
  SandboxIpcHeartbeatAck,
  SandboxIpcPayload,
  SandboxIpcResultMessage,
  SandboxIpcMessage,
  ApiFetchContext,
  EgressWrappedFetchOptions,
  RunSkillEntryOptions,
  RunSkillEntryResult,
} from "./skillIpc";

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

    const result = await new Promise<{ ok: boolean; output?: Record<string, unknown>; error?: { message: string }; egress?: unknown[]; depsDigest?: string }>((resolve, reject) => {
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
      const onMessage = (m: unknown) => {
        if (!m || typeof m !== "object") return;
        if ((m as Record<string, unknown>).type !== "result") return;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("message", onMessage);
        resolve(m as { ok: boolean; output?: Record<string, unknown>; error?: { message: string }; egress?: unknown[]; depsDigest?: string });
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
      const egress = Array.isArray(result.egress) ? result.egress : [];
      const classified = classifyError(new Error(msg));
      const err = new ServiceError({
        category: classified.category,
        code: classified.code,
        httpStatus: classified.httpStatus,
        message: msg,
        details: { egress },
      });
      throw err;
    }

    return {
      output: result.output ?? {},
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
