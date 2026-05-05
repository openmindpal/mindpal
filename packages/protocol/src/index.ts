/**
 * @mindpal/protocol — MindPal Agent OS 协议层标准定义
 *
 * 统一 re-export 所有协议模块，提供单一入口点。
 */

// ── Registry Infrastructure ──
export {
  createRegistry,
  builtInEntry,
  registryIds,
} from "./registry";

export type {
  RegistryEntry,
  TypeRegistry,
  ValidationResult,
} from "./registry";

// ── Skill RPC Protocol ──
export {
  SKILL_RPC_VERSION,
  SKILL_RPC_JSONRPC,
  DEVICE_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  JSONRPC_STANDARD_ERRORS,
  BUILTIN_CUSTOM_ERRORS,
  skillErrorCodeRegistry,
  SKILL_RPC_ERRORS,
  SKILL_RPC_METHODS,
  BUILTIN_DEVICE_MODALITIES,
  modalityRegistry,
  BUILTIN_SKILL_RUNTIMES,
  runtimeRegistry,
  BUILTIN_SENSITIVITY_PROFILES,
  sensitivityProfileRegistry,
  isVersionCompatible,
  negotiateVersion,
  createRpcRequest,
  createRpcSuccess,
  createRpcError,
  createRpcNotification,
  serializeRpcMessage,
  parseRpcMessage,
  isRpcRequest,
  isRpcNotification,
  isRpcResponse,
  isRpcError,
} from "./skill-rpc";

export type {
  ProtocolVersion,
  ProtocolHandshake,
  ProtocolHandshakeAck,
  DeviceModality,
  DeviceMultimodalCapabilities,
  DeviceMultimodalPolicy,
  DeviceAttachment,
  DeviceMultimodalQuery,
  DeviceMultimodalResponse,
  SkillRuntime,
  SensitivityProfile,
  SkillRpcRequest,
  SkillRpcSuccess,
  SkillRpcError,
  SkillRpcNotification,
  SkillRpcResponse,
  SkillRpcMessage,
  SkillInitializeParams,
  SkillInitializeResult,
  SkillExecuteParams,
  SkillExecuteResult,
  SkillHeartbeatParams,
  SkillHeartbeatResult,
  SkillProgressNotification,
  SkillLogNotification,
} from "./skill-rpc";

// ── Skill Manifest ──
export {
  validateManifest,
  BUILTIN_SKILL_LAYERS,
  skillLayerRegistry,
} from "./skill-manifest";

export type {
  SkillLayer,
  SkillToolDeclaration,
  BuiltinSkillManifest,
  ExternalSkillManifest,
  ManifestValidationResult,
} from "./skill-manifest";

// ── Collaboration Message Protocol ──
export {
  COLLAB_CONFIG_DEFAULTS,
  toolNameFromRef,
  isToolAllowedForPolicy,
  isConsensusReached,
  validateCollabMessage,
  validateConsensusProposal,
  BUILTIN_COLLAB_MESSAGE_TYPES,
  collabMessageRegistry,
  isValidCollabMessageType,
  BUILTIN_QUORUM_TYPES,
  quorumRegistry,
  BUILTIN_PROPOSAL_TOPICS,
  proposalTopicRegistry,
  BUILTIN_VERDICT_OUTCOMES,
  verdictOutcomeRegistry,
  BUILTIN_CORRECTION_TYPES,
  correctionTypeRegistry,
} from "./collab-message";

export type {
  MessagePriority,
  MessageStatus,
  CollabMessageType,
  CollabMessageEnvelope,
  CollabMessage,
  ConsensusProposal,
  ConsensusQuorumType,
  ConsensusVote,
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
  DebateConfig,
} from "./collab-message";

// ── Device Handshake Security ──
export {
  DEFAULT_SECURITY_POLICY,
  BUILTIN_AUTH_LEVELS,
  authLevelRegistry,
  BUILTIN_SECURITY_PROFILES,
  securityProfileRegistry,
} from "./device-handshake";

export type {
  DeviceSecurityPolicy,
  HandshakeSecurityExt,
  HandshakeAckSecurityExt,
  DeviceSessionState,
  SecureDeviceMessage,
} from "./device-handshake";

// ── Audit Event ──
export {
  AUDIT_ERROR_CATEGORIES,
  HIGH_RISK_AUDIT_ACTIONS,
  AuditContractError,
  normalizeAuditErrorCategory,
  isHighRiskAuditAction,
  generateHumanSummary,
  withPolicySnapshotRef,
  BUILTIN_ERROR_CATEGORY_ALIASES,
  errorCategoryAliasRegistry,
  BUILTIN_HIGH_RISK_ACTIONS,
  highRiskActionRegistry,
} from "./audit-event";

export type {
  AuditQueryable,
  AuditPoolLike,
  AuditClientLike,
  AuditEventInput,
  AuditWriter,
  DetailedAuditEventInput,
  AuditErrorCategory,
  InsertAuditEventOptions,
  AuditEvidenceRef,
} from "./audit-event";

// ── State Machine ──
export {
  STEP_STATUSES,
  STEP_TERMINAL,
  STEP_BLOCKING,
  STEP_STREAMING,
  STEP_TRANSITIONS,
  RUN_STATUSES,
  RUN_TERMINAL,
  RUN_TRANSITIONS,
  COLLAB_PHASES,
  COLLAB_TERMINAL,
  COLLAB_TRANSITIONS,
  AGENT_PHASES,
  AGENT_TRANSITIONS,
  AGENT_TERMINAL,
  transitionStep,
  transitionRun,
  transitionCollab,
  transitionAgent,
  tryTransitionStep,
  tryTransitionRun,
  tryTransitionCollab,
  tryTransitionAgent,
  isAgentTerminal,
  normalizeStepStatus,
  normalizeRunStatus,
  normalizeCollabPhase,
  checkStateInvariant,
  mapOrchestrationToAgent,
  mapAgentToOrchestration,
} from "./state-machine";

export type {
  StepStatus,
  RunStatus,
  CollabPhase,
  AgentPhase,
  TransitionViolation,
  TransitionResult,
  StateInvariantViolation,
} from "./state-machine";

// ── Errors ──
export {
  PROTOCOL_ERRORS,
  JSONRPC_ERROR_RANGE,
} from "./errors";

export type {
  ProtocolErrorCode,
  SkillRpcErrorCode,
} from "./errors";
