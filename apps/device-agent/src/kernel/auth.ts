/**
 * Device-OS 内核模块 #2：安全认证与策略下发
 *
 * 合并 accessControl + policyCache，统一：
 * - deviceToken 签名校验
 * - callerIdentity 验证
 * - 策略摘要/版本/缓存/失效
 * - 工具级权限控制
 * - 执行上下文隔离
 *
 * @layer kernel
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CallerIdentity, CachedPolicy, PolicyCacheEntry } from "./types";
import type { AuthProvider } from "@openslin/shared";
import { createHmacAuthProvider } from "../hmacAuthProvider";

// ══════════════════════════════════════════════════════════════
// 第一部分：调用方鉴权与执行上下文
// ══════════════════════════════════════════════════════════════

export type AccessPolicy = {
  allowedCallers?: string[];
  allowedTools?: string[];
  requireSignature?: boolean;
  maxContextAge?: number;
};

export type ExecutionContext = {
  contextId: string;
  callerId: string;
  createdAt: string;
  lastActiveAt: string;
  state: Map<string, unknown>;
  toolPermissions: Set<string>;
};

// ── 内部状态 ──────────────────────────────────────────────────

const _contexts = new Map<string, ExecutionContext>();
const _callerCache = new Map<string, CallerIdentity>();
let _policy: AccessPolicy = {};
let _secretKey: string = "";

// ── 初始化 ────────────────────────────────────────────────────

export function initAccessControl(params: { secretKey?: string; policy?: AccessPolicy }): void {
  _secretKey = params.secretKey ?? process.env.DEVICE_AGENT_SECRET_KEY ?? "";
  _policy = params.policy ?? {};
}

export function getAccessPolicy(): AccessPolicy { return { ..._policy }; }

// ── Token 生成与验证 ──────────────────────────────────────────

export function generateCallerToken(params: {
  callerId: string;
  callerType: CallerIdentity["callerType"];
  tenantId?: string;
  subjectId?: string;
  expiresInMs?: number;
}): string {
  if (!_secretKey) throw new Error("device_agent_secret_key_required");
  const now = Date.now();
  const expiresAt = params.expiresInMs ? now + params.expiresInMs : now + 3600_000;
  const payload = { cid: params.callerId, ct: params.callerType, tid: params.tenantId ?? "", sid: params.subjectId ?? "", iat: now, exp: expiresAt };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", _secretKey).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

export function verifyCallerToken(token: string): CallerIdentity | null {
  if (!token || !_secretKey) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  const expectedSig = crypto.createHmac("sha256", _secretKey).update(payloadB64).digest("base64url");
  if (signature !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return {
      callerId: String(payload.cid ?? ""),
      callerType: ["api", "local", "plugin"].includes(payload.ct) ? payload.ct : "api",
      tenantId: payload.tid || undefined,
      subjectId: payload.sid || undefined,
      verifiedAt: new Date().toISOString(),
      expiresAt: payload.exp ? new Date(payload.exp).toISOString() : undefined,
    };
  } catch { return null; }
}

export function isCallerAllowed(callerId: string): boolean {
  if (!_policy.allowedCallers || _policy.allowedCallers.length === 0) return true;
  return _policy.allowedCallers.includes(callerId);
}

export function isToolAllowed(callerId: string, toolName: string): boolean {
  if (_policy.allowedTools && _policy.allowedTools.length > 0) {
    if (!_policy.allowedTools.includes(toolName)) return false;
  }
  const ctx = _contexts.get(callerId);
  if (ctx && ctx.toolPermissions.size > 0) return ctx.toolPermissions.has(toolName);
  return true;
}

export function extractCallerFromRequest(params: { authHeader?: string; deviceToken?: string }): CallerIdentity | null {
  if (params.authHeader?.startsWith("Bearer ")) {
    const identity = verifyCallerToken(params.authHeader.slice(7));
    if (identity) return identity;
  }
  if (params.deviceToken) {
    return {
      callerId: `device:${crypto.createHash("sha256").update(params.deviceToken).digest("hex").slice(0, 16)}`,
      callerType: "api",
      verifiedAt: new Date().toISOString(),
    };
  }
  return null;
}

// ── 执行上下文 ────────────────────────────────────────────────

export function getOrCreateContext(callerId: string, toolPermissions?: string[]): ExecutionContext {
  let ctx = _contexts.get(callerId);
  if (!ctx) {
    ctx = {
      contextId: crypto.randomBytes(16).toString("hex"),
      callerId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      state: new Map(),
      toolPermissions: new Set(toolPermissions ?? []),
    };
    _contexts.set(callerId, ctx);
  } else {
    ctx.lastActiveAt = new Date().toISOString();
    if (toolPermissions) ctx.toolPermissions = new Set(toolPermissions);
  }
  return ctx;
}

export function getContext(callerId: string): ExecutionContext | null { return _contexts.get(callerId) ?? null; }
export function destroyContext(callerId: string): boolean { return _contexts.delete(callerId); }

export function cleanupExpiredContexts(): number {
  const maxAge = _policy.maxContextAge ?? 3600_000;
  const cutoff = Date.now() - maxAge;
  let cleaned = 0;
  for (const [callerId, ctx] of _contexts.entries()) {
    if (new Date(ctx.lastActiveAt).getTime() < cutoff) { _contexts.delete(callerId); cleaned++; }
  }
  return cleaned;
}

export function getContextState<T>(callerId: string, key: string): T | undefined {
  return _contexts.get(callerId)?.state.get(key) as T | undefined;
}
export function setContextState(callerId: string, key: string, value: unknown): boolean {
  const ctx = _contexts.get(callerId);
  if (!ctx) return false;
  ctx.state.set(key, value);
  ctx.lastActiveAt = new Date().toISOString();
  return true;
}
export function deleteContextState(callerId: string, key: string): boolean {
  return _contexts.get(callerId)?.state.delete(key) ?? false;
}

export function getAccessStats() { return { activeContexts: _contexts.size, cachedCallers: _callerCache.size }; }

/** 获取基于当前 secretKey + policy 的统一 AuthProvider 实例 */
export function getAuthProvider(): AuthProvider {
  return createHmacAuthProvider(_secretKey, _policy);
}

