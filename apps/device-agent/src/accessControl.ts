/**
 * Device-Agent 访问控制模块
 *
 * 实现调用方鉴权与执行上下文隔离：
 * 1. 调用方身份验证（基于 Token/签名）
 * 2. 执行上下文隔离（不同调用方的状态分离）
 * 3. 工具级权限控制
 */
import crypto from "node:crypto";

// ── 类型定义 ──────────────────────────────────────────────────────

/** 调用方身份信息 */
export type CallerIdentity = {
  callerId: string;          // 调用方唯一标识
  callerType: "api" | "local" | "plugin";  // 调用来源类型
  tenantId?: string;         // 租户 ID（多租户场景）
  subjectId?: string;        // 主体 ID（用户/服务）
  verifiedAt: string;        // 验证时间
  expiresAt?: string;        // 过期时间
};

/** 执行上下文 */
export type ExecutionContext = {
  contextId: string;
  callerId: string;
  createdAt: string;
  lastActiveAt: string;
  state: Map<string, unknown>;  // 上下文状态存储
  toolPermissions: Set<string>; // 允许的工具列表（空=全部）
};

/** 访问控制策略 */
export type AccessPolicy = {
  allowedCallers?: string[];    // 允许的调用方列表（空=全部）
  allowedTools?: string[];      // 允许的工具列表（空=全部）
  requireSignature?: boolean;   // 是否要求签名验证
  maxContextAge?: number;       // 上下文最大存活时间（毫秒）
};

// ── 内部状态 ──────────────────────────────────────────────────────

const _contexts = new Map<string, ExecutionContext>();
const _callerCache = new Map<string, CallerIdentity>();
let _policy: AccessPolicy = {};
let _secretKey: string = "";

// ── 初始化 ──────────────────────────────────────────────────────

/** 初始化访问控制模块 */
export function initAccessControl(params: {
  secretKey?: string;
  policy?: AccessPolicy;
}): void {
  _secretKey = params.secretKey ?? process.env.DEVICE_AGENT_SECRET_KEY ?? "";
  _policy = params.policy ?? {};
}

/** 获取当前访问策略 */
export function getAccessPolicy(): AccessPolicy {
  return { ..._policy };
}

// ── 调用方验证 ──────────────────────────────────────────────────────

/** 生成调用方 Token */
export function generateCallerToken(params: {
  callerId: string;
  callerType: CallerIdentity["callerType"];
  tenantId?: string;
  subjectId?: string;
  expiresInMs?: number;
}): string {
  if (!_secretKey) {
    throw new Error("device_agent_secret_key_required");
  }
  const now = Date.now();
  const expiresAt = params.expiresInMs ? now + params.expiresInMs : now + 3600_000; // 默认1小时

  const payload = {
    cid: params.callerId,
    ct: params.callerType,
    tid: params.tenantId ?? "",
    sid: params.subjectId ?? "",
    iat: now,
    exp: expiresAt,
  };

  const payloadStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadStr).toString("base64url");

  // 使用 HMAC-SHA256 签名
  const signature = crypto
    .createHmac("sha256", _secretKey)
    .update(payloadB64)
    .digest("base64url");

  return `${payloadB64}.${signature}`;
}

/** 验证调用方 Token */
export function verifyCallerToken(token: string): CallerIdentity | null {
  if (!token || !_secretKey) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, signature] = parts;

  // 验证签名
  const expectedSig = crypto
    .createHmac("sha256", _secretKey)
    .update(payloadB64)
    .digest("base64url");

  if (signature !== expectedSig) return null;

  // 解析 payload
  try {
    const payloadStr = Buffer.from(payloadB64, "base64url").toString("utf8");
    const payload = JSON.parse(payloadStr);

    // 检查过期
    if (payload.exp && Date.now() > payload.exp) return null;

    return {
      callerId: String(payload.cid ?? ""),
      callerType: payload.ct === "api" || payload.ct === "local" || payload.ct === "plugin" ? payload.ct : "api",
      tenantId: payload.tid || undefined,
      subjectId: payload.sid || undefined,
      verifiedAt: new Date().toISOString(),
      expiresAt: payload.exp ? new Date(payload.exp).toISOString() : undefined,
    };
  } catch {
    return null;
  }
}

