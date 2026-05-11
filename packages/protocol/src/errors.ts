/**
 * 标准错误码集合
 *
 * 整合 Skill RPC 错误码和通用协议错误码，
 * 提供统一的错误分类和错误码命名空间。
 */

import { SKILL_RPC_ERRORS } from "./skill-rpc";
import { AUDIT_ERROR_CATEGORIES } from "./audit-event";

/* ================================================================== */
/*  跨层错误映射表                                                      */
/* ================================================================== */

/**
 * 跨层错误映射表 —— 将运行时错误分类统一映射到 HTTP 状态码和服务错误码。
 * 键为 ErrorCategory / RPC 错误标识，值为 HTTP 响应信息。
 */
export const ERROR_LAYER_MAP: Record<string, { httpStatus: number; serviceCode: string }> = {
  // ── 来自 @mindpal/shared errorCategory.ts ──
  governance_denied:         { httpStatus: 403, serviceCode: "GOVERNANCE_DENIED" },
  governance_unavailable:    { httpStatus: 503, serviceCode: "GOVERNANCE_UNAVAILABLE" },
  input_validation_failed:   { httpStatus: 400, serviceCode: "INPUT_VALIDATION_FAILED" },
  tool_unavailable:          { httpStatus: 503, serviceCode: "TOOL_UNAVAILABLE" },
  step_timeout:              { httpStatus: 504, serviceCode: "STEP_TIMEOUT" },
  tool_execution_failed:     { httpStatus: 502, serviceCode: "TOOL_EXECUTION_FAILED" },
  interrupted:               { httpStatus: 499, serviceCode: "INTERRUPTED" },
  deadletter:                { httpStatus: 500, serviceCode: "DEADLETTER" },
  collab_error:              { httpStatus: 502, serviceCode: "COLLAB_ERROR" },
  // ── 来自 @mindpal/shared serviceError.ts ──
  auth_failed:               { httpStatus: 401, serviceCode: "AUTH_FAILED" },
  policy_violation:          { httpStatus: 403, serviceCode: "POLICY_VIOLATION" },
  resource_exhausted:        { httpStatus: 429, serviceCode: "RESOURCE_EXHAUSTED" },
  invalid_request:           { httpStatus: 400, serviceCode: "INVALID_REQUEST" },
  not_found:                 { httpStatus: 404, serviceCode: "NOT_FOUND" },
  internal:                  { httpStatus: 500, serviceCode: "INTERNAL" },
  timeout:                   { httpStatus: 504, serviceCode: "TIMEOUT" },
  // ── RPC 级错误 ──
  tool_timeout:              { httpStatus: 504, serviceCode: "TOOL_TIMEOUT" },
  tool_not_found:            { httpStatus: 404, serviceCode: "TOOL_NOT_FOUND" },
  budget_exceeded:           { httpStatus: 429, serviceCode: "BUDGET_EXCEEDED" },
};

/* ================================================================== */
/*  Re-export Skill RPC Errors                                         */
/* ================================================================== */

export { SKILL_RPC_ERRORS } from "./skill-rpc";

/* ================================================================== */
/*  Re-export Audit Error Categories                                   */
/* ================================================================== */

export { AUDIT_ERROR_CATEGORIES } from "./audit-event";
export type { AuditErrorCategory } from "./audit-event";

/* ================================================================== */
/*  通用协议错误码                                                      */
/* ================================================================== */

export const PROTOCOL_ERRORS = {
  /** 协议版本不兼容 */
  VERSION_MISMATCH: "PROTOCOL_VERSION_MISMATCH",
  /** 消息格式无效 */
  INVALID_MESSAGE: "PROTOCOL_INVALID_MESSAGE",
  /** 握手失败 */
  HANDSHAKE_FAILED: "PROTOCOL_HANDSHAKE_FAILED",
  /** 会话过期 */
  SESSION_EXPIRED: "PROTOCOL_SESSION_EXPIRED",
  /** 重放攻击检测 */
  REPLAY_DETECTED: "PROTOCOL_REPLAY_DETECTED",
  /** 签名验证失败 */
  SIGNATURE_INVALID: "PROTOCOL_SIGNATURE_INVALID",
  /** 状态转换违规 */
  TRANSITION_VIOLATION: "PROTOCOL_TRANSITION_VIOLATION",
  /** 共识未达成 */
  CONSENSUS_NOT_REACHED: "PROTOCOL_CONSENSUS_NOT_REACHED",
  /** Manifest 校验失败 */
  MANIFEST_INVALID: "PROTOCOL_MANIFEST_INVALID",
} as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERRORS)[keyof typeof PROTOCOL_ERRORS];

/** Skill RPC 错误码类型 */
export type SkillRpcErrorCode = (typeof SKILL_RPC_ERRORS)[keyof typeof SKILL_RPC_ERRORS];

/** 根据运行时错误分类查询 HTTP 状态码 */
export function getHttpStatusForError(category: string): number {
  return ERROR_LAYER_MAP[category]?.httpStatus ?? 500;
}

/** 根据运行时错误分类查询服务错误码 */
export function getServiceCodeForError(category: string): string {
  return ERROR_LAYER_MAP[category]?.serviceCode ?? "INTERNAL";
}

/* ================================================================== */
/*  错误码范围常量                                                      */
/* ================================================================== */

/** JSON-RPC 2.0 标准错误码范围 */
export const JSONRPC_ERROR_RANGE = {
  /** 标准错误码下限 */
  STANDARD_MIN: -32700,
  /** 标准错误码上限 */
  STANDARD_MAX: -32600,
  /** 服务器端保留范围下限 */
  SERVER_MIN: -32099,
  /** 服务器端保留范围上限 */
  SERVER_MAX: -32000,
} as const;
