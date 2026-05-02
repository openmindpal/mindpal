import { computeEventHash } from "./cryptoUtils";

// ─── 审计数据库抽象（依赖注入） ──────────────────────────────────────

/** 最小化查询接口，pg.Pool / pg.PoolClient 均满足 */
export interface AuditQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/** 可获取事务客户端的连接池接口（pg.Pool 满足） */
export interface AuditPoolLike extends AuditQueryable {
  connect(): Promise<AuditClientLike>;
}

/** 事务客户端接口（pg.PoolClient 满足） */
export interface AuditClientLike extends AuditQueryable {
  release(): void;
}

// ─── 标准审计事件输入接口（简单/外部） ──────────────────────────────────

/** 统一审计事件输入，API 与 Worker 共用（简单外部接口） */
export interface AuditEventInput {
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  subject: string;
  outcome: "success" | "failure" | "denied";
  details?: Record<string, unknown>;
  traceId?: string;
  timestamp?: string;
}

/** 审计写入器抽象（可由 API / Worker 各自实现） */
export interface AuditWriter {
  write(event: AuditEventInput): Promise<void>;
  writeBatch(events: AuditEventInput[]): Promise<void>;
}

// ─── 详细审计事件输入（内部完整版本） ──────────────────────────────────

/** 详细审计事件输入，包含所有可选字段（API / Worker 内部使用） */
export type DetailedAuditEventInput = {
  subjectId?: string;
  tenantId?: string;
  spaceId?: string;
  resourceType: string;
  action: string;
  toolRef?: string;
  workflowRef?: string;
  policyDecision?: unknown;
  inputDigest?: unknown;
  outputDigest?: unknown;
  idempotencyKey?: string;
  result: "success" | "denied" | "error";
  traceId: string;
  requestId?: string;
  runId?: string;
  stepId?: string;
  policySnapshotRef?: string;
  errorCategory?: string;
  latencyMs?: number;
  outboxId?: string;
  timestamp?: string;
  /** P3-3: 人类可读的自然语言摘要 */
  humanSummary?: string;
};

// ─── 审计错误分类 ──────────────────────────────────────────

export const AUDIT_ERROR_CATEGORIES = [
  "policy_violation",
  "validation_error",
  "rate_limited",
  "upstream_error",
  "internal_error",
] as const;

export type AuditErrorCategory = (typeof AUDIT_ERROR_CATEGORIES)[number];

const AUDIT_ERROR_CATEGORY_SET = new Set<string>(AUDIT_ERROR_CATEGORIES);

export function normalizeAuditErrorCategory(input: unknown): AuditErrorCategory | null {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (AUDIT_ERROR_CATEGORY_SET.has(raw)) return raw as AuditErrorCategory;
  if (raw === "internal") return "internal_error";
  if (raw === "upstream") return "upstream_error";
  if (raw === "invalid_input" || raw === "bad_request") return "validation_error";
  if (raw === "throttled" || raw === "rate_limit") return "rate_limited";
  return "internal_error";
}

// ─── 高风险审计动作 ──────────────────────────────────────────

export const HIGH_RISK_AUDIT_ACTIONS = new Set<string>([
  "audit:siem.destination.write",
  "audit:siem.destination.test",
  "audit:siem.destination.backfill",
  "audit:siem.dlq.clear",
  "audit:siem.dlq.requeue",
]);

export function isHighRiskAuditAction(params: { resourceType?: string | null; action?: string | null }): boolean {
  const resourceType = String(params.resourceType ?? "").trim();
  const action = String(params.action ?? "").trim();
  if (!resourceType || !action) return false;
  return HIGH_RISK_AUDIT_ACTIONS.has(`${resourceType}:${action}`);
}

// ─── 审计契约错误 ──────────────────────────────────────────

export class AuditContractError extends Error {
  errorCode: string;
  httpStatus: number;
  details?: unknown;

  constructor(params: { errorCode: string; message: string; httpStatus?: number; details?: unknown }) {
    super(params.message);
    this.name = "AuditContractError";
    this.errorCode = params.errorCode;
    this.httpStatus = params.httpStatus ?? 409;
    this.details = params.details;
  }
}

// ─── humanSummary 自动生成 ──────────────────────────────────

/**
 * P3-3: 自动生成 humanSummary
 * 当调用方未提供时，根据审计事件属性自动生成可读摘要
 */