/** 验证调用方是否有权限 */
export function isCallerAllowed(callerId: string): boolean {
  if (!_policy.allowedCallers || _policy.allowedCallers.length === 0) return true;
  return _policy.allowedCallers.includes(callerId);
}

/** 验证调用方是否有权限执行指定工具 */
export function isToolAllowed(callerId: string, toolName: string): boolean {
  // 首先检查全局策略
  if (_policy.allowedTools && _policy.allowedTools.length > 0) {
    if (!_policy.allowedTools.includes(toolName)) return false;
  }

  // 检查上下文级权限
  const ctx = _contexts.get(callerId);
  if (ctx && ctx.toolPermissions.size > 0) {
    return ctx.toolPermissions.has(toolName);
  }

  return true;
}

// ── 执行上下文管理 ──────────────────────────────────────────────────

/** 生成上下文 ID */
function generateContextId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** 获取或创建执行上下文 */
export function getOrCreateContext(callerId: string, toolPermissions?: string[]): ExecutionContext {
  let ctx = _contexts.get(callerId);

  if (!ctx) {
    ctx = {
      contextId: generateContextId(),
      callerId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      state: new Map(),
      toolPermissions: new Set(toolPermissions ?? []),
    };
    _contexts.set(callerId, ctx);
  } else {
    ctx.lastActiveAt = new Date().toISOString();
    // 更新权限（如果提供）
    if (toolPermissions) {
      ctx.toolPermissions = new Set(toolPermissions);
    }
  }

  return ctx;
}

/** 获取执行上下文 */
export function getContext(callerId: string): ExecutionContext | null {
  return _contexts.get(callerId) ?? null;
}

/** 销毁执行上下文 */
export function destroyContext(callerId: string): boolean {
  return _contexts.delete(callerId);
}

/** 清理过期的执行上下文 */
export function cleanupExpiredContexts(): number {
  const maxAge = _policy.maxContextAge ?? 3600_000; // 默认1小时
  const cutoff = Date.now() - maxAge;
  let cleaned = 0;

  for (const [callerId, ctx] of _contexts.entries()) {
    const lastActive = new Date(ctx.lastActiveAt).getTime();
    if (lastActive < cutoff) {
      _contexts.delete(callerId);
      cleaned++;
    }
  }

  return cleaned;
}

/** 获取上下文状态 */
export function getContextState<T>(callerId: string, key: string): T | undefined {
  const ctx = _contexts.get(callerId);
  return ctx?.state.get(key) as T | undefined;
}

/** 设置上下文状态 */
export function setContextState(callerId: string, key: string, value: unknown): boolean {
  const ctx = _contexts.get(callerId);
  if (!ctx) return false;
  ctx.state.set(key, value);
  ctx.lastActiveAt = new Date().toISOString();
  return true;
}

/** 删除上下文状态 */
export function deleteContextState(callerId: string, key: string): boolean {
  const ctx = _contexts.get(callerId);
  if (!ctx) return false;
  return ctx.state.delete(key);
}

// ── 统计信息 ──────────────────────────────────────────────────────

/** 获取访问控制统计 */
export function getAccessStats(): {
  activeContexts: number;
  cachedCallers: number;
} {
  return {
    activeContexts: _contexts.size,
    cachedCallers: _callerCache.size,
  };
}

// ── 工具函数 ──────────────────────────────────────────────────────

/** 从请求中提取调用方身份（用于 API 场景） */
export function extractCallerFromRequest(params: {
  authHeader?: string;
  deviceToken?: string;
  clientIp?: string;
}): CallerIdentity | null {
  // 优先使用 Authorization header 中的 Bearer token
  if (params.authHeader?.startsWith("Bearer ")) {
    const token = params.authHeader.slice(7);
    const identity = verifyCallerToken(token);
    if (identity) return identity;
  }

  // 使用 device token 作为调用方标识（兼容现有逻辑）
  if (params.deviceToken) {
    return {
      callerId: `device:${crypto.createHash("sha256").update(params.deviceToken).digest("hex").slice(0, 16)}`,
      callerType: "api",
      verifiedAt: new Date().toISOString(),
    };
  }

  return null;
}
