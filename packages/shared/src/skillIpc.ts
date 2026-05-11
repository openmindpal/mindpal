/**
 * skillIpc.ts — Skill 沙箱 IPC 协议与运行入口
 *
 * 包含：IPC 消息类型定义、API Fetch 构建器、出站策略拦截、
 * Skill 入口执行流程（Worker/Runner 公共主流程）。
 *
 * @module @mindpal/shared/skillIpc
 */
import Module from "node:module";
import { isAllowedEgress, normalizeNetworkPolicy } from "./runtime";
import type { EgressEvent, NetworkPolicy } from "./runtime";
import { buildForbiddenModulesSet, createModuleLoadInterceptor, lockdownDynamicCodeExecution, restoreDynamicCodeExecution, pickExecute, resolveSandboxMode } from "./skillSandbox";
import type { SandboxMode, DynamicCodeLockState } from "./skillSandbox";

/** Node.js Module internal API (undocumented but stable across versions) */
interface NodeModuleInternal {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _extensions?: Record<string, (...args: unknown[]) => void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox Child — 公共 IPC 类型与工具函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IPC 消息：父进程 → 子进程（执行命令）
 */
export interface SandboxIpcExecuteMessage {
  type: "execute";
  payload: SandboxIpcPayload;
}

/**
 * IPC 消息：心跳 ping
 */
export interface SandboxIpcHeartbeatMessage {
  type: "heartbeat";
}

/**
 * IPC 消息：心跳 ack
 */
export interface SandboxIpcHeartbeatAck {
  type: "heartbeat_ack";
  ts: number;
}

/**
 * IPC 载荷（execute 命令的 payload）
 */
export interface SandboxIpcPayload {
  toolRef?: string;
  tenantId?: string;
  spaceId?: string;
  subjectId?: string;
  traceId?: string;
  idempotencyKey?: string;
  input?: Record<string, unknown>;
  limits?: { maxEgressRequests?: number; [k: string]: unknown };
  networkPolicy?: unknown;
  artifactRef?: string;
  depsDigest?: string;
  entryPath?: string;
  context?: { locale?: string; apiBaseUrl?: string; authToken?: string };
  cpuTimeLimitMs?: number;
}

/**
 * IPC 结果消息：子进程 → 父进程
 */
export interface SandboxIpcResultMessage {
  type: "result";
  ok: boolean;
  output?: Record<string, unknown>;
  error?: { message: string };
  depsDigest?: string;
  egress?: unknown[];
}

export type SandboxIpcMessage = SandboxIpcExecuteMessage | SandboxIpcHeartbeatMessage;

// ─────────────────────────────────────────────────────────────────────────────
// buildApiFetch — 统一的 API 请求构造函数
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiFetchContext {
  apiBaseUrl?: string;
  authToken?: string;
  traceId?: string;
}

/**
 * 构建一个预配置的 API Fetch 函数，用于 Skill 内部调用平台 API
 */
export function buildApiFetch(ctx: ApiFetchContext): (path: string, init?: RequestInit) => Promise<Response> {
  const baseUrl = ctx.apiBaseUrl || process.env.API_BASE_URL || "http://localhost:4000";
  return async (urlPath: string, init?: RequestInit): Promise<Response> => {
    const url = urlPath.startsWith("http") ? urlPath : `${baseUrl}${urlPath}`;
    const headers = new Headers(init?.headers);
    if (ctx.authToken) headers.set("authorization", `Bearer ${ctx.authToken}`);
    if (ctx.traceId) headers.set("x-trace-id", ctx.traceId);
    return fetch(url, { ...init, headers });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createEgressWrappedFetch — 出站网络策略拦截 + 事件收集
// ─────────────────────────────────────────────────────────────────────────────

export interface EgressWrappedFetchOptions {
  originalFetch: typeof globalThis.fetch;
  networkPolicy: NetworkPolicy;
  egressCollector: EgressEvent[];
  maxEgressRequests?: number | null;
}

/**
 * 创建出站策略拦截 fetch — 收集 egress 事件并执行 NetworkPolicy 检查
 */
export function createEgressWrappedFetch(opts: EgressWrappedFetchOptions): typeof globalThis.fetch {
  const { originalFetch, networkPolicy, egressCollector, maxEgressRequests } = opts;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (maxEgressRequests !== null && maxEgressRequests !== undefined && egressCollector.length >= maxEgressRequests) {
      throw new Error("resource_exhausted:max_egress_requests");
    }
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input?.url ?? "");
    const method = String(init?.method ?? (input as Request)?.method ?? "GET").toUpperCase();
    const chk = isAllowedEgress({ policy: networkPolicy, url, method });
    if (!chk.allowed) {
      egressCollector.push({ host: chk.host, method: chk.method, allowed: false, errorCategory: "policy_violation" });
      throw new Error(chk.reason ?? "policy_violation:egress_denied");
    }
    const res = await originalFetch(input, init);
    egressCollector.push({ host: chk.host, method: chk.method, allowed: true, policyMatch: chk.match, status: res?.status });
    return res;
  }) as typeof globalThis.fetch;
}

