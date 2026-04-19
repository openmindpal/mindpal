/**
 * skillSandbox.ts — Skill 沙箱基线模块
 *
 * 统一 Worker 与 Runner 的沙箱安全策略，确保拦截行为一致。
 * 包含：模块封禁列表、动态代码执行锁定、沙箱模式解析、入口提取。
 *
 * @module @openslin/shared/skillSandbox
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SandboxMode = "strict" | "compat";

// ─────────────────────────────────────────────────────────────────────────────
// 风险等级
// ─────────────────────────────────────────────────────────────────────────────

export type RiskLevel = "high" | "medium" | "low";

// ─────────────────────────────────────────────────────────────────────────────
// 按风险等级分类的封禁模块
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 高危模块 — 进程/系统级，可直接逃逸沙箱或执行任意命令
 */
export const SANDBOX_BLOCKED_HIGH_RISK = [
  "child_process",  // 子进程创建（可执行任意命令）
  "cluster",        // 集群进程 fork
  "worker_threads", // 工作线程（可绕过沙箱）
  "vm",             // V8 虚拟机（可逃逸沙箱）
  "v8",             // V8 引擎内部接口
  "process",        // 进程控制
] as const;

/**
 * 中危模块 — 网络/文件，可绕过 NetworkPolicy 或泄露数据
 */
export const SANDBOX_BLOCKED_MEDIUM_RISK = [
  "dgram",  // UDP 套接字（绕过 NetworkPolicy）
  "net",    // TCP 套接字（绕过 NetworkPolicy）
  "tls",    // TLS 套接字
  "dns",    // DNS 查询（可用于数据外泄）
  "http2",  // HTTP/2 客户端（绕过出站控制）
] as const;

/**
 * 低危但需限制的模块 — 信息泄露/侧信道/调试接口
 */
export const SANDBOX_BLOCKED_LOW_RISK = [
  "os",                  // 操作系统信息泄露
  "perf_hooks",          // 性能计时（侧信道攻击）
  "trace_events",        // 追踪事件
  "inspector",           // 调试器接口
  "repl",                // REPL 交互式环境
  "async_hooks",         // 异步钩子（可监控系统行为）
  "diagnostics_channel", // 诊断通道
] as const;

/**
 * 全量封禁模块（去重、含 node: 前缀变体）
 * 合并高/中/低三个等级，同时保留向后兼容的 http/https 封禁
 */
function buildBlockedModulesArray(): readonly string[] {
  const bareNames = new Set<string>([
    ...SANDBOX_BLOCKED_HIGH_RISK,
    ...SANDBOX_BLOCKED_MEDIUM_RISK,
    ...SANDBOX_BLOCKED_LOW_RISK,
    // 向后兼容：http/https 由 NetworkPolicy 控制，但 BASE 已包含，继续封禁
    "http",
    "https",
  ]);
  const result: string[] = [];
  for (const m of bareNames) {
    result.push(m, `node:${m}`);
  }
  return Object.freeze(result);
}

/** 完整的沙箱模块黑名单（含 node: 前缀变体） */
export const SANDBOX_BLOCKED_MODULES: readonly string[] = buildBlockedModulesArray();

// ─────────────────────────────────────────────────────────────────────────────
// 风险等级查询
// ─────────────────────────────────────────────────────────────────────────────

const _riskMap = new Map<string, RiskLevel>();
for (const m of SANDBOX_BLOCKED_HIGH_RISK) _riskMap.set(m, "high");
for (const m of SANDBOX_BLOCKED_MEDIUM_RISK) _riskMap.set(m, "medium");
for (const m of SANDBOX_BLOCKED_LOW_RISK) _riskMap.set(m, "low");

/**
 * 获取模块的风险等级
 * @returns 风险等级或 undefined（如果不在黑名单中）
 */
export function getRiskLevel(moduleName: string): RiskLevel | undefined {
  const bare = moduleName.startsWith("node:") ? moduleName.slice(5) : moduleName;
  return _riskMap.get(bare);
}