export function generateHumanSummary(e: DetailedAuditEventInput): string {
  const parts: string[] = [];
  const subject = e.subjectId ? `用户 ${e.subjectId.slice(0, 8)}` : "系统";
  const resultText = e.result === "success" ? "成功" : e.result === "denied" ? "被拒绝" : "失败";

  parts.push(`${subject}对 ${e.resourceType} 执行 ${e.action} 操作，结果: ${resultText}`);
  if (e.toolRef) parts.push(`工具: ${e.toolRef}`);
  if (e.latencyMs) parts.push(`耗时: ${e.latencyMs}ms`);
  if (e.errorCategory) parts.push(`错误类型: ${e.errorCategory}`);

  return parts.join(" | ");
}

// ─── policySnapshotRef 合并 ──────────────────────────────────

export function withPolicySnapshotRef(policyDecision: unknown, policySnapshotRef: string | null) {
  if (!policySnapshotRef) return policyDecision ?? null;
  if (policyDecision && typeof policyDecision === "object" && !Array.isArray(policyDecision)) {
    const base = policyDecision as Record<string, unknown>;
    if (typeof base.policySnapshotRef === "string" && base.policySnapshotRef.trim()) return base;
    if (typeof base.snapshotRef === "string" && base.snapshotRef.trim()) return { ...base, policySnapshotRef: base.snapshotRef };
    return { ...base, policySnapshotRef };
  }
  return { policySnapshotRef };
}

// ─── insertAuditEvent 选项 ──────────────────────────────────

export interface InsertAuditEventOptions {
  /**
   * 跳过哈希链写入（即使 tenantId 存在）。
   * 适用于 Worker SIEM 等场景，不需要事务性哈希链。
   */
  skipHashChain?: boolean;
}

// ─── 统一 insertAuditEvent ──────────────────────────────────

/**
 * 统一审计事件写入函数。
 *
 * - 不带 tenantId 或 skipHashChain=true → 简单 INSERT
 * - 带 tenantId 且 skipHashChain=false → 事务性哈希链写入
 *
 * @param pool  AuditPoolLike（pg.Pool 兼容）
 * @param e     DetailedAuditEventInput
 * @param opts  可选配置
 */