// ─────────────────────────────────────────────────────────────────────────────
// runSkillEntry — 沙箱内加载并执行 Skill 入口的公共流程
// ─────────────────────────────────────────────────────────────────────────────

export interface RunSkillEntryOptions {
  payload: SandboxIpcPayload;
  /** 额外封禁模块（如数据库模块） */
  extraForbiddenModules?: readonly string[];
  /** 沙箱模式覆盖（默认从环境变量解析） */
  sandboxMode?: SandboxMode;
  /** 是否锁定动态代码执行（默认 false，Runner 侧为 true） */
  lockdownDynamicCode?: boolean;
}

export interface RunSkillEntryResult {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: { message: string };
  depsDigest?: string;
  egress: EgressEvent[];
}

/**
 * 在当前进程/线程内执行 Skill 入口 —— Worker 和 Runner 的公共主流程。
 *
 * 包含：模块拦截安装、出站 fetch 包装、context 构建、Skill 执行、结果格式化。
 */
export async function runSkillEntry(opts: RunSkillEntryOptions): Promise<RunSkillEntryResult> {
  const { payload, extraForbiddenModules = [], lockdownDynamicCode: lockDynamic = false } = opts;
  const egress: EgressEvent[] = [];
  const networkPolicy = normalizeNetworkPolicy(payload?.networkPolicy);
  const originalFetch = globalThis.fetch;
  const mode = opts.sandboxMode ?? resolveSandboxMode();
  const denied = buildForbiddenModulesSet(mode, extraForbiddenModules);

  const ModuleInternal = Module as unknown as NodeModuleInternal;
  const origLoad = ModuleInternal._load;
  const origNodeExt = ModuleInternal._extensions?.[".node"];

  let dynamicCodeState: DynamicCodeLockState | null = null;
  if (lockDynamic) {
    dynamicCodeState = lockdownDynamicCodeExecution();
  }

  const maxEgressRequests =
    typeof payload?.limits?.maxEgressRequests === "number" && Number.isFinite(payload.limits.maxEgressRequests)
      ? Math.max(0, Math.round(payload.limits.maxEgressRequests))
      : null;

  const wrappedFetch = createEgressWrappedFetch({
    originalFetch,
    networkPolicy,
    egressCollector: egress,
    maxEgressRequests,
  });

  try {
    if (typeof originalFetch !== "function") throw new Error("skill_sandbox_missing_fetch");
    globalThis.fetch = wrappedFetch;

    ModuleInternal._load = createModuleLoadInterceptor(origLoad, denied) as typeof ModuleInternal._load;
    if (ModuleInternal._extensions) {
      ModuleInternal._extensions[".node"] = function () {
        throw new Error("policy_violation:skill_native_addon_not_allowed");
      };
    }

    const entryPath = String(payload.entryPath ?? "");
    if (!entryPath) throw new Error("skill_sandbox_missing_entry_path");
    const req = Module.createRequire(entryPath);
    const mod = req(entryPath);
    const exec = pickExecute(mod);
    if (!exec) throw new Error("policy_violation:skill_missing_execute");

    const context = payload.context
      ? { locale: payload.context.locale, apiFetch: buildApiFetch({ apiBaseUrl: payload.context.apiBaseUrl, authToken: payload.context.authToken, traceId: payload.traceId }) }
      : undefined;

    const output = await exec({
      toolRef: payload.toolRef,
      tenantId: payload.tenantId,
      spaceId: payload.spaceId,
      subjectId: payload.subjectId,
      traceId: payload.traceId,
      idempotencyKey: payload.idempotencyKey,
      input: payload.input,
      limits: payload.limits,
      networkPolicy: payload.networkPolicy,
      artifactRef: payload.artifactRef,
      depsDigest: payload.depsDigest,
      context,
    });

    return { ok: true, output: output as Record<string, unknown>, depsDigest: payload.depsDigest, egress };
  } catch (e: unknown) {
    const msg = String((e instanceof Error ? e.message : e) ?? "skill_sandbox_error");
    return { ok: false, error: { message: msg }, depsDigest: payload.depsDigest, egress };
  } finally {
    globalThis.fetch = originalFetch;
    ModuleInternal._load = origLoad;
    if (ModuleInternal._extensions) {
      ModuleInternal._extensions[".node"] = origNodeExt!;
    }
    if (dynamicCodeState) {
      restoreDynamicCodeExecution(dynamicCodeState);
    }
  }
}
