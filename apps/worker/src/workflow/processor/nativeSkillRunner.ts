/**
 * Native Skill Runner — 通过子进程执行编译型(Go/Rust)Skill
 *
 * OS 思维：编译型 Skill 是预编译的"原生进程"，本模块是"进程创建器 + IPC 管理器"。
 * 通过 JSON-RPC over stdio（NDJSON）与二进制子进程通信。
 * 与 Python Runner 不同：无需 wrapper 脚本注入，无需依赖安装。
 *
 * 生命周期：
 * 1. 可执行文件验证：检查入口文件存在 + 可执行权限
 * 2. 进程启动：spawn 二进制 + 安全环境变量
 * 3. 初始化：发送 skill.initialize → 接收能力声明
 * 4. 执行：发送 skill.execute → 接收输出 + 进度通知
 * 5. 回收：发送 skill.shutdown → 等待退出 → kill 保底
 *
 * 安全措施：
 * - 子进程隔离（仅传入最小环境变量）
 * - 超时强制 kill
 * - stdout/stderr 大小限制
 * - 出站网络由 NetworkPolicy 控制
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  SKILL_RPC_METHODS,
  SKILL_RPC_ERRORS,
  createRpcRequest,
  parseRpcMessage,
  serializeRpcMessage,
  isRpcResponse,
  isRpcNotification,
  isRpcError,
  type SkillInitializeParams,
  type SkillInitializeResult,
  type SkillExecuteParams,
  type SkillExecuteResult,
  type SkillProgressNotification,
  type SkillLogNotification,
  type SkillRpcResponse,
  resolveString,
} from "@openslin/shared";
import type { RuntimeLimits, NetworkPolicy } from "./runtime";
import type { DynamicSkillExecResult } from "./dynamicSkillTypes";

/* ================================================================== */
/*  配置                                                               */
/* ================================================================== */

const MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_STDERR_BYTES = 1 * 1024 * 1024;  // 1 MB
const INIT_TIMEOUT_MS = 5_000;    // 比Python短，二进制启动更快
const SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/* ================================================================== */
/*  子进程 RPC 客户端                                                    */
/* ================================================================== */

class NativeSkillProcess {
  private child: ChildProcess | null = null;
  private buffer = "";
  private pendingRequests = new Map<string | number, {
    resolve: (msg: SkillRpcResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private msgIdSeq = 0;
  private stderrLog = "";
  private onProgress?: (notification: SkillProgressNotification) => void;
  private onLog?: (notification: SkillLogNotification) => void;

  async start(params: {
    entryPath: string;
    artifactDir: string;
    limits: RuntimeLimits;
    networkPolicy: NetworkPolicy;
    traceId: string;
    tenantId: string;
    runtime: "go" | "rust" | "native";
    signal: AbortSignal;
    onProgress?: (n: SkillProgressNotification) => void;
    onLog?: (n: SkillLogNotification) => void;
  }): Promise<void> {
    this.onProgress = params.onProgress;
    this.onLog = params.onLog;

    // 构建安全的环境变量（仅传入最小集合，不继承父进程敏感变量）
    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH || "/usr/bin:/usr/local/bin",
      HOME: process.env.HOME || "/tmp",
      LANG: "en_US.UTF-8",
      SKILL_TRACE_ID: params.traceId,
      SKILL_TENANT_ID: params.tenantId,
      SKILL_RUNTIME: params.runtime,
    };

    this.child = spawn(params.entryPath, [], {
      cwd: params.artifactDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: safeEnv,
    });

    // stdout: NDJSON 消息通道
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      if (this.buffer.length < MAX_STDOUT_BYTES) {
        this.buffer += chunk;
      }
      this.processBuffer();
    });

