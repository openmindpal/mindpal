/**
 * 本地 Skill 子进程隔离执行沙箱
 * IPC 协议对齐云端 Runner (executeSkill.ts)
 * @layer localSkill
 */
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export interface SkillExecuteRequest {
  type: "execute";
  toolRef: string;
  input: Record<string, unknown>;
  entryPath: string;
  limits?: { maxExecutionTimeMs?: number; maxMemoryMb?: number };
  context?: { locale?: string };
}

export interface SkillExecuteResult {
  type: "result";
  ok: boolean;
  output?: unknown;
  error?: { message: string; code?: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** 获取 childEntry 脚本路径（兼容 ts/js） */
function resolveChildEntryPath(): string {
  const base = path.resolve(__dirname, "childEntry");
  // 优先找 .js（编译后），其次 .ts（开发时通过 tsx 运行）
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  if (fs.existsSync(`${base}.ts`)) return `${base}.ts`;
  // fallback：无扩展名，让 node 自行解析
  return base;
}

/**
 * 在隔离子进程中执行 Skill。
 * fork childEntry → 发 execute 消息 → 等待 result → 超时/崩溃处理
 */
export async function executeSkillInProcess(
  request: Omit<SkillExecuteRequest, "type">,
): Promise<SkillExecuteResult> {
  const childEntryPath = resolveChildEntryPath();
  const timeoutMs = request.limits?.maxExecutionTimeMs ?? DEFAULT_TIMEOUT_MS;

  // 构建 fork execArgv
  const execArgv: string[] = [];
  if (request.limits?.maxMemoryMb && request.limits.maxMemoryMb > 0) {
    execArgv.push(`--max-old-space-size=${request.limits.maxMemoryMb}`);
  }

  // 如果 childEntry 是 .ts 文件，通过 tsx 运行
  if (childEntryPath.endsWith(".ts")) {
    execArgv.push("--import", "tsx");
  }

  // 精简环境变量：仅传递必要的 PATH 和 NODE_ENV
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };

  const child: ChildProcess = fork(childEntryPath, [], {
    execArgv,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  return new Promise<SkillExecuteResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      child.removeAllListeners("message");
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
    };

    const settle = (result: SkillExecuteResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      // 确保子进程被清理
      try { if (child.pid != null && !child.killed) child.kill(); } catch { /* ignore */ }
      resolve(result);
    };

    const fail = (message: string, code: string) => {
      settle({ type: "result", ok: false, error: { message, code } });
    };

    // 超时控制
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      fail(`skill execution timed out after ${timeoutMs}ms`, "TIMEOUT");
    }, timeoutMs);

    // 子进程 IPC 消息
    child.on("message", (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;
      if (m.type === "heartbeat") return; // 忽略心跳
      if (m.type !== "result") return;
      settle(m as unknown as SkillExecuteResult);
    });

    // 子进程退出
    child.on("exit", (code) => {
      fail(`skill process exited with code ${code ?? "null"}`, "PROCESS_EXITED");
    });

    // 子进程 fork 错误
    child.on("error", (err) => {
      fail(err?.message ?? "skill_process_error", "PROCESS_ERROR");
    });

    // 发送执行指令
    child.send({ type: "execute", ...request });
  });
}
