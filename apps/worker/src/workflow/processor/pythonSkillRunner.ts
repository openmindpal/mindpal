/**
 * Python Skill Runner — 通过子进程执行 Python Skill
 *
 * OS 思维：Python Skill 是"外部进程"，本模块是"进程创建器 + IPC 管理器"。
 * 通过 JSON-RPC over stdio（NDJSON）与 Python 子进程通信。
 *
 * 生命周期：
 * 1. 依赖安装：检查 requirements.txt → pip install（可缓存）
 * 2. 进程启动：spawn python3 + 传入 wrapper 脚本
 * 3. 初始化：发送 skill.initialize → 接收能力声明
 * 4. 执行：发送 skill.execute → 接收输出 + 进度通知
 * 5. 回收：发送 skill.shutdown → 等待退出 → kill 保底
 *
 * 安全措施：
 * - 子进程隔离（不继承父进程环境变量）
 * - 超时强制 kill
 * - stdout/stderr 大小限制
 * - 出站网络由 NetworkPolicy 控制（Skill 侧需使用受控 HTTP 客户端）
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
} from "@openslin/shared";
import type { RuntimeLimits, NetworkPolicy } from "./runtime";
import type { DynamicSkillExecResult } from "./dynamicSkillTypes";

/* ================================================================== */
/*  配置                                                               */
/* ================================================================== */

const PYTHON_BIN = process.env.SKILL_PYTHON_BIN || "python3";
const PIP_BIN = process.env.SKILL_PIP_BIN || "pip3";
const PIP_CACHE_DIR = process.env.SKILL_PIP_CACHE_DIR || "";
const MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_STDERR_BYTES = 1 * 1024 * 1024;  // 1 MB
const INIT_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/* ================================================================== */
/*  Python Wrapper 脚本（内联注入到子进程）                               */
/* ================================================================== */

function buildPythonWrapperScript(entryModule: string): string {
  // 注意：这是注入到 python3 -c 的脚本
  return `
import sys, json, importlib.util, traceback, os

def send_msg(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

def read_msg():
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line.strip())

# Load the skill module
spec = importlib.util.spec_from_file_location("skill_module", ${JSON.stringify(entryModule)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# Find execute function
execute_fn = getattr(mod, "execute", None) or getattr(mod, "main", None) or getattr(mod, "run", None)
initialize_fn = getattr(mod, "initialize", None)

# Message loop
while True:
    try:
        msg = read_msg()
        if msg is None:
            break
        
        if msg.get("method") == "skill.initialize":
            req_id = msg.get("id")
            params = msg.get("params", {})
            result = {"name": "unknown", "version": "0.0.0", "runtime": "python"}
            if initialize_fn:
                try:
                    init_result = initialize_fn(params)
                    if isinstance(init_result, dict):
                        result.update(init_result)
                except Exception as e:
                    result["initError"] = str(e)
            send_msg({"jsonrpc": "2.0", "id": req_id, "result": result})
        
        elif msg.get("method") == "skill.execute":
            req_id = msg.get("id")
            params = msg.get("params", {})
            input_data = params.get("input", {})
            try:
                if execute_fn is None:
                    send_msg({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "No execute/main/run function found"}})
                else:
                    output = execute_fn(input_data)
                    send_msg({"jsonrpc": "2.0", "id": req_id, "result": {"output": output}})
            except Exception as e:
                tb = traceback.format_exc()
                send_msg({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32002, "message": str(e), "data": {"traceback": tb}}})
        
        elif msg.get("method") == "skill.heartbeat":
            req_id = msg.get("id")
            send_msg({"jsonrpc": "2.0", "id": req_id, "result": {"ts": int(__import__("time").time() * 1000), "status": "alive"}})
        
        elif msg.get("method") == "skill.shutdown":
            req_id = msg.get("id")
            send_msg({"jsonrpc": "2.0", "id": req_id, "result": {"ok": True}})
            break
        
    except json.JSONDecodeError:
        continue
    except Exception as e:
        try:
            send_msg({"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": str(e)}})
        except:
            pass
        break
`;
}

/* ================================================================== */
/*  依赖安装                                                            */
/* ================================================================== */