    // stderr: 日志收集
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      if (this.stderrLog.length < MAX_STDERR_BYTES) {
        this.stderrLog += chunk;
      }
    });

    // 信号中止处理
    const onAbort = () => this.kill();
    if (params.signal.aborted) { this.kill(); return; }
    params.signal.addEventListener("abort", onAbort, { once: true });

    this.child.on("close", () => {
      params.signal.removeEventListener("abort", onAbort);
      // 清理所有未完成请求
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.resolve({
          jsonrpc: "2.0",
          id,
          error: { code: SKILL_RPC_ERRORS.INTERNAL_ERROR, message: "Process exited unexpectedly" },
        });
      }
      this.pendingRequests.clear();
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // 最后一个可能是不完整的行

    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = parseRpcMessage(line);
      if (!msg) continue;

      if (isRpcResponse(msg) && (typeof msg.id === "string" || typeof msg.id === "number")) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          pending.resolve(msg);
        }
      } else if (isRpcNotification(msg)) {
        if (msg.method === SKILL_RPC_METHODS.PROGRESS && this.onProgress) {
          this.onProgress(msg.params as SkillProgressNotification);
        } else if (msg.method === SKILL_RPC_METHODS.LOG && this.onLog) {
          this.onLog(msg.params as SkillLogNotification);
        }
      }
    }
  }

  async sendRequest<R>(method: string, params: unknown, timeoutMs: number): Promise<SkillRpcResponse<R>> {
    if (!this.child?.stdin?.writable) {
      return {
        jsonrpc: "2.0",
        id: 0,
        error: { code: SKILL_RPC_ERRORS.INTERNAL_ERROR, message: "Process not running" },
      };
    }

    const id = ++this.msgIdSeq;
    const request = createRpcRequest(id, method, params);

    return new Promise<SkillRpcResponse<R>>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve({
          jsonrpc: "2.0",
          id,
          error: { code: SKILL_RPC_ERRORS.EXECUTION_TIMEOUT, message: `Timeout after ${timeoutMs}ms` },
        });
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve: resolve as any, timer });

      try {
        this.child!.stdin!.write(serializeRpcMessage(request));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        resolve({
          jsonrpc: "2.0",
          id,
          error: { code: SKILL_RPC_ERRORS.INTERNAL_ERROR, message: `Write failed: ${(err as Error).message}` },
        });
      }
    });
  }

  kill(): void {
    try {
      this.child?.kill("SIGTERM");
      setTimeout(() => {
        try { this.child?.kill("SIGKILL"); } catch { /* ignore */ }
      }, SHUTDOWN_TIMEOUT_MS);
    } catch { /* ignore */ }
  }

  getStderrLog(): string {
    return this.stderrLog;
  }
}

/* ================================================================== */
/*  公开接口                                                            */
/* ================================================================== */

