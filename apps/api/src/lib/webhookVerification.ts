/**
 * Inbound Webhook Verification — 可靠入站验签
 *
 * P2-7.2: Webhook 入站路由的安全验证层：
 * - HMAC-SHA256 签名验证
 * - 幂等键去重（防止重复处理）
 * - 请求时效校验（防止重放攻击）
 * - 统一验证结果类型
 *
 * 可作为 Fastify preHandler hook 或独立验证函数使用。
 */
import crypto from "node:crypto";
import type { Pool } from "pg";

// ── 类型 ────────────────────────────────────────────────────

export interface WebhookVerificationConfig {
  /** HMAC 签名密钥 */
  secret: string;
  /** 签名头名称，默认 "x-signature-256" */
  signatureHeader?: string;
  /** 时间戳头名称，默认 "x-timestamp" */
  timestampHeader?: string;
  /** 请求时效（秒），超过则视为重放攻击，默认 300 (5分钟) */
  toleranceSec?: number;
  /** 幂等键头名称，默认 "x-idempotency-key" 或 body 中的 eventId */
  idempotencyHeader?: string;
  /** 幂等去重窗口（秒），默认 86400 (24小时) */
  dedupeWindowSec?: number;
  /** 签名输入构造方式 */
  signatureScheme?: "body" | "timestamp_body" | "custom";
}

export interface VerificationResult {
  valid: boolean;
  /** 被拒绝的原因 */
  rejectReason?: "invalid_signature" | "replay_attack" | "duplicate_event" | "missing_header" | "expired";
  /** 签名验证详情 */
  detail?: Record<string, unknown>;
}

// ── HMAC 签名验证 ───────────────────────────────────────────

/**
 * 计算 HMAC-SHA256 签名。
 */