export async function insertAuditEvent(
  pool: AuditPoolLike,
  e: DetailedAuditEventInput,
  opts?: InsertAuditEventOptions,
) {
  if (process.env.AUDIT_FORCE_FAIL === "1") throw new Error("audit_force_fail");

  const policySnapshotRef = String(e.policySnapshotRef ?? "").trim() || null;

  // 高风险审计动作校验
  const missingContextFields: string[] = [];
  if (isHighRiskAuditAction({ resourceType: e.resourceType, action: e.action })) {
    if (!String(e.runId ?? "").trim()) missingContextFields.push("runId");
    if (!String(e.stepId ?? "").trim()) missingContextFields.push("stepId");
    if (!policySnapshotRef) missingContextFields.push("policySnapshotRef");
    if (missingContextFields.length > 0) {
      throw new AuditContractError({
        errorCode: "AUDIT_CONTEXT_REQUIRED",
        message: "high_risk_audit_context_required",
        details: {
          resourceType: e.resourceType,
          action: e.action,
          missing: missingContextFields,
        },
      });
    }
  }

  const policyDecision = withPolicySnapshotRef(e.policyDecision, policySnapshotRef);
  const errorCategory = normalizeAuditErrorCategory(e.errorCategory);

  // P3-3: humanSummary
  const humanSummary = e.humanSummary ?? generateHumanSummary(e);
  const enrichedOutputDigest =
    e.outputDigest && typeof e.outputDigest === "object" && !Array.isArray(e.outputDigest)
      ? { ...(e.outputDigest as Record<string, unknown>), humanSummary }
      : e.outputDigest
        ? { _original: e.outputDigest, humanSummary }
        : { humanSummary };

  const useHashChain = !!e.tenantId && !opts?.skipHashChain;

  if (!useHashChain) {
    // ── 简单写入（无哈希链） ──
    await pool.query(
      `
        INSERT INTO audit_events (
          subject_id, tenant_id, space_id, resource_type, action,
          tool_ref, workflow_ref, policy_decision, input_digest, output_digest,
          idempotency_key, result, trace_id, request_id, run_id, step_id, error_category, latency_ms, outbox_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19
        )
      `,
      [
        e.subjectId ?? null,
        e.tenantId ?? null,
        e.spaceId ?? null,
        e.resourceType,
        e.action,
        e.toolRef ?? null,
        e.workflowRef ?? null,
        policyDecision,
        e.inputDigest ?? null,
        enrichedOutputDigest,
        e.idempotencyKey ?? null,
        e.result,
        e.traceId,
        e.requestId ?? null,
        e.runId ?? null,
        e.stepId ?? null,
        errorCategory,
        e.latencyMs ?? null,
        e.outboxId ?? null,
      ],
    );
    return;
  }

  // ── 事务性哈希链写入 ──
  const ts0 = e.outboxId ? new Date().toISOString() : (e.timestamp ?? new Date().toISOString());
  const normalizedBase = {
    subjectId: e.subjectId ?? null,
    tenantId: e.tenantId ?? null,
    spaceId: e.spaceId ?? null,
    resourceType: e.resourceType,
    action: e.action,
    toolRef: e.toolRef ?? null,
    workflowRef: e.workflowRef ?? null,
    result: e.result,
    traceId: e.traceId,
    requestId: e.requestId ?? null,
    runId: e.runId ?? null,
    stepId: e.stepId ?? null,
    idempotencyKey: e.idempotencyKey ?? null,
    errorCategory,
    latencyMs: e.latencyMs ?? null,
    policyDecision,
    inputDigest: e.inputDigest ?? null,
    outputDigest: enrichedOutputDigest,
    outboxId: e.outboxId ?? null,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [e.tenantId]);
    const prevRes = await client.query(
      "SELECT event_hash, timestamp FROM audit_events WHERE tenant_id = $1 AND event_hash IS NOT NULL ORDER BY timestamp DESC, event_id DESC LIMIT 1",
      [e.tenantId],
    );
    const prevHash = prevRes.rowCount ? (prevRes.rows[0].event_hash as string | null) : null;
    const prevTs = prevRes.rowCount ? (prevRes.rows[0].timestamp as any) : null;
    let ts = ts0;
    const tsMs = new Date(ts0).getTime();
    const prevMs = prevTs ? new Date(prevTs).getTime() : NaN;
    if (Number.isFinite(prevMs) && Number.isFinite(tsMs) && tsMs <= prevMs) ts = new Date(Math.max(Date.now(), prevMs + 1)).toISOString();
    if (!Number.isFinite(tsMs) && Number.isFinite(prevMs)) ts = new Date(Math.max(Date.now(), prevMs + 1)).toISOString();
    const normalized = { timestamp: ts, ...normalizedBase };
    const eventHash = computeEventHash({ prevHash, normalized });

    await client.query(
      `
        INSERT INTO audit_events (
          timestamp, subject_id, tenant_id, space_id, resource_type, action,
          tool_ref, workflow_ref, policy_decision, input_digest, output_digest,
          idempotency_key, result, trace_id, request_id, run_id, step_id, error_category, latency_ms,
          prev_hash, event_hash, outbox_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22
        )
      `,
      [
        ts,
        e.subjectId ?? null,
        e.tenantId ?? null,
        e.spaceId ?? null,
        e.resourceType,
        e.action,
        e.toolRef ?? null,
        e.workflowRef ?? null,
        policyDecision,
        e.inputDigest ?? null,
        enrichedOutputDigest,
        e.idempotencyKey ?? null,
        e.result,
        e.traceId,
        e.requestId ?? null,
        e.runId ?? null,
        e.stepId ?? null,
        errorCategory,
        e.latencyMs ?? null,
        prevHash,
        eventHash,
        e.outboxId ?? null,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─── 简单外部接口转详细接口的桥接函数 ──────────────────────────

/**
 * 将简单 AuditEventInput 转换为 DetailedAuditEventInput 并写入。
 */
export async function insertAuditEventFromShared(
  pool: AuditPoolLike,
  event: AuditEventInput,
): Promise<void> {
  const outcomeMap: Record<string, "success" | "denied" | "error"> = {
    success: "success",
    failure: "error",
    denied: "denied",
  };
  await insertAuditEvent(pool, {
    tenantId: event.tenantId,
    subjectId: event.subject,
    resourceType: event.resourceType,
    action: event.action,
    result: outcomeMap[event.outcome] ?? "error",
    traceId: event.traceId ?? "",
    timestamp: event.timestamp,
    inputDigest: event.details ?? null,
    outputDigest: event.resourceId ? { resourceId: event.resourceId } : null,
  });
}

// ─── 设备审计证据引用 ──────────────────────────────────────────

/** 设备端审计证据引用（截图、录屏等工件） */
export interface AuditEvidenceRef {
  artifactId: string;
  storageRef: string;
  hash: string;
  mimeType?: string;
  sizeBytes?: number;
}
