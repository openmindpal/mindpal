/**
 * 统一工具执行权限检查模块
 *
 * 将原先分散的三层权限检查合并为单次 authorizeToolExecution 调用：
 *   1. 通用 tool/execute ABAC 权限
 *   2. 特定 resourceType/action ABAC 权限
 *   3. 治理检查 (runPreExecutionChecks)
 */
import type { Pool } from "pg";
import { ErrorCategory, StructuredLogger } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { authorize } from "../modules/auth/authz";
import { buildAbacEvaluationRequestFromContext } from "../modules/auth/guard";
import { runPreExecutionChecks, type CheckpointContext } from "./governanceCheckpoint";
import { insertAuditEvent } from "../modules/audit/auditRepo";

const _logger = new StructuredLogger({ module: "loopPermissionUnified" });

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

/** 执行单次 ABAC 权限查询 */
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
  return authorize({
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

  // ── Layer 1: 通用 tool/execute ABAC 权限 ──
  const genericDecision = await checkAbac({
    pool, subjectId, tenantId, spaceId,
    resourceType: "tool", action: "execute",
    traceId, runId, jobId,
  });
  if (genericDecision.decision !== "allow") {
    return {
      authorized: false,
      errorCategory: ErrorCategory.GOVERNANCE_DENIED,
      errorMessage: `${ErrorCategory.GOVERNANCE_DENIED}: tool/execute permission denied`,
    };
  }

  // ── Layer 2: 特定 resourceType/action ABAC 权限 ──
  const specificDecision = await checkAbac({
    pool, subjectId, tenantId, spaceId,
    resourceType, action,
    traceId, runId, jobId,
  });
  if (specificDecision.decision !== "allow") {
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