// ══════════════════════════════════════════════════════════════
// 第二部分：策略缓存
// ══════════════════════════════════════════════════════════════

export type PolicyCacheConfig = {
  deviceId: string;
  cacheDir?: string;
  maxAgeMs?: number;
  enabled?: boolean;
};

let policyCacheConfig: PolicyCacheConfig | null = null;
let memoryPolicyCache: PolicyCacheEntry | null = null;
const DEFAULT_POLICY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function getPolicyCacheDir(): string {
  return policyCacheConfig?.cacheDir ?? path.join(os.homedir(), ".openslin", "cache");
}

function getPolicyCacheFilePath(): string {
  const deviceId = policyCacheConfig?.deviceId ?? "unknown";
  const safeId = deviceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getPolicyCacheDir(), `policy_${safeId}.json`);
}

function computePolicyDigest(policy: CachedPolicy): string {
  const sorted = JSON.stringify(policy, Object.keys(policy as any).sort());
  return crypto.createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

export async function initPolicyCache(config: PolicyCacheConfig): Promise<void> {
  policyCacheConfig = { ...config, maxAgeMs: config.maxAgeMs ?? DEFAULT_POLICY_MAX_AGE_MS, enabled: config.enabled ?? true };
  if (!policyCacheConfig.enabled) return;
  await fs.mkdir(getPolicyCacheDir(), { recursive: true });
  const cached = await loadPolicyFromDisk();
  if (cached) { memoryPolicyCache = cached; }
}

export async function cachePolicy(policy: CachedPolicy): Promise<PolicyCacheEntry> {
  if (!policyCacheConfig?.enabled) throw new Error("Policy cache not initialized or disabled");
  const now = new Date();
  const maxAge = policyCacheConfig.maxAgeMs ?? DEFAULT_POLICY_MAX_AGE_MS;
  const entry: PolicyCacheEntry = {
    deviceId: policyCacheConfig.deviceId,
    policy,
    policyDigest: computePolicyDigest(policy),
    cachedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + maxAge).toISOString(),
    version: (memoryPolicyCache?.version ?? 0) + 1,
  };
  await savePolicyToDisk(entry);
  memoryPolicyCache = entry;
  return entry;
}

