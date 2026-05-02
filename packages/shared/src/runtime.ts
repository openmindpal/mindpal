/**
 * runtime.ts — 统一运行时工具模块
 *
 * 合并自 Worker 与 Runner 的重复实现，作为 Skill 执行的共享基线。
 * 包含：类型定义、网络策略、出站检查、资源限制、并发/超时控制。
 *
 * @module @mindpal/shared/runtime
 */

import { resolveNumber } from "./runtimeConfig";

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * 将未知输入归一化为 Set<string>
 * 支持 Set / Array / 逗号分隔字符串
 * @param value 原始输入
 * @param fallbackCsv 当 value 为 null/undefined 时的默认逗号字符串
 */
export function normalizeStringSet(value: unknown, fallbackCsv: string): Set<string> {
  if (value instanceof Set) return new Set(Array.from(value).map((x) => String(x).trim()).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map((x) => String(x).trim()).filter(Boolean));
  const raw = String(value ?? fallbackCsv);
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 运行时资源限制 */
export type RuntimeLimits = {
  timeoutMs: number;
  maxConcurrency: number;
  memoryMb: number | null;
  cpuMs: number | null;
  maxOutputBytes: number;
  maxEgressRequests: number;
};

/** 网络策略规则 */
export type NetworkPolicyRule = {
  host: string;
  pathPrefix?: string;
  methods?: string[];
};

/** 网络策略 */
export type NetworkPolicy = {
  allowedDomains: string[];
  rules: NetworkPolicyRule[];
};

/** 出站事件记录 */
export type EgressEvent = {
  host: string;
  method: string;
  allowed: boolean;
  policyMatch?: { kind: "allowedDomain" | "rule"; rulePathPrefix?: string; ruleMethods?: string[] };
  status?: number;
  errorCategory?: string;
};

/** 出站检查结果 */
export type EgressCheck =
  | { allowed: true; host: string; method: string; reason: null; match: { kind: "allowedDomain" | "rule"; rulePathPrefix?: string; ruleMethods?: string[] } }
  | { allowed: false; host: string; method: string; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// 归一化函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 归一化运行时资源限制
 * @param v 原始输入
 * @returns 归一化后的 RuntimeLimits
 */
export function normalizeLimits(v: unknown): RuntimeLimits {
  const obj = isPlainObject(v) ? v : {};
  const timeoutMs =
    typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0
      ? obj.timeoutMs
      : resolveNumber("SKILL_EXECUTION_TIMEOUT_MS", undefined, undefined, 10_000).value;
  const maxConcurrency =
    typeof obj.maxConcurrency === "number" && Number.isFinite(obj.maxConcurrency) && obj.maxConcurrency > 0
      ? obj.maxConcurrency
      : resolveNumber("SKILL_MAX_CONCURRENCY", undefined, undefined, 10).value;
  const memoryMbRaw = typeof obj.memoryMb === "number" && Number.isFinite(obj.memoryMb) ? obj.memoryMb : null;
  const memoryMb = memoryMbRaw === null ? null : Math.max(32, Math.min(8192, Math.round(memoryMbRaw)));
  const cpuMsRaw = typeof obj.cpuMs === "number" && Number.isFinite(obj.cpuMs) ? obj.cpuMs : null;
  const cpuMs = cpuMsRaw === null ? null : Math.max(50, Math.min(10_000, Math.round(cpuMsRaw)));
  const maxOutputBytesRaw =
    typeof obj.maxOutputBytes === "number" && Number.isFinite(obj.maxOutputBytes) ? obj.maxOutputBytes : null;
  const maxOutputBytes =
    maxOutputBytesRaw === null ? resolveNumber("SKILL_MAX_OUTPUT_BYTES", undefined, undefined, 1_000_000).value : Math.max(1_000, Math.min(20_000_000, Math.round(maxOutputBytesRaw)));
  const maxEgressRequestsRaw =
    typeof obj.maxEgressRequests === "number" && Number.isFinite(obj.maxEgressRequests) ? obj.maxEgressRequests : null;
  const maxEgressRequests =
    maxEgressRequestsRaw === null ? resolveNumber("SKILL_MAX_EGRESS_REQUESTS", undefined, undefined, 50).value : Math.max(0, Math.min(1000, Math.round(maxEgressRequestsRaw)));
  return { timeoutMs, maxConcurrency, memoryMb, cpuMs, maxOutputBytes, maxEgressRequests };
}

/**
 * 归一化网络策略
 * @param v 原始输入
 * @returns 归一化后的 NetworkPolicy
 */
export function normalizeNetworkPolicy(v: unknown): NetworkPolicy {
  const obj = isPlainObject(v) ? v : {};
  const allowedDomains = Array.isArray(obj.allowedDomains)
    ? (obj.allowedDomains as unknown[])
        .filter((x) => typeof x === "string" && (x as string).trim())
        .map((x) => (x as string).trim().toLowerCase())
        .filter((x: string) => Boolean(x) && !x.includes("://") && !x.includes("/") && !x.includes(":"))
    : [];
  const rulesRaw = Array.isArray((obj as Record<string, unknown>).rules) ? (obj as Record<string, unknown>).rules : [];
  const rules = (rulesRaw as unknown[])
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x))
    .map((x) => {
      const host0 = typeof x.host === "string" ? x.host.trim().toLowerCase() : "";
      const host = host0 && !host0.includes("://") && !host0.includes("/") && !host0.includes(":") ? host0 : "";
      if (!host) return null;
      const pathPrefix0 = typeof x.pathPrefix === "string" ? x.pathPrefix.trim() : "";
      const pathPrefix = pathPrefix0 ? (pathPrefix0.startsWith("/") ? pathPrefix0 : `/${pathPrefix0}`) : undefined;
      const methods0 = Array.isArray(x.methods)
        ? (x.methods as unknown[]).filter((m): m is string => typeof m === "string" && m.trim() !== "")
        : undefined;
      const methods = methods0?.length ? methods0.map((m: string) => m.trim().toUpperCase()) : undefined;
      return { host, pathPrefix, methods } as NetworkPolicyRule;
    })
    .filter((x): x is NetworkPolicyRule => x !== null);
  return { allowedDomains, rules };
}