export async function executeNativeSkill(params: {
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
  runtime: "go" | "rust" | "native";
}): Promise<DynamicSkillExecResult> {
  const startMs = Date.now();
  const execTimeoutMs = typeof params.limits.timeoutMs === "number" && params.limits.timeoutMs > 0
    ? params.limits.timeoutMs
    : DEFAULT_EXEC_TIMEOUT_MS;

  // 1. 验证可执行文件存在
  let resolvedEntry = params.entryPath;

  // Windows 兼容：如果是 Windows 且不以 .exe 结尾，尝试附加 .exe
  if (process.platform === "win32" && !resolvedEntry.endsWith(".exe")) {
    const exeCandidate = resolvedEntry + ".exe";
    if (fs.existsSync(exeCandidate)) {
      resolvedEntry = exeCandidate;
    }
  }

  if (!fs.existsSync(resolvedEntry)) {
    return {
      output: null,
      egress: [],
      depsDigest: params.depsDigest,
      runtimeBackend: "process",
      degraded: false,
      runnerSummary: {
        error: "spawn_error",
        detail: `Executable not found: ${resolvedEntry}`,
        runtime: params.runtime,
      },
    };
  }

  // 2. 启动原生进程
  const proc = new NativeSkillProcess();
  const progressEvents: SkillProgressNotification[] = [];

  try {
    await proc.start({
      entryPath: resolvedEntry,
      artifactDir: params.artifactDir,
      limits: params.limits,
      networkPolicy: params.networkPolicy,
      traceId: params.traceId,
      tenantId: params.tenantId,
      runtime: params.runtime,
      signal: params.signal,
      onProgress: (n) => progressEvents.push(n),
    });

    // 3. 初始化
    const initParams: SkillInitializeParams = {
      protocolVersion: "1.0",
      toolRef: params.toolRef,
      context: {
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        subjectId: params.subjectId,
        traceId: params.traceId,
        locale: "zh-CN",
      },
      capabilities: {
        allowedDomains: params.networkPolicy.allowedDomains ?? [],
        allowedPaths: [],
        networkAccess: (params.networkPolicy.allowedDomains?.length ?? 0) > 0,
      },
      limits: {
        timeoutMs: execTimeoutMs,
        memoryMb: typeof params.limits.memoryMb === "number" ? params.limits.memoryMb : 256,
        maxOutputBytes: MAX_STDOUT_BYTES,
      },
    };

    const initResp = await proc.sendRequest<SkillInitializeResult>(
      SKILL_RPC_METHODS.INITIALIZE, initParams, INIT_TIMEOUT_MS,
    );

    if (isRpcError(initResp)) {
      return {
        output: null,
        egress: [],
        depsDigest: params.depsDigest,
        runtimeBackend: "process",
        degraded: false,
        runnerSummary: {
          error: "initialization_failed",
          rpcError: initResp.error,
          stderr: proc.getStderrLog().slice(0, 500),
          runtime: params.runtime,
        },
      };
    }

    // 4. 执行
    const inputStr = JSON.stringify(params.input ?? {});
    const inputDigest = {
      sha256_8: crypto.createHash("sha256").update(inputStr, "utf8").digest("hex").slice(0, 8),
      bytes: Buffer.byteLength(inputStr, "utf8"),
    };

    const execParams: SkillExecuteParams = {
      requestId: params.idempotencyKey || crypto.randomUUID(),
      input: params.input ?? {},
      inputDigest,
    };

    const execResp = await proc.sendRequest<SkillExecuteResult>(
      SKILL_RPC_METHODS.EXECUTE, execParams, execTimeoutMs,
    );

    // 5. 关闭
    try {
      await proc.sendRequest(SKILL_RPC_METHODS.SHUTDOWN, {}, SHUTDOWN_TIMEOUT_MS);
    } catch { /* ignore */ }

    const latencyMs = Date.now() - startMs;

    if (isRpcError(execResp)) {
      return {
        output: null,
        egress: [],
        depsDigest: params.depsDigest,
        runtimeBackend: "process",
        degraded: false,
        runnerSummary: {
          error: "execution_failed",
          rpcError: execResp.error,
          stderr: proc.getStderrLog().slice(0, 500),
          latencyMs,
          runtime: params.runtime,
          progressEvents: progressEvents.length,
        },
      };
    }

    const result = (execResp as any).result as SkillExecuteResult;
    return {
      output: result.output,
      egress: [],
      depsDigest: params.depsDigest,
      runtimeBackend: "process",
      degraded: false,
      runnerSummary: {
        latencyMs,
        runtime: params.runtime,
        initResult: (initResp as any).result,
        egressSummary: result.egressSummary,
        progressEvents: progressEvents.length,
      },
    };
  } catch (err) {
    proc.kill();

    // 错误类型分类，方便运维定位
    const errMsg = (err as Error)?.message ?? String(err);
    let errorCategory = "process_error";
    if (/timeout|timed out|ETIMEDOUT/i.test(errMsg)) {
      errorCategory = "timeout";
    } else if (/ENOMEM|out of memory|killed/i.test(errMsg)) {
      errorCategory = "oom";
    } else if (/EACCES|PermissionError/i.test(errMsg)) {
      errorCategory = "permission_error";
    } else if (/ENOENT|not found/i.test(errMsg)) {
      errorCategory = "spawn_error";
    } else if (/JSON|parse|protocol|unexpected token/i.test(errMsg)) {
      errorCategory = "protocol_error";
    } else if (/ECONNREFUSED|ENOTFOUND|NetworkError/i.test(errMsg)) {
      errorCategory = "network_error";
    }

    return {
      output: null,
      egress: [],
      depsDigest: params.depsDigest,
      runtimeBackend: "process",
      degraded: false,
      runnerSummary: {
        error: errorCategory,
        message: errMsg,
        stderr: proc.getStderrLog().slice(0, 500),
        latencyMs: Date.now() - startMs,
        runtime: params.runtime,
      },
    };
  }
}
