/**
 * 统一工具执行权限检查模块
 *
 * 将原先分散的三层权限检查合并为单次 authorizeToolExecution 调用：
 *   1. 通用 tool/execute ABAC 权限
 *   2. 特定 resourceType/action ABAC 权限
 *   3. 治理检查 (runPreExecutionChecks)
 */
import type { Pool } from "pg";
import { ErrorCategory, StructuredLogger } from "@mindpal/shared";
import type { ToolSemanticMeta } from "@mindpal/shared";
import { Errors } from "../lib/errors";
import { authorize } from "../modules/auth/authz";
import { buildAbacEvaluationRequestFromContext } from "../modules/auth/guard";
import { runPreExecutionChecks, type CheckpointContext } from "./governanceCheckpoint";
import { insertAuditEvent } from "../modules/audit/auditRepo";

const _logger = new StructuredLogger({ module: "loopPermissionUnified" });

/* ── ABAC 决策会话级缓存 ── */
const _abacCache = new Map<string, { decision: any; expiresAt: number }>();
const ABAC_CACHE_TTL_MS = 30_000; // 30秒

function abacCacheKey(tenantId: string, spaceId: string, subjectId: string, resourceType: string, action: string): string {
  return `${tenantId}:${spaceId || '-'}:${subjectId}:${resourceType}:${action}`;
}

function getCachedAbacDecision(key: string): any | undefined {
  const entry = _abacCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.decision;
  if (entry) _abacCache.delete(key); // 过期清除
  return undefined;
}

function setCachedAbacDecision(key: string, decision: any): void {
  _abacCache.set(key, { decision, expiresAt: Date.now() + ABAC_CACHE_TTL_MS });
  // 简单淘汰：超过 200 条时清除最旧
  if (_abacCache.size > 200) {
    const firstKey = _abacCache.keys().next().value;
    if (firstKey) _abacCache.delete(firstKey);
  }
}

/** 权限降级开关，默认关闭 */
export const AGENT_LOOP_PERMISSION_FALLBACK = process.env.AGENT_LOOP_PERMISSION_FALLBACK === "true";

/* ================================================================== */
/*  权限降级 — 同 category 低权限替代工具查找                              */
/* ================================================================== */

const ACTION_RANK: Record<string, number> = { read: 0, list: 0, write: 1, execute: 2, admin: 3 };

/**
 * 从工具目录中查找替代工具。
 * 三级策略：语义等价 → 同 category 且 operationType 相同 → 同 category 低权限兜底。
 * 纯元数据查找，不引入业务概念。
 */
export function findFallbackTool(
  toolRef: string,
  toolCatalog: Array<{ ref: string; category?: string; requiredAction?: string; semanticMeta?: ToolSemanticMeta }>,
  deniedAction: string,
  semanticMeta?: ToolSemanticMeta,
): string | null {
  const current = toolCatalog.find(t => t.ref === toolRef);

  // 1. 优先从 semanticEquivalents 中查找已注册且可用的工具
  if (semanticMeta?.semanticEquivalents?.length) {
    const equivalent = toolCatalog.find(
      t => semanticMeta.semanticEquivalents.includes(t.ref) && t.ref !== toolRef,
    );
    if (equivalent) return equivalent.ref;
  }

  if (!current?.category) return null;

  // 2. 同 category 且 operationType 相同的工具
  if (semanticMeta?.operationType) {
    const sameOp = toolCatalog.find(
      t => t.ref !== toolRef
        && t.category === current.category
        && t.semanticMeta?.operationType === semanticMeta.operationType,
    );
    if (sameOp) return sameOp.ref;
  }

  // 3. 兜底：同 category 低权限工具
  const deniedRank = ACTION_RANK[deniedAction] ?? 2;
  const candidates = toolCatalog.filter(
    t => t.ref !== toolRef && t.category === current.category && (ACTION_RANK[t.requiredAction ?? "execute"] ?? 2) < deniedRank,
  );
  if (!candidates.length) return null;
  // 优先返回 read 级别工具
  return (candidates.find(t => t.requiredAction === "read") ?? candidates[0]).ref;
}

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export interface AuthorizeToolParams {
  pool: Pool;
  subjectId: string;
  tenantId: string;
  spaceId: string;
  traceId: string | null;
  runId: string;
  jobId: string;
  /** 工具解析后的 resourceType（如 "entity", "file", "api"） */
  resourceType: string;
  /** 工具解析后的 action（如 "write", "read"） */
  action: string;
  /** 工具引用，用于治理检查 */
  toolRef: string;
  /** 执行约束/限制，用于治理上下文 */
  limits?: Record<string, unknown>;
}

