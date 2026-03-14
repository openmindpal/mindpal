export type Locale = "zh-CN" | "en-US" | (string & {});

export type I18nText = Record<string, string>;

export type I18nContext = {
  userLocale?: string;
  spaceLocale?: string;
  tenantLocale?: string;
  platformLocale?: string;
};

export function resolveLocale(ctx: I18nContext): string {
  return (
    ctx.userLocale ||
    ctx.spaceLocale ||
    ctx.tenantLocale ||
    ctx.platformLocale ||
    "zh-CN"
  );
}

export function t(text: I18nText | string | undefined, locale: string): string {
  if (!text) return "";
  if (typeof text === "string") return text;
  return text[locale] ?? text["zh-CN"] ?? Object.values(text)[0] ?? "";
}

export type ErrorResponse = {
  errorCode: string;
  message: I18nText;
  traceId?: string;
};

export type PolicyRef = {
  name: string;
  version: number;
};

export type PolicyVersionState = "draft" | "released" | "deprecated";

export type PolicyVersion = {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  status: PolicyVersionState;
  policyJson: unknown;
  digest: string;
  createdAt: string;
  publishedAt: string | null;
};

export type PolicyDecision = {
  decision: "allow" | "deny";
  reason?: string;
  matchedRules?: unknown;
  rowFilters?: unknown;
  fieldRules?: {
    read?: { allow?: string[]; deny?: string[] };
    write?: { allow?: string[]; deny?: string[] };
  };
  snapshotRef?: string;
  policyRef?: PolicyRef;
  policyCacheEpoch?: unknown;
  explainV1?: unknown;
};

export type PolicySnapshotExplainView = {
  snapshotId: string;
  tenantId: string;
  spaceId: string | null;
  resourceType: string;
  action: string;
  decision: "allow" | "deny";
  reason: string | null;
  matchedRules: unknown;
  rowFilters: unknown;
  fieldRules: unknown;
  createdAt: string;
  policyRef?: PolicyRef;
  policyCacheEpoch?: unknown;
  explainV1?: unknown;
};

export type PolicySnapshotCursor = {
  createdAt: string;
  snapshotId: string;
};

export type PolicySnapshotSummary = {
  snapshotId: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  resourceType: string;
  action: string;
  decision: "allow" | "deny";
  reason: string | null;
  rowFilters: unknown;
  fieldRules: unknown;
  createdAt: string;
  policyRef?: PolicyRef;
  policyCacheEpoch?: unknown;
};

export type { EvidenceSourceRef, EvidenceRef, EvidencePolicy, AnswerEnvelope } from "./evidence";

export type { SyncConflictClass, SyncConflictView, SyncMergeTranscript, SyncMergeSummary, SyncConflictTicketStatus, SyncConflictTicketSummary } from "./sync";

export type { PolicyExpr, PolicyLiteral, PolicyOperand, PolicyExprValidationResult, CompiledWhere } from "./policyExpr";
export { POLICY_EXPR_JSON_SCHEMA_V1, validatePolicyExpr, compilePolicyExprWhere } from "./policyExpr";

export { detectPromptInjection, resolvePromptInjectionPolicy, resolvePromptInjectionPolicyFromEnv, shouldDenyPromptInjection } from "./promptInjection";
export type { PromptInjectionHit, PromptInjectionHitSeverity, PromptInjectionMode, PromptInjectionPolicy, PromptInjectionScanResult } from "./promptInjection";

export { attachDlpSummary, redactString, redactValue, resolveDlpPolicy, resolveDlpPolicyFromEnv, shouldDenyDlpForTarget } from "./dlp";
export type { DlpHitType, DlpMode, DlpPolicy, DlpSummary } from "./dlp";

export { SUPPORTED_SCHEMA_MIGRATION_KINDS, isSupportedSchemaMigrationKind } from "./schemaMigration";
export type { SchemaMigrationKind } from "./schemaMigration";

export type { CapabilityEnvelopeV1, NetworkPolicyRuleV1, NetworkPolicyV1, RuntimeLimitsV1 } from "./capabilityEnvelope";
export { checkCapabilityEnvelopeNotExceedV1, normalizeNetworkPolicyV1, normalizeRuntimeLimitsV1, validateCapabilityEnvelopeV1 } from "./capabilityEnvelope";
