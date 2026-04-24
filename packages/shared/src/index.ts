export type Locale = "zh-CN" | "en-US" | (string & {});

/* ------------------------------------------------------------------ */
/*  Multimodal Content Types                                            */
/* ------------------------------------------------------------------ */

/** 文本内容片段 */
export type TextContentPart = { type: "text"; text: string };

/** 图像内容片段 */
export type ImageContentPart = {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
};

/** 音频内容片段 */
export type AudioContentPart = {
  type: "input_audio";
  input_audio: { data: string; format: "wav" | "mp3" | "ogg" | "webm" | "m4a" | "flac" | "aac" };
};

/** 视频内容片段 */
export type VideoContentPart = {
  type: "video_url";
  video_url: { url: string };
};

/** 多模态内容片段（兼容主流多模态协议） */
export type ContentPart = TextContentPart | ImageContentPart | AudioContentPart | VideoContentPart;

/** 消息内容：纯文本或多模态内容片段数组 */
export type MessageContent = string | ContentPart[];

/** 提取纯文本（多模态消息取所有 text 片段拼接） */
export function extractTextContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextContentPart => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** 检测消息内容是否包含图像 */
export function hasImageContent(content: MessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((p) => p.type === "image_url");
}

/** 检测消息内容是否包含音频 */
export function hasAudioContent(content: MessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((p) => p.type === "input_audio");
}

/** 检测消息内容是否包含视频 */
export function hasVideoContent(content: MessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((p) => p.type === "video_url");
}

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

export type FieldRuleSide = {
  allow?: string[];
  deny?: string[];
};

export type FieldRulesV1 = {
  read?: FieldRuleSide;
  write?: FieldRuleSide;
};

export type ConditionalFieldRule = {
  condition?: unknown;   // AbacCondition-style; when null → always applies
  fieldRules: FieldRulesV1;
};

export type RowFilterKind =
  | { kind: "owner_only" }
  | { kind: "payload_field_eq_subject"; field: string }
  | { kind: "payload_field_eq_literal"; field: string; value: string | number | boolean }
  | { kind: "space_member"; roles?: string[] }
  | { kind: "org_hierarchy"; orgField: string; includeDescendants: boolean }
  | { kind: "expr"; expr: unknown }
  | { kind: "or"; rules: RowFilterKind[] }
  | { kind: "and"; rules: RowFilterKind[] }
  | { kind: "not"; rule: RowFilterKind };