// ─────────────────────────────────────────────────────────────────────────────
// 黑名单校验函数
// ─────────────────────────────────────────────────────────────────────────────

const _blockedSet = new Set<string>(SANDBOX_BLOCKED_MODULES);

/** 检查模块是否在黑名单中 */
export function isModuleBlocked(moduleName: string): boolean {
  const bare = moduleName.startsWith("node:") ? moduleName.slice(5) : moduleName;
  return _blockedSet.has(bare) || _blockedSet.has(`node:${bare}`);
}

/** 如果模块在黑名单中则抛出异常 */
export function assertModuleAllowed(moduleName: string): void {
  if (isModuleBlocked(moduleName)) {
    const bare = moduleName.startsWith("node:") ? moduleName.slice(5) : moduleName;
    throw new Error(`policy_violation:skill_forbidden_import:${bare}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 旧版模块封禁列表（向后兼容）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 基线封禁模块 — 所有沙箱模式下都禁止
 * @deprecated 使用 SANDBOX_BLOCKED_MODULES 代替
 */
export const SANDBOX_FORBIDDEN_MODULES_BASE = Object.freeze([
  "node:child_process",
  "child_process",
  "node:net",
  "net",
  "node:tls",
  "tls",
  "node:dns",
  "dns",
  "node:http",
  "http",
  "node:https",
  "https",
  "node:dgram",
  "dgram",
  // 新增高危模块
  "node:cluster",
  "cluster",
  "node:v8",
  "v8",
  "node:process",
  "process",
  "node:vm",
  "vm",
  "node:worker_threads",
  "worker_threads",
  // 新增中危模块
  "node:http2",
  "http2",
  // 新增低危模块
  "node:os",
  "os",
  "node:perf_hooks",
  "perf_hooks",
  "node:trace_events",
  "trace_events",
  "node:inspector",
  "inspector",
  "node:repl",
  "repl",
  "node:async_hooks",
  "async_hooks",
  "node:diagnostics_channel",
  "diagnostics_channel",
] as const);

/**
 * 严格模式额外封禁模块 — 仅 strict 模式下禁止
 * @deprecated 使用 SANDBOX_BLOCKED_MODULES 代替（所有模块在所有模式下均封禁）
 */
export const SANDBOX_FORBIDDEN_MODULES_STRICT = Object.freeze([
  "node:fs",
  "fs",
  "node:fs/promises",
  "fs/promises",
] as const);

/**
 * 数据库模块封禁列表 — Worker 侧额外禁止
 * 防止 Skill 直接访问数据库
 */
export const SANDBOX_FORBIDDEN_MODULES_DATABASE = Object.freeze([
  "pg",
  "mysql",
  "mysql2",
  "sqlite3",
  "better-sqlite3",
  "mongodb",
  "oracledb",
  "mssql",
  "redis",
  "ioredis",
] as const);

// ─────────────────────────────────────────────────────────────────────────────
// 沙箱模式解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析沙箱模式
 * @param env 环境变量（默认 process.env）
 * @returns "strict" | "compat"
 */
export function resolveSandboxMode(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): SandboxMode {
  const raw = String(env.SKILL_SANDBOX_MODE ?? "").trim().toLowerCase();
  if (raw === "strict") return "strict";
  if (raw === "compat") return "compat";
  // 生产环境默认 strict，开发环境默认 compat
  return (env.NODE_ENV ?? "development") === "production" ? "strict" : "compat";
}

/**
 * 构建封禁模块集合
 * @param mode 沙箱模式
 * @param extras 额外封禁模块列表（如数据库模块）
 * @returns 封禁模块集合
 */
export function buildForbiddenModulesSet(
  mode: SandboxMode,
  extras: readonly string[] = [],
): Set<string> {
  const set = new Set<string>(SANDBOX_FORBIDDEN_MODULES_BASE);
  if (mode === "strict") {
    for (const m of SANDBOX_FORBIDDEN_MODULES_STRICT) {
      set.add(m);
    }
  }
  for (const m of extras) {
    set.add(m);
  }
  return set;
}

// ─────────────────────────────────────────────────────────────────────────────
// 动态代码执行锁定
// ─────────────────────────────────────────────────────────────────────────────

export interface DynamicCodeLockState {
  origEval: typeof eval;
  origFunction: FunctionConstructor;
}

/**
 * 封禁动态代码执行能力 — 防止 Skill 通过 eval/Function 绕过沙箱
 * @returns 保存的原始引用，用于恢复
 */
export function lockdownDynamicCodeExecution(): DynamicCodeLockState {
  const origEval = globalThis.eval;
  const origFunction = globalThis.Function;
  const blocker = (..._args: unknown[]): never => {
    throw new Error("policy_violation:skill_dynamic_code_execution_blocked");
  };
  (globalThis as Record<string, unknown>).eval = blocker;
  (globalThis as Record<string, unknown>).Function = new Proxy(origFunction, {
    construct(_t, _args): never {
      throw new Error("policy_violation:skill_dynamic_code_execution_blocked");
    },
    apply(_t, _thisArg, _args): never {
      throw new Error("policy_violation:skill_dynamic_code_execution_blocked");
    },
  });
  return { origEval, origFunction };
}

/**
 * 恢复动态代码执行能力
 * @param saved lockdownDynamicCodeExecution 返回的状态
 */
export function restoreDynamicCodeExecution(saved: DynamicCodeLockState): void {
  (globalThis as Record<string, unknown>).eval = saved.origEval;
  (globalThis as Record<string, unknown>).Function = saved.origFunction;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill 入口提取
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从模块中提取 execute 函数
 * 支持以下导出形式：
 * - export function execute(req)
 * - export default { execute(req) }
 * - export default function(req)
 *
 * @param mod 模块对象
 * @returns execute 函数或 null
 */
export function pickExecute(mod: unknown): ((req: unknown) => Promise<unknown>) | null {
  if (!mod || typeof mod !== "object") return null;
  const m = mod as Record<string, unknown>;

  // 直接导出 execute
  if (typeof m.execute === "function") {
    return m.execute as (req: unknown) => Promise<unknown>;
  }

  // default 导出包含 execute
  if (m.default && typeof m.default === "object") {
    const def = m.default as Record<string, unknown>;
    if (typeof def.execute === "function") {
      return def.execute as (req: unknown) => Promise<unknown>;
    }
  }

  // default 直接是函数
  if (typeof m.default === "function") {
    return m.default as (req: unknown) => Promise<unknown>;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 模块拦截检查
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 检查模块是否被封禁
 * @param moduleName 模块名
 * @param forbiddenSet 封禁模块集合
 * @returns { forbidden: true, baseName } 或 { forbidden: false }
 */
export function checkModuleForbidden(
  moduleName: string,
  forbiddenSet: Set<string>,
): { forbidden: true; baseName: string } | { forbidden: false } {
  const req = String(moduleName ?? "");
  if (!req) return { forbidden: false };

  // 统一生成两种变体：带 node: 前缀和不带前缀
  const bare = req.startsWith("node:") ? req.slice(5) : req;
  const prefixed = `node:${bare}`;

  if (forbiddenSet.has(bare) || forbiddenSet.has(prefixed)) {
    return { forbidden: true, baseName: bare };
  }
  return { forbidden: false };
}

/**
 * 创建模块加载拦截器
 * @param origLoad 原始 Module._load
 * @param forbiddenSet 封禁模块集合
 * @returns 拦截后的 _load 函数
 */
export function createModuleLoadInterceptor(
  origLoad: (request: string, parent: unknown, isMain: boolean) => unknown,
  forbiddenSet: Set<string>,
): (request: string, parent: unknown, isMain: boolean) => unknown {
  return function interceptedLoad(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    const check = checkModuleForbidden(request, forbiddenSet);
    if (check.forbidden) {
      throw new Error(`policy_violation:skill_forbidden_import:${check.baseName}`);
    }
    return origLoad.call(this, request, parent, isMain);
  };
}