export function getCachedPolicy(): PolicyCacheEntry | null {
  if (!policyCacheConfig?.enabled || !memoryPolicyCache) return null;
  if (new Date(memoryPolicyCache.expiresAt) < new Date()) return null;
  return memoryPolicyCache;
}

export function hasCachedPolicy(): boolean { return getCachedPolicy() !== null; }

export function isCachedToolAllowed(toolName: string): boolean {
  const cached = getCachedPolicy();
  if (!cached) return false;
  const allowedTools = cached.policy.allowedTools;
  if (!Array.isArray(allowedTools)) return false;
  if (allowedTools.includes("*")) return true;
  return allowedTools.includes(toolName);
}

export function getCachedPolicyForExecution(toolName: string): CachedPolicy | null {
  const cached = getCachedPolicy();
  if (!cached || !isCachedToolAllowed(toolName)) return null;
  return cached.policy;
}

export async function clearPolicyCache(): Promise<void> {
  memoryPolicyCache = null;
  try { await fs.unlink(getPolicyCacheFilePath()); } catch {}
}

export async function syncPolicyToCache(policy: any): Promise<void> {
  if (!policyCacheConfig?.enabled) return;
  const cachedPolicy: CachedPolicy = {
    allowedTools: policy?.allowedTools ?? null,
    filePolicy: policy?.filePolicy ?? null,
    networkPolicy: policy?.networkPolicy ?? null,
    uiPolicy: policy?.uiPolicy ?? null,
    evidencePolicy: policy?.evidencePolicy ?? null,
    clipboardPolicy: policy?.clipboardPolicy ?? null,
    limits: policy?.limits ?? null,
    toolFeatureFlags: policy?.toolFeatureFlags ?? null,
    degradationRules: policy?.degradationRules ?? null,
    circuitBreakerConfig: policy?.circuitBreakerConfig ?? null,
  };
  await cachePolicy(cachedPolicy);
}

/**
 * 构建离线执行 claim — 不再硬编码高风险工具列表，
 * 而是从策略中的 riskLevel 字段读取（由能力注册表提供）。
 */
export function buildOfflineClaim(params: {
  deviceExecutionId: string;
  toolRef: string;
  input?: any;
  getRiskLevel?: (toolName: string) => string | undefined;
}) {
  const cached = getCachedPolicy();
  if (!cached) return null;
  const tName = params.toolRef.includes("@") ? params.toolRef.slice(0, params.toolRef.indexOf("@")) : params.toolRef;
  if (!isCachedToolAllowed(tName)) return null;
  const riskLevel = params.getRiskLevel?.(tName) ?? "low";
  const requireUserPresence = riskLevel === "high" || riskLevel === "critical";
  return {
    execution: { deviceExecutionId: params.deviceExecutionId, toolRef: params.toolRef, input: params.input },
    requireUserPresence,
    policy: cached.policy,
    policyDigest: cached.policyDigest,
    isOffline: true as const,
  };
}

export function getPolicyCacheStatus() {
  const cached = getCachedPolicy();
  return {
    enabled: policyCacheConfig?.enabled ?? false,
    cached: cached !== null,
    version: cached?.version ?? null,
    cachedAt: cached?.cachedAt ?? null,
    expiresAt: cached?.expiresAt ?? null,
    policyDigest: cached?.policyDigest ?? null,
    allowedToolsCount: Array.isArray(cached?.policy?.allowedTools) ? cached!.policy.allowedTools!.length : 0,
  };
}

// ── 磁盘操作 ─────────────────────────────────────────────────

async function savePolicyToDisk(entry: PolicyCacheEntry): Promise<void> {
  const filePath = getPolicyCacheFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf8");
}

async function loadPolicyFromDisk(): Promise<PolicyCacheEntry | null> {
  try {
    const content = await fs.readFile(getPolicyCacheFilePath(), "utf8");
    const entry = JSON.parse(content) as PolicyCacheEntry;
    if (!entry.deviceId || !entry.policy || !entry.expiresAt) return null;
    if (entry.deviceId !== policyCacheConfig?.deviceId) return null;
    if (new Date(entry.expiresAt) < new Date()) return null;
    return entry;
  } catch { return null; }
}
