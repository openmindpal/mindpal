import type { I18nText } from "@openslin/shared";
import { ServiceError, ServiceErrorCategory, classifyError as sharedClassifyError, toHttpResponse } from "@openslin/shared";
export { ServiceError, ServiceErrorCategory as ErrorCategory, toHttpResponse };
export { sharedClassifyError as classifyError };

/** 将 httpStatus 映射到 ErrorCategory */
function categoryFromStatus(httpStatus: number): ServiceErrorCategory {
  if (httpStatus === 401) return ServiceErrorCategory.AUTH_FAILED;
  if (httpStatus === 403) return ServiceErrorCategory.POLICY_VIOLATION;
  if (httpStatus === 404) return ServiceErrorCategory.NOT_FOUND;
  if (httpStatus === 429) return ServiceErrorCategory.RESOURCE_EXHAUSTED;
  if (httpStatus === 504) return ServiceErrorCategory.TIMEOUT;
  if (httpStatus >= 400 && httpStatus < 500) return ServiceErrorCategory.INVALID_REQUEST;
  return ServiceErrorCategory.INTERNAL;
}

export class AppError extends ServiceError {
  public readonly errorCode: string;
  public readonly messageI18n: I18nText;
  /** 可选：429 限流时的重试间隔秒数 */
  public retryAfterSec?: number;
  /** 可选：附加审计信息 */
  public audit?: { errorCategory?: string; outputDigest?: unknown };

