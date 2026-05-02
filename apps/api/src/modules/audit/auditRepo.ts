/**
 * auditRepo.ts — API 审计仓库
 *
 * 所有审计核心实现已收敛至 @openslin/shared/audit。
 * 本文件仅做 re-export，保持 API 内部引用路径兼容。
 */
import type { AuditEventInput as SharedAuditEventInput } from "@openslin/shared";
import {
  AUDIT_ERROR_CATEGORIES,
  normalizeAuditErrorCategory,
  computeEventHash,
  isHighRiskAuditAction,
  AuditContractError,
  insertAuditEvent,
  insertAuditEventFromShared,
} from "@openslin/shared";
import type { DetailedAuditEventInput } from "@openslin/shared";

// ── Re-exports（保持 API 内部引用路径兼容） ──
export {
  AUDIT_ERROR_CATEGORIES,
  normalizeAuditErrorCategory,
  computeEventHash,
  isHighRiskAuditAction,
  AuditContractError,
  insertAuditEvent,
  insertAuditEventFromShared,
};

export type AuditEventInput = DetailedAuditEventInput;

export type { SharedAuditEventInput };