export interface AuthorizationResult {
  authorized: boolean;
  /** 若授权通过，ABAC 决策对象（供下游 admitAndBuildStepEnvelope 使用） */
  opDecision?: { snapshotRef?: string; fieldRules?: any; rowFilters?: any; decision: string; [k: string]: any };
  /** 若授权失败，错误分类 */
  errorCategory?: string;
  /** 若授权失败，错误消息 */
  errorMessage?: string;
  /** 治理检查结果（供下游 executionKernel 使用，避免重复检查） */
  governanceResult?: {
    passed: boolean;
    requiresApproval: boolean;
  };
}

/* ================================================================== */
/*  Internal helpers                                                     */
/* ================================================================== */

/** 执行单次 ABAC 权限查询（带会话级缓存） */
async function checkAbac(params: {
  pool: Pool;
  subjectId: string;
  tenantId: string;
  spaceId: string;
  resourceType: string;
  action: string;
  traceId: string | null;
  runId: string;
  jobId: string;
}) {
  const cacheKey = abacCacheKey(params.tenantId, params.spaceId, params.subjectId, params.resourceType, params.action);
  const cached = getCachedAbacDecision(cacheKey);
  if (cached) return cached;

  const decision = await authorize({
    pool: params.pool,
    subjectId: params.subjectId,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    resourceType: params.resourceType,
    action: params.action,
    abacRequest: buildAbacEvaluationRequestFromContext({
      subject: {
        subjectId: params.subjectId,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
      },
      resourceType: params.resourceType,
      action: params.action,
      environment: {
        userAgent: "agent-loop/internal",
        deviceType: "server",
        attributes: {
          runtime: "agent_loop",
          runId: params.runId,
          jobId: params.jobId,
          ...(params.traceId ? { traceId: params.traceId } : {}),
        },
      },
    }),
  });

  // 仅缓存 allow 结果；拒绝结果不缓存，以便权限修复后立即生效
  if (decision.decision === "allow") {
    setCachedAbacDecision(cacheKey, decision);
  }
  return decision;
}

/* ================================================================== */
/*  Public API                                                           */
/* ================================================================== */

/**
 * 统一工具执行权限检查 —— 合并 ABAC 权限 + 治理检查为单次调用。
 *
 * 替代之前的三层权限检查：
 *   1. requireLoopPermission(tool/execute)       → 通用执行权限
 *   2. requireLoopPermission(resourceType/action) → 特定资源权限
 *   3. runPreExecutionChecks（治理检查）           → 策略/安全/可用性
 */