// ─────────────────────────────────────────────────────────────────────────────
// 出站检查
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 检查域名是否在允许列表中
 */
export function isAllowedHost(allowedDomains: string[], host: string): boolean {
  const h = host.toLowerCase();
  return allowedDomains.some((d) => {
    const dl = d.toLowerCase();
    // 支持通配符 "*" 允许所有域名
    if (dl === "*") return true;
    // 支持通配符前缀如 "*.example.com"
    if (dl.startsWith("*.") && h.endsWith(dl.slice(1))) return true;
    // 精确匹配
    return dl === h;
  });
}

/**
 * 检查出站请求是否被策略允许
 * @param params 检查参数
 * @returns 检查结果
 */
export function isAllowedEgress(params: { policy: NetworkPolicy; url: string; method: string }): EgressCheck {
  const method = params.method.toUpperCase();
  let host = "";
  let pathName = "";
  let protocol = "";
  try {
    const u = new URL(params.url);
    protocol = u.protocol;
    host = u.hostname.toLowerCase();
    pathName = u.pathname || "/";
  } catch {
    return { allowed: false, host: "", method, reason: "policy_violation:egress_invalid_url" };
  }
  if (protocol !== "http:" && protocol !== "https:") {
    return { allowed: false, host, method, reason: `policy_violation:egress_invalid_protocol:${protocol.replace(":", "")}` };
  }
  const allowedByDomain = isAllowedHost(params.policy.allowedDomains, host);
  if (allowedByDomain) return { allowed: true, host, method, reason: null, match: { kind: "allowedDomain" } };
  const rules = params.policy.rules ?? [];
  for (const r of rules) {
    if (String(r.host).toLowerCase() !== host.toLowerCase()) continue;
    if (r.pathPrefix && !pathName.startsWith(r.pathPrefix)) continue;
    if (r.methods && r.methods.length && !r.methods.includes(method)) continue;
    return { allowed: true, host, method, reason: null, match: { kind: "rule", rulePathPrefix: r.pathPrefix, ruleMethods: r.methods } };
  }
  return { allowed: false, host, method, reason: `policy_violation:egress_denied:${host}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行时控制
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 并发计数器 — 可插拔后端
 *
 * 默认使用进程内 Map（单实例模式）。
 * 通过 setConcurrencyBackend() 注入 Redis 后端可实现多实例全局计数。
 * 环境变量 CONCURRENCY_BACKEND=redis 时，调用者应在启动时注入 Redis 后端。
 * Redis 不可用时自动降级到进程级计数。
 */
const localCounters = new Map<string, number>();

/** 可插拔并发计数后端接口 */
export interface ConcurrencyBackend {
  /** 原子递增，返回递增后的值 */
  increment(key: string): Promise<number>;
  /** 原子递减 */
  decrement(key: string): Promise<void>;
}

let _concurrencyBackend: ConcurrencyBackend | null = null;

/** 注入 Redis 或其他分布式计数后端 */
export function setConcurrencyBackend(backend: ConcurrencyBackend | null): void {
  _concurrencyBackend = backend;
}

/** 获取当前后端（用于测试/调试） */
export function getConcurrencyBackend(): ConcurrencyBackend | null {
  return _concurrencyBackend;
}

/**
 * 创建基于 Redis INCR/DECR 的并发后端。
 * @param redis 需要支持 incr / decr / expire 命令的 Redis client
 * @param ttlSeconds key 自动过期秒数（防泄漏），默认 300
 */
export function createRedisConcurrencyBackend(
  redis: { incr(key: string): Promise<number>; decr(key: string): Promise<number>; expire(key: string, seconds: number): Promise<number> },
  ttlSeconds = 300,
): ConcurrencyBackend {
  const prefix = "concurrency:";
  return {
    async increment(key: string): Promise<number> {
      const rk = prefix + key;
      const val = await redis.incr(rk);
      // 首次创建时设置 TTL 防泄漏
      if (val === 1) await redis.expire(rk, ttlSeconds).catch(() => {});
      return val;
    },
    async decrement(key: string): Promise<void> {
      const rk = prefix + key;
      await redis.decr(rk).catch(() => {});
    },
  };
}

/**
 * 带出站检查的 fetch 包装
 */
export async function runtimeFetch(params: {
  url: string;
  method?: string;
  networkPolicy: NetworkPolicy;
  signal: AbortSignal;
  egress: EgressEvent[];
  maxEgressRequests: number;
}): Promise<Response> {
  if (params.maxEgressRequests >= 0 && params.egress.length >= params.maxEgressRequests) {
    throw new Error("resource_exhausted:max_egress_requests");
  }
  const method = (params.method ?? "GET").toUpperCase();
  const check = isAllowedEgress({ policy: params.networkPolicy, url: params.url, method });
  if (!check.allowed) {
    params.egress.push({ host: check.host, method: check.method, allowed: false, errorCategory: "policy_violation" });
    throw new Error(check.reason ?? "policy_violation:egress_denied");
  }

  const res = await fetch(params.url, { method, signal: params.signal });
  params.egress.push({ host: check.host, method: check.method, allowed: true, policyMatch: check.match, status: res.status });
  return res;
}

/**
 * 并发控制包装器
 *
 * 优先使用注入的分布式后端（Redis），Redis 失败时自动降级到进程级计数。
 * @param key 并发键
 * @param maxConcurrency 最大并发数
 * @param fn 要执行的函数
 */
export async function withConcurrency<T>(key: string, maxConcurrency: number, fn: () => Promise<T>): Promise<T> {
  const backend = _concurrencyBackend;

  // ── 分布式后端路径 ──
  if (backend) {
    let current: number;
    try {
      current = await backend.increment(key);
    } catch {
      // Redis increment 本身失败 → 降级到进程级 fallback（下方）
      return withConcurrencyLocal(key, maxConcurrency, fn);
    }
    if (current > maxConcurrency) {
      await backend.decrement(key).catch(() => {});
      throw new Error("resource_exhausted:max_concurrency");
    }
    try {
      return await fn();
    } finally {
      await backend.decrement(key).catch(() => {});
    }
  }

  // ── 进程级 fallback ──
  return withConcurrencyLocal(key, maxConcurrency, fn);
}

/** 进程级并发控制（内部辅助） */
async function withConcurrencyLocal<T>(key: string, maxConcurrency: number, fn: () => Promise<T>): Promise<T> {
  const current = localCounters.get(key) ?? 0;
  if (current >= maxConcurrency) throw new Error("resource_exhausted:max_concurrency");
  localCounters.set(key, current + 1);
  try {
    return await fn();
  } finally {
    const after = (localCounters.get(key) ?? 1) - 1;
    if (after <= 0) localCounters.delete(key);
    else localCounters.set(key, after);
  }
}

/**
 * 超时控制包装器
 * @param timeoutMs 超时时间（毫秒）
 * @param fn 要执行的函数
 */
export async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let t: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    t = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (t !== undefined) clearTimeout(t);
  }
}
