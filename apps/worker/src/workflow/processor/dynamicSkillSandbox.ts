/**
 * dynamicSkillSandbox.ts — Worker 侧 Skill 沙箱执行
 *
 * 使用 @openslin/shared 的统一 SkillProcessPool 进行进程管理和 IPC 通信，
 * 消除原先内联的 child_process.fork() 逻辑。
 *
 * Worker 专属逻辑：结果适配为 DynamicSkillExecResult 格式。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { SkillProcessPool, classifyError } from "@openslin/shared";
import type { RuntimeLimits, NetworkPolicy } from "./runtime";
import type { DynamicSkillExecResult } from "./dynamicSkillTypes";

/* ── 解析 Worker 侧 skillSandboxChild 路径 ──────────────── */
let _childEntryCache: { entry: string; execArgv: string[] } | null = null;

async function resolveSandboxChildEntry() {
  if (_childEntryCache) return _childEntryCache;
  const jsPath = path.resolve(__dirname, "..", "skillSandboxChild.js");
  try {
    const st = await fs.stat(jsPath);
    if (st.isFile()) {
      _childEntryCache = { entry: jsPath, execArgv: [] };
      return _childEntryCache;
    }
  } catch {}
  const tsPath = path.resolve(__dirname, "..", "skillSandboxChild.ts");
  _childEntryCache = { entry: tsPath, execArgv: ["-r", "tsx/cjs"] };
  return _childEntryCache;
}

/* ── 延迟初始化的进程池单例 ──────────────────────────────── */
let _pool: SkillProcessPool | null = null;

async function getPool(): Promise<SkillProcessPool> {
  if (_pool) return _pool;
  const childInfo = await resolveSandboxChildEntry();
  _pool = new SkillProcessPool({
    maxProcesses: 2,
    childScriptPath: childInfo.entry,
    childExecArgv: childInfo.execArgv,
  });
  return _pool;
}

export async function executeDynamicSkillSandboxed(params: {
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
  signal: AbortSignal;
  context?: { locale: string; apiBaseUrl?: string; authToken?: string };
}): Promise<DynamicSkillExecResult> {
  const pool = await getPool();
  const { child, _poolEntry } = await pool.acquire({ memoryMb: params.limits.memoryMb ?? undefined });

  const kill = () => { pool.discard(child); };
  if (params.signal.aborted) kill();
  params.signal.addEventListener("abort", kill, { once: true });

  // Heartbeat monitoring (inherited from shared pool)
  pool.startHeartbeat(child);

  const result = await new Promise<any>((resolve, reject) => {
    const onExit = (code: number | null) => {
      const c = typeof code === "number" ? code : null;
      if (c === 134 || c === 137) {
        reject(new Error("resource_exhausted:memory"));
        return;
      }
      reject(new Error(`skill_sandbox_exited:${code ?? "null"}`));
    };
    const onMessage = (m: any) => {
      if (!m || typeof m !== "object") return;
      if (m.type !== "result") return;
      child.off("exit", onExit);
      child.off("message", onMessage);
      resolve(m);
    };
    child.on("exit", onExit);
    child.on("message", onMessage);
    child.send({
      type: "execute",
      payload: {
        toolRef: params.toolRef,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        subjectId: params.subjectId,
        traceId: params.traceId,
        idempotencyKey: params.idempotencyKey,
        input: params.input,
        limits: params.limits,
        networkPolicy: params.networkPolicy,
        artifactRef: params.artifactRef,
        depsDigest: params.depsDigest,
        entryPath: params.entryPath,
        context: params.context,
      },
    });
  }).finally(() => {
    params.signal.removeEventListener("abort", kill);
    if (child.pid != null) pool.stopHeartbeat(child.pid);
    // Worker: release back to pool on success, discard handled below on error
  });

  // Release or discard process
  if (!result?.ok) {
    pool.discard(child);
  } else {
    pool.release(child, _poolEntry);
  }

  if (!result?.ok) {
    const msg = String(result?.error?.message ?? "skill_sandbox_error");
    throw classifyError(new Error(msg));
  }
  return {
    output: result.output,
    egress: Array.isArray(result.egress) ? result.egress : [],
    depsDigest: String(result.depsDigest ?? params.depsDigest),
    runtimeBackend: "process",
    degraded: false,
  };
}