async function installPythonDeps(params: {
  requirementsPath: string;
  targetDir: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<{ ok: boolean; error?: string }> {
  const { requirementsPath, targetDir, timeoutMs, signal } = params;

  if (!fs.existsSync(requirementsPath)) {
    return { ok: true }; // 无依赖文件，跳过
  }

  return new Promise((resolve) => {
    const args = [
      "install",
      "-r", requirementsPath,
      "--target", targetDir,
      "--no-compile",
      "--disable-pip-version-check",
      "--quiet",
    ];
    if (PIP_CACHE_DIR) {
      args.push("--cache-dir", PIP_CACHE_DIR);
    }

    const child = spawn(PIP_BIN, args, {
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
    });

    const onAbort = () => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `pip install failed (exit ${code}): ${stderr.slice(0, 500)}` });
    });

    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ ok: false, error: `pip spawn error: ${err.message}` });
    });
  });
}

/* ================================================================== */
/*  子进程 RPC 客户端                                                    */
/* ================================================================== */

class PythonSkillProcess {
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
    signal: AbortSignal;
    onProgress?: (n: SkillProgressNotification) => void;
    onLog?: (n: SkillLogNotification) => void;
  }): Promise<void> {
    this.onProgress = params.onProgress;
    this.onLog = params.onLog;

    const wrapperScript = buildPythonWrapperScript(params.entryPath);

    // 构建安全的环境变量（不继承父进程敏感变量）
    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH || "/usr/bin:/usr/local/bin",
      HOME: process.env.HOME || "/tmp",
      PYTHONPATH: params.artifactDir,
      PYTHONUNBUFFERED: "1",
      LANG: "en_US.UTF-8",
    };

    // 如果有依赖目录，加入 PYTHONPATH
    const depsDir = path.join(params.artifactDir, ".skill_deps");
    if (fs.existsSync(depsDir)) {
      safeEnv.PYTHONPATH = `${depsDir}:${params.artifactDir}`;
    }

    this.child = spawn(PYTHON_BIN, ["-c", wrapperScript], {
      cwd: params.artifactDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: safeEnv,
    });

    // stdout: NDJSON 消息通道
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
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

export async function executePythonSkill(params: {
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
  const startMs = Date.now();
  const execTimeoutMs = typeof params.limits.timeoutMs === "number" && params.limits.timeoutMs > 0
    ? params.limits.timeoutMs
    : DEFAULT_EXEC_TIMEOUT_MS;

  // 1. 安装依赖（如果有 requirements.txt）
  const requirementsPath = path.join(params.artifactDir, "requirements.txt");
  const depsDir = path.join(params.artifactDir, ".skill_deps");

  if (fs.existsSync(requirementsPath)) {
    if (!fs.existsSync(depsDir)) {
      fs.mkdirSync(depsDir, { recursive: true });
    }
    const installResult = await installPythonDeps({
      requirementsPath,
      targetDir: depsDir,
      timeoutMs: Math.min(execTimeoutMs / 2, 60_000),
      signal: params.signal,
    });
    if (!installResult.ok) {
      return {
        output: null,
        egress: [],
        depsDigest: params.depsDigest,
        runtimeBackend: "process",
        degraded: false,
        runnerSummary: {
          error: "dependency_install_failed",
          detail: installResult.error,
          runtime: "python",
        },
      };
    }
  }

  // 2. 启动 Python 进程
  const proc = new PythonSkillProcess();
  const progressEvents: SkillProgressNotification[] = [];

  try {
    await proc.start({
      entryPath: params.entryPath,
      artifactDir: params.artifactDir,
      limits: params.limits,
      networkPolicy: params.networkPolicy,
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
          runtime: "python",
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
          runtime: "python",
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
        runtime: "python",
        initResult: (initResp as any).result,
        egressSummary: result.egressSummary,
        progressEvents: progressEvents.length,
      },
    };
  } catch (err) {
    proc.kill();

    // P3-2 FIX: 对 Python Skill 执行异常进行错误类型分类，方便运维定位
    const errMsg = (err as Error)?.message ?? String(err);
    let errorCategory = "process_error";
    if (/timeout|timed out|ETIMEDOUT/i.test(errMsg)) {
      errorCategory = "timeout";
    } else if (/ENOMEM|out of memory|MemoryError|killed/i.test(errMsg)) {
      errorCategory = "oom";
    } else if (/ModuleNotFoundError|ImportError|No module named/i.test(errMsg)) {
      errorCategory = "import_error";
    } else if (/SyntaxError|IndentationError/i.test(errMsg)) {
      errorCategory = "syntax_error";
    } else if (/PermissionError|EACCES/i.test(errMsg)) {
      errorCategory = "permission_error";
    } else if (/ECONNREFUSED|ENOTFOUND|fetch failed|NetworkError/i.test(errMsg)) {
      errorCategory = "network_error";
    } else if (/ENOENT|FileNotFoundError/i.test(errMsg)) {
      errorCategory = "file_not_found";
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
        runtime: "python",
      },
    };
  }
}