export async function authorizeToolExecution(params: AuthorizeToolParams): Promise<AuthorizationResult> {
  const { pool, subjectId, tenantId, spaceId, traceId, runId, jobId, resourceType, action, toolRef, limits } = params;

  // ── Layer 1 + Layer 2: 并行执行两层 ABAC 检查 ──
  const [genericDecision, specificDecision] = await Promise.all([
    checkAbac({ pool, subjectId, tenantId, spaceId, resourceType: "tool", action: "execute", traceId, runId, jobId }),
    checkAbac({ pool, subjectId, tenantId, spaceId, resourceType, action, traceId, runId, jobId }),
  ]);

  // 依次检查结果（保持原有的审计写入逻辑）
  if (genericDecision.decision !== "allow") {
    // ── 审计日志：记录权限拒绝决策 ──
    insertAuditEvent(pool, {
      subjectId, tenantId, spaceId,
      resourceType: "tool", action: "execute",
      toolRef,
      result: "denied",
      traceId: traceId ?? "",
      runId, inputDigest: {
        reason: "rbac_denied:tool/execute",
        matchedPolicy: genericDecision.snapshotRef ?? null,
        subject: subjectId, resource: toolRef, requestedAction: "execute",
      },
      policySnapshotRef: genericDecision.snapshotRef,
    }).catch(() => { /* 审计写入失败不影响主流程 */ });
    return {
      authorized: false,
      errorCategory: ErrorCategory.GOVERNANCE_DENIED,
      errorMessage: `${ErrorCategory.GOVERNANCE_DENIED}: tool/execute permission denied`,
    };
  }
  if (specificDecision.decision !== "allow") {
    // ── 审计日志：记录权限拒绝决策 ──
    insertAuditEvent(pool, {
      subjectId, tenantId, spaceId,
      resourceType, action,
      toolRef,
      result: "denied",
      traceId: traceId ?? "",
      runId, inputDigest: {
        reason: `rbac_denied:${resourceType}/${action}`,
        matchedPolicy: specificDecision.snapshotRef ?? null,
        subject: subjectId, resource: toolRef, requestedAction: action,
      },
      policySnapshotRef: specificDecision.snapshotRef,
    }).catch(() => { /* 审计写入失败不影响主流程 */ });
    return {
      authorized: false,
      errorCategory: ErrorCategory.GOVERNANCE_DENIED,
      errorMessage: `${ErrorCategory.GOVERNANCE_DENIED}: ${resourceType}/${action} permission denied`,
    };
  }

  // ── Layer 3: 治理检查 (runPreExecutionChecks) ──
  let governanceResult: AuthorizationResult["governanceResult"] = { passed: true, requiresApproval: false };

  if (spaceId && subjectId) {
    const govCtx: CheckpointContext = {
      tenantId,
      spaceId,
      subjectId,
      runId,
      toolRef,
      input: limits ?? {},
    };
    try {
      const checkpoint = await runPreExecutionChecks({ pool, context: govCtx });
      if (!checkpoint.overallPassed && checkpoint.blockingFailures > 0) {
        const blockingResults = checkpoint.results.filter(r => !r.passed && r.blocking);
        const firstBlocking = blockingResults[0];
        if (firstBlocking?.checkType === "policy" && firstBlocking.metadata?.requiresApproval) {
          // 策略要求审批 —— 不阻止，交由后续 approval 流程处理
          governanceResult = { passed: true, requiresApproval: true };
        } else {
          // ── 审计日志：记录治理检查拒绝决策 ──
          insertAuditEvent(pool, {
            subjectId, tenantId, spaceId,
            resourceType: "governance", action: "pre_check.denied",
            toolRef,
            result: "denied",
            traceId: traceId ?? "",
            runId, inputDigest: {
              reason: firstBlocking?.message ?? "治理检查未通过",
              checkType: firstBlocking?.checkType ?? "unknown",
              subject: subjectId, resource: toolRef, requestedAction: action,
            },
          }).catch(() => { /* 审计写入失败不影响主流程 */ });
          return {
            authorized: false,
            errorCategory: ErrorCategory.GOVERNANCE_DENIED,
            errorMessage: firstBlocking?.message ?? "治理检查未通过",
          };
        }
      }
    } catch (err: any) {
      // 治理检查本身的 Errors 直接返回拒绝
      if (err?.httpStatus) {
        return {
          authorized: false,
          errorCategory: ErrorCategory.GOVERNANCE_DENIED,
          errorMessage: err.errorCode ?? err.message,
        };
      }
      // ── 降级审计：记录治理检查基础设施异常，确保可追溯 ──
      const degradedDetail = {
        tenantId,
        spaceId,
        subjectId,
        toolRef,
        errorMessage: err?.message ?? "unknown",
        errorName: err?.name ?? "Error",
        degradedAt: new Date().toISOString(),
      };
      _logger.error(
        "governance pre-check failed (degraded)",
        degradedDetail as Record<string, unknown>,
      );
      // 异步写入审计表（降级记录），不阻塞主流程
      insertAuditEvent(pool, {
        tenantId,
        spaceId,
        subjectId,
        resourceType: "governance",
        action: "pre_check.degraded",
        inputDigest: degradedDetail,
        outputDigest: { degraded: true },
        result: "error",
        traceId: "",
      }).catch(() => { /* 审计写入失败不影响主流程 */ });
      return {
        authorized: false,
        errorCategory: ErrorCategory.GOVERNANCE_UNAVAILABLE,
        errorMessage: "治理检查不可用，已拒绝执行",
      };
    }
  }

  return {
    authorized: true,
    opDecision: specificDecision,
    governanceResult,
  };
}