  constructor(params: {
    errorCode: string;
    message: I18nText;
    httpStatus: number;
    cause?: unknown;
  }) {
    super({
      category: categoryFromStatus(params.httpStatus),
      code: params.errorCode,
      httpStatus: params.httpStatus,
      message: params.errorCode,
      cause: params.cause instanceof Error ? params.cause : undefined,
    });
    this.name = "AppError";
    this.errorCode = params.errorCode;
    this.messageI18n = params.message;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** 模型上游调用失败时的专用错误，携带上游 HTTP 状态、响应体、是否超时等信息 */
export class ModelUpstreamError extends AppError {
  public upstreamStatus?: number;
  public upstreamTimeout?: boolean;
  public upstreamBody?: unknown;

  constructor(params: {
    message: I18nText;
    cause?: unknown;
    upstreamStatus?: number;
    upstreamTimeout?: boolean;
    upstreamBody?: unknown;
  }) {
    super({ errorCode: "MODEL_UPSTREAM_FAILED", httpStatus: 502, message: params.message, cause: params.cause });
    this.upstreamStatus = params.upstreamStatus;
    this.upstreamTimeout = params.upstreamTimeout;
    this.upstreamBody = params.upstreamBody;
  }
}

export function isModelUpstreamError(err: unknown): err is ModelUpstreamError {
  return err instanceof ModelUpstreamError;
}

export const Errors = {
  // ─── OS 核心错误码 ─────────────────────────────────────────
  unauthorized: (localeFallback: string, cause?: unknown) =>
    new AppError({
      errorCode: "AUTH_UNAUTHORIZED",
      httpStatus: 401,
      message: {
        "zh-CN": "未认证",
        "en-US": "Unauthorized",
        [localeFallback]: localeFallback === "zh-CN" ? "未认证" : "Unauthorized",
      },
      cause,
    }),
  forbidden: (cause?: unknown) =>
    new AppError({
      errorCode: "AUTH_FORBIDDEN",
      httpStatus: 403,
      message: { "zh-CN": "无权限执行该操作", "en-US": "Forbidden" },
      cause,
    }),
  notFound: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "NOT_FOUND",
      httpStatus: 404,
      message: {
        "zh-CN": detail ? `未找到：${detail}` : "未找到",
        "en-US": detail ? `Not found: ${detail}` : "Not found",
      },
      cause,
    }),
  badRequest: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "BAD_REQUEST",
      httpStatus: 400,
      message: {
        "zh-CN": detail ? `参数错误：${detail}` : "参数错误",
        "en-US": detail ? `Bad request: ${detail}` : "Bad request",
      },
      cause,
    }),
  internal: (cause?: unknown) =>
    new AppError({
      errorCode: "INTERNAL_ERROR",
      httpStatus: 500,
      message: { "zh-CN": "服务内部错误", "en-US": "Internal server error" },
      cause,
    }),
  serviceNotReady: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "SERVICE_NOT_READY",
      httpStatus: 503,
      message: {
        "zh-CN": detail ? `服务未就绪：${detail}` : "服务未就绪",
        "en-US": detail ? `Service not ready: ${detail}` : "Service not ready",
      },
      cause,
    }),

  // ─── 限流 ──────────────────────────────────────────────
  rateLimited: (cause?: unknown) =>
    new AppError({
      errorCode: "RATE_LIMITED",
      httpStatus: 429,
      message: { "zh-CN": "请求过于频繁", "en-US": "Too many requests" },
      cause,
    }),
  rateLimitedLlm: (cause?: unknown) =>
    new AppError({
      errorCode: "RATE_LIMITED_LLM",
      httpStatus: 429,
      message: { "zh-CN": "LLM 调用频率超限", "en-US": "LLM rate limit exceeded" },
      cause,
    }),
  rateLimitedTool: (cause?: unknown) =>
    new AppError({
      errorCode: "RATE_LIMITED_TOOL",
      httpStatus: 429,
      message: { "zh-CN": "工具调用频率超限", "en-US": "Tool execution rate limit exceeded" },
      cause,
    }),
  rateLimitedBudget: (cause?: unknown) =>
    new AppError({
      errorCode: "RATE_LIMITED_BUDGET",
      httpStatus: 429,
      message: { "zh-CN": "预算额度已用尽", "en-US": "Budget quota exhausted" },
      cause,
    }),
  tenantConcurrencyExceeded: (tenantId: string, hardLimit: number, retryAfterSec = 5) => {
    const err = new AppError({
      errorCode: "TENANT_CONCURRENCY_EXCEEDED",
      httpStatus: 429,
      message: {
        "zh-CN": `租户 ${tenantId} 并发请求已达上限 (${hardLimit})，请稍后重试`,
        "en-US": `Tenant ${tenantId} concurrency limit exceeded (${hardLimit}), please retry later`,
      },
    });
    err.retryAfterSec = retryAfterSec;
    return err;
  },

  // ─── 凭证/密钥 ──────────────────────────────────────────
  secretForbidden: (cause?: unknown) =>
    new AppError({
      errorCode: "SECRET_FORBIDDEN",
      httpStatus: 403,
      message: { "zh-CN": "禁止读取凭证明文", "en-US": "Secret plaintext access is forbidden" },
      cause,
    }),
  keyDecryptFailed: (cause?: unknown) =>
    new AppError({
      errorCode: "KEY_DECRYPT_FAILED",
      httpStatus: 400,
      message: { "zh-CN": "密钥解密失败", "en-US": "Key decrypt failed" },
      cause,
    }),
  keyDisabled: (cause?: unknown) =>
    new AppError({
      errorCode: "KEY_DISABLED",
      httpStatus: 403,
      message: { "zh-CN": "密钥已禁用", "en-US": "Key disabled" },
      cause,
    }),

  // ─── 审计 ──────────────────────────────────────────────
  auditWriteFailed: (cause?: unknown) =>
    new AppError({
      errorCode: "AUDIT_WRITE_FAILED",
      httpStatus: 500,
      message: { "zh-CN": "审计写入失败", "en-US": "Audit write failed" },
      cause,
    }),
  auditOutboxWriteFailed: (cause?: unknown) =>
    new AppError({
      errorCode: "AUDIT_OUTBOX_WRITE_FAILED",
      httpStatus: 500,
      message: { "zh-CN": "审计外盒写入失败", "en-US": "Audit outbox write failed" },
      cause,
    }),
  auditOutboxRequired: (cause?: unknown) =>
    new AppError({
      errorCode: "AUDIT_OUTBOX_REQUIRED",
      httpStatus: 500,
      message: { "zh-CN": "写操作需要通过审计外盒落审计", "en-US": "Write operation requires audit outbox" },
      cause,
    }),

  // ─── 安全 ──────────────────────────────────────────────
  dlpDenied: (cause?: unknown) =>
    new AppError({
      errorCode: "DLP_DENIED",
      httpStatus: 403,
      message: { "zh-CN": "内容包含敏感信息，已被拒绝", "en-US": "Content contains sensitive data and was denied" },
      cause,
    }),
  safetyPromptInjectionDenied: (cause?: unknown) =>
    new AppError({
      errorCode: "SAFETY_PROMPT_INJECTION_DENIED",
      httpStatus: 403,
      message: { "zh-CN": "检测到提示注入风险，已拒绝执行", "en-US": "Potential prompt injection detected and execution was denied" },
      cause,
    }),
  toolDisabled: (cause?: unknown) =>
    new AppError({
      errorCode: "TOOL_DISABLED",
      httpStatus: 403,
      message: { "zh-CN": "工具未启用，已被拒绝", "en-US": "Tool is disabled" },
      cause,
    }),
  trustNotVerified: (cause?: unknown) =>
    new AppError({
      errorCode: "TRUST_NOT_VERIFIED",
      httpStatus: 403,
      message: { "zh-CN": "供应链信任未验证，已被拒绝", "en-US": "Supply chain trust not verified" },
      cause,
    }),
  scanNotPassed: (cause?: unknown) =>
    new AppError({
      errorCode: "SCAN_NOT_PASSED",
      httpStatus: 403,
      message: { "zh-CN": "依赖扫描未通过，已被拒绝", "en-US": "Dependency scan not passed" },
      cause,
    }),
  sbomNotPresent: (cause?: unknown) =>
    new AppError({
      errorCode: "SBOM_NOT_PRESENT",
      httpStatus: 403,
      message: { "zh-CN": "缺少 SBOM，已被拒绝", "en-US": "SBOM is missing" },
      cause,
    }),
  isolationRequired: (cause?: unknown) =>
    new AppError({
      errorCode: "ISOLATION_REQUIRED",
      httpStatus: 403,
      message: { "zh-CN": "隔离级别不满足要求，已被拒绝", "en-US": "Isolation level requirement not met" },
      cause,
    }),

  // ─── 模型网关 ──────────────────────────────────────────
  modelUpstreamFailed: (detail?: string, cause?: unknown) =>
    new ModelUpstreamError({
      message: {
        "zh-CN": detail ? `模型上游服务失败：${detail}` : "模型上游服务失败",
        "en-US": detail ? `Model upstream failed: ${detail}` : "Model upstream failed",
      },
      cause,
    }),
  modelProviderNotImplemented: (provider?: string, cause?: unknown) =>
    new AppError({
      errorCode: "PROVIDER_NOT_IMPLEMENTED",
      httpStatus: 501,
      message: {
        "zh-CN": provider ? `模型提供方未实现：${provider}` : "模型提供方未实现",
        "en-US": provider ? `Provider not implemented: ${provider}` : "Provider not implemented",
      },
      cause,
    }),
  modelProviderUnsupported: (provider?: string, cause?: unknown) =>
    new AppError({
      errorCode: "MODEL_PROVIDER_UNSUPPORTED",
      httpStatus: 400,
      message: {
        "zh-CN": provider ? `不支持的模型提供方：${provider}` : "不支持的模型提供方",
        "en-US": provider ? `Model provider unsupported: ${provider}` : "Model provider unsupported",
      },
      cause,
    }),

  // ─── 其他 OS 级 ──────────────────────────────────────────
  fieldWriteForbidden: (cause?: unknown) =>
    new AppError({
      errorCode: "FIELD_WRITE_FORBIDDEN",
      httpStatus: 403,
      message: { "zh-CN": "无权限写入该字段", "en-US": "Field write forbidden" },
      cause,
    }),
  evidenceRequired: (cause?: unknown) =>
    new AppError({
      errorCode: "EVIDENCE_REQUIRED",
      httpStatus: 409,
      message: { "zh-CN": "回答缺少证据链引用，已拒绝", "en-US": "Answer is missing evidence references" },
      cause,
    }),
  inputSchemaInvalid: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "INPUT_SCHEMA_INVALID",
      httpStatus: 400,
      message: {
        "zh-CN": detail ? `入参校验失败：${detail}` : "入参校验失败",
        "en-US": detail ? `Input schema invalid: ${detail}` : "Input schema invalid",
      },
      cause,
    }),
  migrationRequired: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "MIGRATION_REQUIRED",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `需要先完成数据迁移：${detail}` : "需要先完成数据迁移",
        "en-US": detail ? `Migration required: ${detail}` : "Migration required",
      },
      cause,
    }),

  // ─── Skill 级错误码 ──────────────────────────────────────

  // UI / Workbench
  uiConfigDenied: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "UI_CONFIG_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `页面配置被拒绝：${detail}` : "页面配置被拒绝",
        "en-US": detail ? `UI config denied: ${detail}` : "UI config denied",
      },
      cause,
    }),
  uiComponentRegistryDenied: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "UI_COMPONENT_REGISTRY_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `组件注册表被拒绝：${detail}` : "组件注册表被拒绝",
        "en-US": detail ? `UI component registry denied: ${detail}` : "UI component registry denied",
      },
      cause,
    }),
  uiComponentRegistryDraftMissing: (cause?: unknown) =>
    new AppError({
      errorCode: "UI_COMPONENT_REGISTRY_DRAFT_MISSING",
      httpStatus: 409,
      message: {
        "zh-CN": "组件注册表 draft 不存在",
        "en-US": "UI component registry draft is missing",
      },
      cause,
    }),
  uiComponentRegistryNoPreviousVersion: (cause?: unknown) =>
    new AppError({
      errorCode: "UI_COMPONENT_REGISTRY_NO_PREVIOUS_VERSION",
      httpStatus: 409,
      message: {
        "zh-CN": "组件注册表无可回滚的上一版本",
        "en-US": "UI component registry has no previous version to rollback",
      },
      cause,
    }),
  workbenchNoPreviousVersion: (cause?: unknown) =>
    new AppError({
      errorCode: "WORKBENCH_NO_PREVIOUS_VERSION",
      httpStatus: 409,
      message: {
        "zh-CN": "工作台无可回滚的上一版本",
        "en-US": "Workbench has no previous version to rollback",
      },
      cause,
    }),
  workbenchManifestDenied: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "WORKBENCH_MANIFEST_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `工作台 manifest 被拒绝：${detail}` : "工作台 manifest 被拒绝",
        "en-US": detail ? `Workbench manifest denied: ${detail}` : "Workbench manifest denied",
      },
      cause,
    }),

  // Channel
  channelConfigMissing: (cause?: unknown) =>
    new AppError({
      errorCode: "CHANNEL_CONFIG_MISSING",
      httpStatus: 403,
      message: {
        "zh-CN": "渠道配置缺失，已拒绝",
        "en-US": "Channel config is missing",
      },
      cause,
    }),
  channelSignatureInvalid: (cause?: unknown) =>
    new AppError({
      errorCode: "CHANNEL_SIGNATURE_INVALID",
      httpStatus: 403,
      message: {
        "zh-CN": "渠道验签失败，已拒绝",
        "en-US": "Channel signature invalid",
      },
      cause,
    }),
  channelReplayDenied: (cause?: unknown) =>
    new AppError({
      errorCode: "CHANNEL_REPLAY_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": "请求疑似重放，已拒绝",
        "en-US": "Replay denied",
      },
      cause,
    }),
  channelMappingMissing: (cause?: unknown) =>
    new AppError({
      errorCode: "CHANNEL_MAPPING_MISSING",
      httpStatus: 403,
      message: {
        "zh-CN": "渠道身份映射缺失，已拒绝",
        "en-US": "Channel mapping is missing",
      },
      cause,
    }),

  // Replay / Seal
  sealNotPresent: (cause?: unknown) =>
    new AppError({
      errorCode: "SEAL_NOT_PRESENT",
      httpStatus: 403,
      message: {
        "zh-CN": "回放来源未封存（sealed），已被拒绝",
        "en-US": "Replay source is not sealed",
      },
      cause,
    }),
  replaySealRequired: (cause?: unknown) =>
    new AppError({
      errorCode: "REPLAY_SEAL_REQUIRED",
      httpStatus: 409,
      message: {
        "zh-CN": "回放需要封存（sealed）来源",
        "en-US": "Replay requires sealed source",
      },
      cause,
    }),

  // Artifact
  artifactTokenDenied: (cause?: unknown) =>
    new AppError({
      errorCode: "ARTIFACT_TOKEN_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": "下载令牌无效或已过期，已拒绝",
        "en-US": "Download token is invalid or expired",
      },
      cause,
    }),

  // Step / Run / Workflow
  stepOutputNotEncrypted: (cause?: unknown) =>
    new AppError({
      errorCode: "STEP_OUTPUT_NOT_ENCRYPTED",
      httpStatus: 400,
      message: {
        "zh-CN": "Step 出参未加密，无法解密查看",
        "en-US": "Step output is not encrypted",
      },
      cause,
    }),
  stepPayloadExpired: (cause?: unknown) =>
    new AppError({
      errorCode: "STEP_PAYLOAD_EXPIRED",
      httpStatus: 410,
      message: {
        "zh-CN": "Step 密文已过期清理，无法解密查看",
        "en-US": "Step payload expired",
      },
      cause,
    }),
  stepNotCompensable: (cause?: unknown) =>
    new AppError({
      errorCode: "STEP_NOT_COMPENSABLE",
      httpStatus: 400,
      message: {
        "zh-CN": "Step 不支持补偿/撤销",
        "en-US": "Step is not compensable",
      },
      cause,
    }),
  runNotCancelable: (cause?: unknown) =>
    new AppError({
      errorCode: "RUN_NOT_CANCELABLE",
      httpStatus: 409,
      message: {
        "zh-CN": "Run 已结束或不可取消",
        "en-US": "Run is not cancelable",
      },
      cause,
    }),

  // Schema
  schemaNoPreviousVersion: (cause?: unknown) =>
    new AppError({
      errorCode: "SCHEMA_NO_PREVIOUS_VERSION",
      httpStatus: 409,
      message: {
        "zh-CN": "Schema 无可回滚的上一版本",
        "en-US": "Schema has no previous version to rollback",
      },
      cause,
    }),
  schemaChangesetRequired: (action?: "set_active" | "rollback" | "publish", cause?: unknown) =>
    new AppError({
      errorCode: "SCHEMA_CHANGESET_REQUIRED",
      httpStatus: 409,
      message: {
        "zh-CN": action ? `请通过 changeset 流程执行 schema.${action}` : "请通过 changeset 流程执行 Schema 治理变更",
        "en-US": action ? `Please run schema.${action} via changeset flow` : "Please run schema governance changes via changeset flow",
      },
      cause,
    }),
  schemaMigrationRequired: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "SCHEMA_MIGRATION_REQUIRED",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `Schema 需要先完成数据迁移：${detail}` : "Schema 需要先完成数据迁移",
        "en-US": detail ? `Schema migration required: ${detail}` : "Schema migration required",
      },
      cause,
    }),
  schemaBreakingChange: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "SCHEMA_BREAKING_CHANGE",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `检测到 Schema 破坏性变更：${detail}` : "检测到 Schema 破坏性变更",
        "en-US": detail ? `Schema breaking change detected: ${detail}` : "Schema breaking change detected",
      },
      cause,
    }),

  // Eval
  evalNotPassed: (cause?: unknown) =>
    new AppError({
      errorCode: "EVAL_NOT_PASSED",
      httpStatus: 403,
      message: {
        "zh-CN": "评测未通过，已拒绝发布",
        "en-US": "Evaluation not passed",
      },
      cause,
    }),
  evalAdmissionPending: (cause?: unknown) =>
    new AppError({
      errorCode: "EVAL_ADMISSION_PENDING",
      httpStatus: 409,
      message: {
        "zh-CN": "评测准入未满足，请先完成评测",
        "en-US": "Evaluation admission pending",
      },
      cause,
    }),

  // Policy / Contract / Changeset
  policyDebugInvalidInput: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "POLICY_DEBUG_INVALID_INPUT",
      httpStatus: 400,
      message: {
        "zh-CN": detail ? `策略调试输入无效：${detail}` : "策略调试输入无效",
        "en-US": detail ? `Policy debug input invalid: ${detail}` : "Policy debug input invalid",
      },
      cause,
    }),
  policyExprInvalid: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "POLICY_EXPR_INVALID",
      httpStatus: 400,
      message: {
        "zh-CN": detail ? `策略表达式无效：${detail}` : "策略表达式无效",
        "en-US": detail ? `Policy expression invalid: ${detail}` : "Policy expression invalid",
      },
      cause,
    }),
  contractNotCompatible: (detail?: string, cause?: unknown) =>
    new AppError({
      errorCode: "CONTRACT_NOT_COMPATIBLE",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `契约兼容性校验失败：${detail}` : "契约兼容性校验失败",
        "en-US": detail ? `Contract compatibility check failed: ${detail}` : "Contract compatibility check failed",
      },
      cause,
    }),
  changeSetModeNotSupported: (cause?: unknown) =>
    new AppError({
      errorCode: "CHANGESET_MODE_NOT_SUPPORTED",
      httpStatus: 400,
      message: {
        "zh-CN": "该变更集内容不支持 canary 模式",
        "en-US": "This changeset does not support canary mode",
      },
      cause,
    }),
};