export function computeHmacSha256(secret: string, input: string): string {
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

/**
 * 安全比较两个签名（防止时序攻击）。
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * 验证 Webhook 请求签名。
 */
export function verifyWebhookSignature(params: {
  /** 请求原始 body（字符串） */
  rawBody: string;
  /** 请求头中的签名值 */
  signature: string;
  /** 请求头中的时间戳 */
  timestamp?: string;
  /** 验证配置 */
  config: WebhookVerificationConfig;
}): VerificationResult {
  const { rawBody, signature, timestamp, config } = params;

  if (!signature) {
    return { valid: false, rejectReason: "missing_header", detail: { field: "signature" } };
  }

  // 构造签名输入
  let signingInput: string;
  switch (config.signatureScheme ?? "timestamp_body") {
    case "body":
      signingInput = rawBody;
      break;
    case "timestamp_body":
      if (!timestamp) {
        return { valid: false, rejectReason: "missing_header", detail: { field: "timestamp" } };
      }
      signingInput = `${timestamp}.${rawBody}`;
      break;
    default:
      signingInput = rawBody;
  }

  // 计算预期签名
  const expected = computeHmacSha256(config.secret, signingInput);

  // 安全比较
  // 支持 "sha256=xxx" 格式（GitHub 风格）
  const normalizedSig = signature.startsWith("sha256=") ? signature.slice(7) : signature;

  if (!safeCompare(normalizedSig, expected)) {
    return { valid: false, rejectReason: "invalid_signature" };
  }

  return { valid: true };
}

// ── 时效校验 ────────────────────────────────────────────────

/**
 * 验证请求时间戳是否在容许窗口内（防止重放攻击）。
 */
export function verifyTimestamp(params: {
  /** 请求时间戳（秒或毫秒 epoch） */
  timestamp: string | number;
  /** 容许偏差（秒），默认 300 */
  toleranceSec?: number;
}): VerificationResult {
  const toleranceSec = params.toleranceSec ?? 300;
  const ts = Number(params.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { valid: false, rejectReason: "missing_header", detail: { field: "timestamp" } };
  }

  // 自动检测秒/毫秒
  const tsSec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = Math.abs(nowSec - tsSec);

  if (diff > toleranceSec) {
    return { valid: false, rejectReason: "replay_attack", detail: { diffSec: diff, toleranceSec } };
  }

  return { valid: true };
}

// ── 幂等去重 ────────────────────────────────────────────────

/**
 * 检查事件是否已经处理过（基于 Redis 或 DB 的幂等键去重）。
 * 返回 true 表示是重复事件。
 */
export async function checkIdempotency(params: {
  /** Redis 实例（优先） */
  redis?: any;
  /** DB Pool（Redis 不可用时降级） */
  pool?: Pool;
  /** 租户 ID */
  tenantId: string;
  /** 幂等键 */
  idempotencyKey: string;
  /** 去重窗口（秒），默认 86400 */
  windowSec?: number;
}): Promise<{ isDuplicate: boolean }> {
  const { tenantId, idempotencyKey } = params;
  const windowSec = params.windowSec ?? 86400;
  const key = `webhook:idem:${tenantId}:${idempotencyKey}`;

  // 优先使用 Redis
  if (params.redis) {
    try {
      const result = await params.redis.set(key, "1", "EX", windowSec, "NX");
      // NX 返回 null 表示 key 已存在（重复）
      return { isDuplicate: result === null };
    } catch { /* Redis 失败，降级到 DB */ }
  }

  // DB 降级：使用 trigger_runs 表的 idempotency_key 字段
  if (params.pool) {
    try {
      const res = await params.pool.query(
        `SELECT 1 FROM trigger_runs
         WHERE tenant_id = $1 AND idempotency_key = $2
           AND created_at > now() - ($3 || ' seconds')::interval
         LIMIT 1`,
        [tenantId, idempotencyKey, windowSec],
      );
      return { isDuplicate: (res.rowCount ?? 0) > 0 };
    } catch { /* ignore */ }
  }

  // 无法检查，默认不重复
  return { isDuplicate: false };
}

// ── 完整验证流水线 ──────────────────────────────────────────

/**
 * 执行完整的 Webhook 验证流水线：签名 → 时效 → 幂等去重。
 */
export async function verifyInboundWebhook(params: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  config: WebhookVerificationConfig;
  tenantId: string;
  redis?: any;
  pool?: Pool;
}): Promise<VerificationResult> {
  const { rawBody, headers, config, tenantId } = params;

  const sigHeader = config.signatureHeader ?? "x-signature-256";
  const tsHeader = config.timestampHeader ?? "x-timestamp";
  const idemHeader = config.idempotencyHeader ?? "x-idempotency-key";

  const signature = headers[sigHeader] ?? headers[sigHeader.toLowerCase()] ?? "";
  const timestamp = headers[tsHeader] ?? headers[tsHeader.toLowerCase()] ?? "";

  // 1. 签名验证
  const sigResult = verifyWebhookSignature({
    rawBody,
    signature,
    timestamp,
    config,
  });
  if (!sigResult.valid) return sigResult;

  // 2. 时效校验
  if (timestamp) {
    const tsResult = verifyTimestamp({
      timestamp,
      toleranceSec: config.toleranceSec ?? 300,
    });
    if (!tsResult.valid) return tsResult;
  }

  // 3. 幂等去重
  let idempotencyKey = headers[idemHeader] ?? headers[idemHeader.toLowerCase()];
  if (!idempotencyKey) {
    // 从 body 中尝试提取 eventId
    try {
      const body = JSON.parse(rawBody);
      idempotencyKey = body?.eventId ?? body?.event_id ?? body?.idempotencyKey;
    } catch { /* not JSON */ }
  }

  if (idempotencyKey) {
    const { isDuplicate } = await checkIdempotency({
      redis: params.redis,
      pool: params.pool,
      tenantId,
      idempotencyKey,
      windowSec: config.dedupeWindowSec ?? 86400,
    });
    if (isDuplicate) {
      return { valid: false, rejectReason: "duplicate_event", detail: { idempotencyKey } };
    }
  }

  return { valid: true };
}
