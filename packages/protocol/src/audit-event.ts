/**
 * 审计事件协议类型定义
 *
 * 定义审计系统的标准类型、接口和纯工具函数。
 * 不包含任何数据库操作或 Node.js 运行时依赖。
 */

import { createRegistry, builtInEntry, type RegistryEntry } from './registry.js';

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

// ─── 错误分类别名注册表 ──────────────────────────────────────────

export const BUILTIN_ERROR_CATEGORY_ALIASES: RegistryEntry<string>[] = [
  builtInEntry('internal', 'audit.error_alias', 'internal_error'),
  builtInEntry('upstream', 'audit.error_alias', 'upstream_error'),
  builtInEntry('invalid_input', 'audit.error_alias', 'validation_error'),
  builtInEntry('bad_request', 'audit.error_alias', 'validation_error'),
  builtInEntry('throttled', 'audit.error_alias', 'rate_limited'),
  builtInEntry('rate_limit', 'audit.error_alias', 'rate_limited'),
  builtInEntry('policy', 'audit.error_alias', 'policy_violation'),
  builtInEntry('validation', 'audit.error_alias', 'validation_error'),
];

export const errorCategoryAliasRegistry = createRegistry<string>(BUILTIN_ERROR_CATEGORY_ALIASES);

export function normalizeAuditErrorCategory(input: unknown): AuditErrorCategory | null {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (AUDIT_ERROR_CATEGORY_SET.has(raw)) return raw as AuditErrorCategory;
  const aliasEntry = errorCategoryAliasRegistry.get(raw);
  if (aliasEntry?.value && AUDIT_ERROR_CATEGORY_SET.has(aliasEntry.value)) {
    return aliasEntry.value as AuditErrorCategory;
  }
  return "internal_error";
}

// ─── 高风险审计动作 ──────────────────────────────────────────

export const BUILTIN_HIGH_RISK_ACTIONS: RegistryEntry[] = [
  builtInEntry('audit:siem.destination.write', 'audit.high_risk'),
  builtInEntry('audit:siem.destination.test', 'audit.high_risk'),
  builtInEntry('audit:siem.destination.backfill', 'audit.high_risk'),
  builtInEntry('audit:siem.dlq.clear', 'audit.high_risk'),
  builtInEntry('audit:siem.dlq.requeue', 'audit.high_risk'),
];

export const highRiskActionRegistry = createRegistry(BUILTIN_HIGH_RISK_ACTIONS);

/** @deprecated 使用 highRiskActionRegistry 替代 */
export const HIGH_RISK_AUDIT_ACTIONS = new Set<string>(BUILTIN_HIGH_RISK_ACTIONS.map(e => e.id));

/** 检查操作是否为高风险 */
export function isHighRiskAction(resourceType: string, action: string): boolean {
  return highRiskActionRegistry.has(`${resourceType}.${action}`) || highRiskActionRegistry.has(action);
}

export function isHighRiskAuditAction(params: { resourceType?: string | null; action?: string | null }): boolean {
  const resourceType = String(params.resourceType ?? "").trim();
  const action = String(params.action ?? "").trim();
  if (!resourceType || !action) return false;
  return highRiskActionRegistry.has(`${resourceType}:${action}`);
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

// ─── 设备审计证据引用 ──────────────────────────────────────────

/** 设备端审计证据引用（截图、录屏等工件） */
export interface AuditEvidenceRef {
  artifactId: string;
  storageRef: string;
  hash: string;
  mimeType?: string;
  sizeBytes?: number;
}