export type PolicyDecision = {
  decision: "allow" | "deny";
  reason?: string;
  matchedRules?: unknown;
  rowFilters?: RowFilterKind | unknown;
  fieldRules?: FieldRulesV1;
  conditionalFieldRules?: ConditionalFieldRule[];
  snapshotRef?: string;
  policyRef?: PolicyRef;
  policyCacheEpoch?: unknown;
  explainV1?: unknown;
  abacResult?: unknown;
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

// ─── Run 响应 DTO ─────────────────────────────────────────────────
export type { RunSummaryDTO, RunDetailDTO, RunStepDTO } from "./runDto.js";

export type { EvidenceSourceRef, EvidenceRef, EvidencePolicy, AnswerEnvelope } from "./evidence";

export type {
  VectorStoreProvider,
  VectorStoreRef,
  VectorStoreRef as VectorStoreRefV2,
  VectorStoreCapabilities,
  VectorStoreCapabilities as VectorStoreCapabilitiesV2,
  VectorStoreInterface,
  VectorStoreInterface as VectorStoreV2,
  VectorStoreConfig,
  VectorStoreConfig as VectorStoreConfigV2,
  VectorStoreEmbedding,
  VectorStoreEmbedding as VectorStoreEmbeddingV2,
  VectorMetadataPayload,
  VectorStoreQuery,
  VectorStoreQuery as VectorStoreQueryV2,
  VectorStoreQueryResponse,
  VectorStoreQueryResponse as VectorStoreQueryResponseV2,
  VectorStoreBatchResult,
  VectorStoreCollectionInfo,
  VectorStoreFilter,
  VectorStoreFilterCondition,
  EqFilter,
  RangeFilter,
  InFilter,
  TextMatchFilter,
  VectorStoreQueryResult,
  VectorStoreDegradeEvent,
  PgVectorConfig,
} from "./knowledgeVectorStore";


export type { SyncConflictClass, SyncConflictView, SyncMergeTranscript, SyncMergeSummary, SyncConflictTicketStatus, SyncConflictTicketSummary } from "./sync";

// ─── 记忆系统共享核心 ─────────────────────────────────────────────────
export {
  // Minhash 语义向量
  MINHASH_K, MINHASH_MODEL_REF,
  tokenize, hash32, computeMinhash, minhashOverlapScore,
  // 风险分级
  MEMORY_TYPE_RISK_LEVELS, DEFAULT_RISK_LEVEL, APPROVAL_REQUIRED_RISK_LEVELS,
  registerMemoryTypeRisk, getMemoryTypeRisk,
  evaluateMemoryRisk,
  // SHA-256
  sha256 as memorySha256,
  // 统一 Rerank
  computeMemoryRerankScore,
  // ILIKE 转义
  escapeIlikePat,
  // Cosine Similarity
  cosineSimilarity,
} from "./memoryCore";
export type {
  MemoryRiskEvaluation, WriteProof, WriteIntent, MemoryRerankInput,
  MemoryScope,
} from "./memoryCore";

// ─── 列级加密（AES-256-GCM，API / Worker 共享） ────────────────────────────
export {
  isColumnEncrypted, isColumnEncryptedString,
  encryptColumn, encryptColumns,
  decryptColumnPayload, decryptColumn, decryptColumns,
  reencryptColumn,
  needsEncryptionMigration,
} from "./columnEncryption";
export type {
  ColumnEncryptedV1, ColumnKeyMaterial, ColumnDecryptOptions,
} from "./columnEncryption";

export type { PolicyExpr, PolicyLiteral, PolicyOperand, PolicyExprValidationResult, CompiledWhere } from "./policyExpr";
export { POLICY_EXPR_JSON_SCHEMA_V1, validatePolicyExpr, compilePolicyExprWhere } from "./policyExpr";

// ── 统一行过滤编译器（消除 dataRepo / worker entity 重复逻辑） ──
export { compileRowFiltersWhere, clearPolicyExprCache } from "./policyFilterCache";
export type { RowFilterSubject, CompileRowFiltersParams, CompileRowFiltersResult } from "./policyFilterCache";

// ── ABAC 策略引擎 ──────────────────────────────────────────
export {
  evaluateAbacCondition,
  evaluateAbacPolicySet,
  validateAbacPolicyRule,
  isInHierarchy,
  getHierarchyAncestors,
  buildPolicySetIndex,
} from "./policyEngine";
export type {
  AttributeCategory,
  AttributeDefinition,
  AbacPolicyRule,
  AbacPolicySet,
  PolicyCombiningAlgorithm,
  AbacEvaluationRequest,
  AbacEvaluationResult,
  PolicySetIndex,
} from "./policyEngine";

export { detectPromptInjection, resolvePromptInjectionPolicy, resolvePromptInjectionPolicyFromEnv, shouldDenyPromptInjection } from "./promptInjection";
export type { PromptInjectionHit, PromptInjectionHitSeverity, PromptInjectionMode, PromptInjectionPolicy, PromptInjectionScanResult } from "./promptInjection";

export { attachDlpSummary, redactString, redactValue, resolveDlpPolicy, resolveDlpPolicyFromEnv, shouldDenyDlpForTarget } from "./dlp";
export type { DlpHitType, DlpMode, DlpPolicy, DlpSummary } from "./dlp";

export { SUPPORTED_SCHEMA_MIGRATION_KINDS, isSupportedSchemaMigrationKind } from "./schemaMigration";
export type { SchemaMigrationKind } from "./schemaMigration";

export type { CapabilityEnvelopeV1 } from "./capabilityEnvelope";
export { checkCapabilityEnvelopeNotExceedV1, validateCapabilityEnvelopeV1 } from "./capabilityEnvelope";

// ─── 统一错误分类枚举 ─────────────────────────────────────────────────
export { ErrorCategory, type ErrorCategoryValue, isRetryableError, errorActionHint } from "./errorCategory";

export { AUDIT_ERROR_CATEGORIES, normalizeAuditErrorCategory } from "./audit";
export type { AuditErrorCategory, AuditEventInput, AuditWriter } from "./audit";

export { PERM } from "./permissionActions";
export type { PermissionAction } from "./permissionActions";

export {
  isToolAllowedForPolicy,
  toolNameFromRef,
} from "./collabProtocol";

export {
  STEP_STATUSES, STEP_TERMINAL, STEP_BLOCKING, STEP_TRANSITIONS,
  RUN_STATUSES, RUN_TERMINAL, RUN_TRANSITIONS,
  COLLAB_PHASES, COLLAB_TERMINAL, COLLAB_TRANSITIONS,
  transitionStep, transitionRun, transitionCollab,
  tryTransitionStep, tryTransitionRun, tryTransitionCollab,
  normalizeStepStatus, normalizeRunStatus, normalizeCollabPhase,
  checkStateInvariant,
  AGENT_PHASES, AGENT_TRANSITIONS, AGENT_TERMINAL,
  tryTransitionAgent, transitionAgent, isAgentTerminal,
  mapOrchestrationToAgent, mapAgentToOrchestration,
} from "./stateMachine";
export type {
  StepStatus, RunStatus, CollabPhase, AgentPhase,
  TransitionViolation, TransitionResult, StateInvariantViolation,
} from "./stateMachine";

export {
  CONFIG_REGISTRY,
  getConfigsByLevel, getConfigsByScope, getRuntimeMutableConfigs, findConfigEntry,
  parseConfigValue, validateConfigValue, requiresRestart,
} from "./configRegistry";
export type { ConfigLevel, ConfigScope, ConfigValueType, ConfigEntry } from "./configRegistry";
export { validateEnvironment, formatValidationResult } from "./validateEnv";
export type { EnvValidationIssue, EnvValidationResult } from "./validateEnv";

export {
  resolveRuntimeConfig, resolveAllRuntimeConfigs,
  resolveNumber, resolveBoolean, resolveString,
  // Skill 运行时配置访问器 (P0-02)
  resolveSkillRuntimeBackend,
  resolveSkillRuntimeContainerImage,
  resolveSkillRuntimeContainerUser,
  resolveSkillRuntimeRemoteEndpoint,
  resolveSkillRuntimeContainerFallback,
  type RuntimeConfigSource, type ResolvedConfig, type RuntimeConfigOverrides, type SkillRuntimeBackend,
} from "./runtimeConfig";

export {
  resolveSupplyChainPolicy, checkTrust, checkDependencyScan, checkSbom,
  decideIsolation, supplyChainGate,
  // 生产基线校验 (P0-04)
  validateProductionBaseline,
  assertProductionBaseline,
} from "./supplyChainPolicy";
export type {
  IsolationLevel, ScanMode, DegradationStrategy, SupplyChainPolicyConfig,
  TrustCheckResult, ScanCheckResult, SbomCheckResult,
  IsolationDecision, SupplyChainGateResult,
  ProductionBaselineResult,
} from "./supplyChainPolicy";

// ─── 统一运行时模块 (P0-01) ───────────────────────────────────────────────────
export {
  isPlainObject,
  normalizeStringSet,
  normalizeLimits,
  normalizeNetworkPolicy,
  isAllowedHost,
  isAllowedEgress,
  runtimeFetch,
  withConcurrency,
  withTimeout,
  setConcurrencyBackend,
  getConcurrencyBackend,
  createRedisConcurrencyBackend,
} from "./runtime";
export type {
  RuntimeLimits,
  NetworkPolicyRule,
  NetworkPolicy,
  EgressEvent,
  EgressCheck,
  ConcurrencyBackend,
} from "./runtime";

// ─── Skill 沙箱基线模块 (P0-03) ───────────────────────────────────────────
export {
  SANDBOX_FORBIDDEN_MODULES_BASE,
  SANDBOX_FORBIDDEN_MODULES_STRICT,
  SANDBOX_FORBIDDEN_MODULES_DATABASE,
  SANDBOX_BLOCKED_MODULES,
  SANDBOX_BLOCKED_HIGH_RISK,
  SANDBOX_BLOCKED_MEDIUM_RISK,
  SANDBOX_BLOCKED_LOW_RISK,
  resolveSandboxMode,
  buildForbiddenModulesSet,
  lockdownDynamicCodeExecution,
  restoreDynamicCodeExecution,
  pickExecute,
  checkModuleForbidden,
  createModuleLoadInterceptor,
  getRiskLevel,
  isModuleBlocked,
  assertModuleAllowed,
} from "./skillSandbox";
export type {
  SandboxMode,
  DynamicCodeLockState,
  RiskLevel,
} from "./skillSandbox";

// ─── 统一 Skill 沙箱执行框架 ─────────────────────────────────────────────
export {
  SkillProcessPool,
  createSandboxExecutor,
  createSandboxExecutorWithPool,
} from "./skillExecutor";
export type {
  SkillExecuteRequest,
  SkillExecuteResponse,
  SandboxExecutor,
  SandboxExecutorOptions,
  SkillVersionSwitch,
} from "./skillExecutor";

// ─── P2-4: 统一协作协议 + P2-03: 通用 DAG 工具函数 ──────────────────────
export {
  validateDAG, detectCycleNodes, topologicalSortGeneric,
  wouldCreateCycle, getAncestors, getDescendants,
} from "./dagUtils";
export type { DagNode, DagValidationResult } from "./dagUtils";

// ─── P0-2: GoalGraph + WorldState (结构化目标图 + 世界状态) ──────────────────
export {
  createGoalGraph, getExecutableSubGoals, computeGoalProgress,
  isGoalGraphComplete, validateGoalGraphDAG, topologicalSort,
  getParallelSubGoalGroups,
} from "./goalGraph";
export type {
  GoalEdgeType, GoalCondition, SuccessCriterion, CompletionEvidence,
  SubGoalStatus, SubGoal, GoalGraphStatus, GoalGraph,
} from "./goalGraph";

export {
  createWorldState, upsertEntity, addRelation, upsertFact,
  batchUpsertEntities, batchAddRelations,
  getValidFacts, getEntityRelations, getEntitiesByCategory,
  worldStateToPromptText,
  detectWorldStateConflicts, mergeWorldStates,
} from "./worldState";
export type {
  EntityCategory, WorldEntity, RelationType, WorldRelation,
  FactCategory, WorldFact, WorldState,
  WorldStateSource, WorldStateEntry, WorldStateConflict,
} from "./worldState";

// ─── OTel 初始化工具 ─────────────────────────────────────────────────
export { bootstrapOtel, parseOtelHeaders, isOtelEnabled, getOtlpEndpoint, createAdaptiveSampler } from "./otelBootstrap";
export type { AdaptiveSamplerOpts } from "./otelBootstrap";

// ─── Agent Tracing ─────────────────────────────────────────────────
export {
  startAgentTracing,
  startIteration,
  startPhase,
  endPhase,
  traceToolCall,
  endAgentTracing,
} from "./agentTracing";
export type {
  AgentSpanAttrs,
  AgentTracingContext,
  TracingSpan,
  TracingTracer,
} from "./agentTracing";

// ─── P0-02: 通用熔断器 ─────────────────────────────────────────────────
export {
  CircuitBreaker, CircuitOpenError,
  getOrCreateBreaker, getAllBreakerMetrics, clearBreakerRegistry,
} from "./circuitBreaker";
export type {
  CircuitBreakerState, CircuitBreakerOptions,
  CircuitBreakerStateChangeEvent, CircuitBreakerMetrics,
} from "./circuitBreaker";

// ─── P1-01: 统一事件总线核心类型 ────────────────────────────────────
export {
  SystemEventType,
  EventChannels,
  EVENT_BUS_CHANNEL_PREFIX,
  eventBusRedisChannel,
  stepDoneRedisChannel,
  CRITICAL_EVENT_CHANNELS,
  NON_CRITICAL_EVENT_CHANNELS,
  isCriticalChannel,
} from "./eventBus";
export type {
  SystemEventTypeValue,
  EventEnvelope,
  EventHandler,
  EventBusSubscription,
  EventChannelValue,
  EventBus,
  EventBusBackend,
  PubSubBackend,
  StreamsBackend,
} from "./eventBus";

export {
  collabStreamRedisChannel,
  createCollabStreamSignal,
} from "./collabStream";
export type { CollabStreamSignal, CollabStreamSignalKind } from "./collabStream";

// ─── 公共基础配置 ─────────────────────────────────────────────────
export { loadDbConfig, loadRedisConfig, loadMasterKey } from "./configBase";
export type { DbConfig, RedisConfig } from "./configBase";
export {
  isConsensusReached,
  validateCollabMessage,
  validateConsensusProposal,
  createDebateSession,
  createDebateSession as createDebateSessionV2,
  isDebateConverged,
  isDebateConverged as isDebateConvergedV2,
  computeDebateConsensusScore,
  COLLAB_CONFIG_DEFAULTS,
  collabConfig,
} from "./collabProtocol";
export type {
  CollabMessageType,
  CollabMessage,
  CollabMessageEnvelope,
  MessagePriority,
  MessageStatus,
  ConsensusProposal,
  ConsensusVote,
  ConsensusQuorumType,
  RoleCapabilityDeclaration,
  DiscoveryQuery,
  DiscoveryReply,
  CollabStateSnapshot,
  SyncAck,
  DebatePosition,
  DebateRound,
  DebateVerdict,
  DebateSession,
  DebateParty,
  DebateCorrection,
  ConsensusEvolutionEntry,
} from "./collabProtocol";

// ── Agent Loop 核心类型 ──
export {
  isBudgetExhausted, recordTokenUsage, recordCostUsage, createDefaultBudget,
} from "./agentLoopTypes";
export type {
  AgentDecisionAction, AgentDecision, StepObservation,
  ExecutionConstraints, TokenBudget, CostBudget, LoopBudget,
  AgentLoopResult, DecisionQualityScore,
} from "./agentLoopTypes";

// ── Runner 协议统一类型 ──
export {
  computeRunnerRequestBodyDigestV1, computeRunnerResponseBodyDigestV1,
  signRunnerRequestV1, verifyRunnerRequestSignatureV1,
  signRunnerResponseV1, verifyRunnerResponseSignatureV1,
  loadTrustedWorkerKeysFromEnv,
} from "./runnerProtocol";
export type {
  RunnerErrorCode, RunnerErrorCategory,
  RunnerEgressSummaryV1, RunnerResourceUsageSummaryV1,
  RunnerExecuteRequestV1, RunnerExecuteResponseV1,
} from "./runnerProtocol";

// ── 统一错误处理 ──
export { ServiceError, classifyError, toHttpResponse } from "./serviceError";
export { ErrorCategory as ServiceErrorCategory } from "./serviceError";

// ── 统一认证上下文 ──
export type { AuthContext, AuthProvider, Permission } from "./authContext";

// ── 统一追踪上下文 ──
export { createTraceContext, injectTraceHeaders, extractTraceContext } from "./traceContext";
export type { TraceContext } from "./traceContext";

// ── Skill RPC Protocol ──
export {
  SKILL_RPC_VERSION, SKILL_RPC_JSONRPC, SKILL_RPC_ERRORS, SKILL_RPC_METHODS,
  DEVICE_PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSIONS,
  createRpcRequest, createRpcSuccess, createRpcError, createRpcNotification,
  serializeRpcMessage, parseRpcMessage,
  isRpcRequest, isRpcNotification, isRpcResponse, isRpcError,
  isVersionCompatible, negotiateVersion,
} from "./skillRpcProtocol";
export type {
  ProtocolVersion, ProtocolHandshake, ProtocolHandshakeAck,
  DeviceModality, DeviceMultimodalCapabilities, DeviceMultimodalPolicy,
  DeviceAttachment, DeviceMultimodalQuery, DeviceMultimodalResponse,
  SkillRpcRequest, SkillRpcSuccess, SkillRpcError, SkillRpcNotification,
  SkillRpcResponse, SkillRpcMessage,
  SkillInitializeParams, SkillInitializeResult,
  SkillExecuteParams, SkillExecuteResult,
  SkillHeartbeatParams, SkillHeartbeatResult,
  SkillProgressNotification, SkillLogNotification,
} from "./skillRpcProtocol";

// ── P3-01: 结构化日志 ──────────────────────────────────────────
export {
  StructuredLogger,
  initRootLogger,
  getRootLogger,
  createModuleLogger,
  createRequestLogContext,
  redactSensitiveFields,
  shouldSample,
  safeStringify,
  DEFAULT_SAMPLING_RULES,
} from "./structuredLogger";
export type {
  LogLevel,
  StructuredLogEntry,
  LogContext,
  SamplingRule,
  StructuredLoggerConfig,
} from "./structuredLogger";

// ── 工具别名解析器（共享） ──
export {
  DEFAULT_TOOL_ALIASES,
  DEFAULT_PREFIX_RULES,
  createToolAliasResolver,
  resolveToolAlias,
  isDeviceToolName,
} from "./toolAliasResolver";

// ── 统一密码学工具 & 稳定序列化 & 审计哈希链 ──
export {
  sha256Hex, sha256HexBytes, sha256_8,
  stableStringifyValue, stableStringify,
  canonicalize, canonicalStringify,
  computeEventHash,
  digestObject,
} from "./cryptoUtils";

// ── 工作流写租约（分布式写锁） ──
export {
  acquireWriteLease, renewWriteLease, releaseWriteLease,
} from "./writeLease";
export type { WriteLeaseOwner } from "./writeLease";

// ── 统一文档解析引擎 ──
export {
  parseDocument,
  registerDocumentParser,
  registerBuiltinDocumentParsers,
  getDocumentParser,
  listDocumentParsers,
  findParserByMimeType,
  findParserByFileName,
  listSupportedMimeTypes,
  listSupportedFormats,
  detectFormat,
  mimeToFormat,
  extensionToFormat,
  dataUrlToBuffer,
  defaultParseConfig,
  DEFAULT_PARSE_CONFIG,
  resolveParseConfigFromEnv,
} from "./documentParser";
export type {
  DocumentFormatName,
  DocumentElementType,
  DocumentElement,
  DocumentParseResult,
  DocumentMetadata,
  DocumentParseStats,
  DocumentParseConfig,
  DocumentParser,
  DocumentParseInput,
} from "./documentParser";

// ── Skill Manifest 共享类型与运行时验证 ──
export {
  validateManifest,
} from "./skillManifest";
export type {
  SkillLayer, SkillToolDeclaration,
  BuiltinSkillManifest, ExternalSkillManifest,
  ManifestValidationResult,
} from "./skillManifest";

// ── 编排内核事件协议（Worker ↔ API 状态同步） ──
export {
  OrchestrationEventType,
  OrchestrationCommandType,
  createOrchestrationEvent,
  buildStepExecutionResult,
} from "./orchestrationEvents";
export type {
  OrchestrationEvent,
  StepExecutionResult,
  OrchestrationCommand,
} from "./orchestrationEvents";

// ── 统一流式事件类型 ──
export {
  StreamEventType,
  STREAM_EVENT_SSE_NAME,
  createStreamEvent,
  getStreamEventSseName,
} from "./streamEvents";
export type {
  StreamEvent,
  StreamController,
} from "./streamEvents";

// ── 安全状态转换（跨包统一） ──
export { safeTransitionRun, purgeStaleStateEvents } from "./stateTransition";
export type { PoolLike, SafeTransitionRunOpts } from "./stateTransition";

// ── metadata registry ─────────────────────────────────────────────
export {
  registerMetadata,
  resolveMetadata,
  listMetadata,
  deactivateMetadata,
  isMetadataEnabled,
} from "./metadataRegistry";
export type {
  MetadataEntry,
  MetadataKind,
  MetadataScopeType,
  MetadataQuery,
  MetadataResolveOpts,
  MetadataRegistryDeps,
  RolloutMode,
} from "./metadataRegistry";

// ── 统一审批判定（API / Worker 共用 Single Source of Truth） ──
export { shouldRequireApproval } from "./approvalDecision.js";

// ── cache manager ─────────────────────────────────────────────
export {
  createMemoryCacheManager,
  createLayeredCacheManager,
} from "./cacheManager";
export type {
  CacheManager,
  CacheStats,
  CacheTier,
  MemoryCacheOpts,
  LayeredCacheOpts,
} from "./cacheManager";

// ── config hot update ─────────────────────────────────────────
export { createConfigHotUpdater } from "./configHotUpdate";
export type {
  ConfigChangeEvent,
  ConfigApplyResult,
  ConfigHotUpdater,
  ConfigHotUpdaterDeps,
} from "./configHotUpdate";

// ── metrics schema ────────────────────────────────────────────
export {
  AGENT_METRICS,
  toPrometheusName,
  listMetricNames,
  getMetricDefinition,
} from "./metricsSchema";
export type { MetricDefinition, MetricType } from "./metricsSchema";

