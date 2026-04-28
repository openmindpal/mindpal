/**
 * Device-OS 内核统一导出入口
 * @layer kernel
 *
 * [SDK迁移] 与原 apps/device-agent/src/kernel/index.ts 对比变更：
 * - `../log` → `./log`（SDK 内置日志模块）
 * - `../api` re-export 已移除（apiPostJson/apiGetJson 属于应用层）
 * - 新增 SDK 解耦注入 API（setSecretKeyProvider, setCapabilityProbeProvider 等）
 */

// ── 内核清单与边界 ──────────────────────────────────────────
export { KERNEL_MODULES, KERNEL_MODULE_DESCRIPTORS, NON_KERNEL_KEYWORDS, validateKernelManifest, assertKernelManifest } from "./KERNEL_MANIFEST";
export type { KernelModule, KernelModuleDescriptor, BoundaryValidationIssue } from "./KERNEL_MANIFEST";
export { PLUGIN_DOMAINS, CURRENT_PLUGIN_FILES, validatePluginBoundary, assertPluginBoundary } from "./PLUGIN_BOUNDARY";
export type { PluginDomain } from "./PLUGIN_BOUNDARY";

// ── 公共类型 ────────────────────────────────────────────────
export type {
  DeviceAgentConfig, ToolRef, CapabilityDescriptor, RiskLevel,
  TaskState, PluginState, AuditEventType, AuditEvent, EvidenceRef,
  MessageEnvelope, PluginResourceLimits, DeviceToolPlugin,
  ToolExecutionContext, ToolExecutionResult, DeviceMessageContext,
  CachedPolicy, PolicyCacheEntry, CallerIdentity, DeviceClaimEnvelope,
  DeviceCapabilityReport,
} from "./types";
export { parseToolRef, toolName, TASK_STATE_TRANSITIONS, isTerminalState, isValidTransition } from "./types";

// ── 日志工具 ────────────────────────────────────────────────
export { sha256_8, safeLog, safeError } from "./log";

// ── 模块 #1：设备身份与配对 ─────────────────────────────────
export {
  DeviceIdentity, defaultConfigPath, defaultLockPath,
  loadConfigFile, saveConfigFile,
  killExistingInstance, acquireLock, releaseLock, isAnotherInstanceRunning,
} from "./identity";
export type { LockInfo } from "./identity";

// ── 模块 #2：安全认证与策略下发 ──────────────────────────────
export {
  initAccessControl, getAccessPolicy,
  generateCallerToken, verifyCallerToken, isCallerAllowed, isToolAllowed,
  extractCallerFromRequest,
  getOrCreateContext, getContext, destroyContext, cleanupExpiredContexts,
  getContextState, setContextState, deleteContextState, getAccessStats,
  initPolicyCache, cachePolicy, getCachedPolicy, hasCachedPolicy,
  isCachedToolAllowed, getCachedPolicyForExecution, clearPolicyCache,
  syncPolicyToCache, buildOfflineClaim, getPolicyCacheStatus,
} from "./auth";
export type { AccessPolicy, ExecutionContext } from "./auth";

// ── 模块 #3：能力注册与发现 ──────────────────────────────────
export {
  registerCapability, registerCapabilities, unregisterCapability,
  unregisterPluginCapabilities, getCapability, findCapabilitiesByPrefix,
  findCapabilitiesByRiskLevel, findCapabilitiesByTag, listCapabilities,
  getToolRiskLevel, registerPlugin, unregisterPlugin, findPluginForTool,
  listPlugins, clearAll, dispatchMessageToPlugins,
  // 动态别名注册表 API
  registerToolAlias, registerToolAliases,
  registerPrefixRule, registerPrefixRules,
  resolveToolAlias, listToolAliases, listPrefixRules,
  loadAliasesFromFile, loadAliasesFromEnv, initToolAliases,
  exportCapabilityManifest,
  getMultimodalCapabilities,
} from "./capabilityRegistry";
export type { CapabilityManifestEntry } from "./capabilityRegistry";

// ── 模块 #4：任务执行引擎 ────────────────────────────────────
export {
  executeDeviceTool,
} from "./taskExecutor";
export type { TaskPriority, QueuedTask, TaskResult, TaskQueueConfig } from "./session";

// ── 模块 #5：会话管理与状态同步 ──────────────────────────────
export {
  initHeartbeat, stopHeartbeat, sendHeartbeat, getHeartbeatStatus,
  createSession, getSession, getActiveSessionByType, getOrCreateSession,
  touchSession, updateSessionMetadata, closeSession, getActiveSessions, cleanupExpiredSessions,
  initSessionManager, shutdownSessionManager, getSessionManagerStatus,
  ExecutionSession, getDefaultExecutionSession, resetDefaultExecutionSession,
} from "./session";
export type { SessionType, DeviceSession, HeartbeatConfig, SessionConfig } from "./session";

// ── 模块 #6：审计与证据 ─────────────────────────────────────
export {
  initAudit, getAuditDir, isAuditEnabled, logAuditEvent,
  auditToolStart, auditToolSuccess, auditToolFailed, auditToolDenied,
  cleanupOldAuditLogs, readAuditLogs,
  uploadArtifact, recordReplayTrace,
} from "./audit";
export type { ArtifactUploadParams, ArtifactUploadResult } from "./audit";

// ── 模块 #7：多通道通信 ─────────────────────────────────────
// [SDK迁移] apiPostJson/apiGetJson 属于应用层，不再 re-export
export {
  createMessageEnvelope, isMessageExpired,
  withRetry, createAck, createNack,
} from "./transport";
export type { RetryOptions, AckResponse, NackResponse } from "./transport";

// ── 模块 #8：插件生命周期管理 ─────────────────────────────────
export {
  initPlugin, disposePlugin, disposeAllPlugins,
  upgradePlugin, rollbackPlugin,
  healthcheckPlugin, healthcheckAllPlugins,
  getPluginState, getPluginError, getPluginResourceLimits, listPluginStates,
  registerPluginDirect,
  setOnCapabilityChanged,
  setCurrentDeviceType, getCurrentDeviceType,
  getUnavailableCapabilities,
} from "./pluginLifecycle";

// ── 工具级灰度开关 + 熔断器 ─────────────────────────────

export {
  initFeatureFlags, loadFeatureFlagsFromEnv,
  syncFeatureFlagsFromPolicy, syncDegradationRules,
  setCircuitBreakerConfig,
  isToolFeatureEnabled, getDegradationRule,
  recordToolSuccess, recordToolFailure,
  getCircuitBreakerState, listFeatureFlags, resetFeatureFlags,
} from "./toolFeatureFlags";
export type { ToolFeatureFlag, CircuitBreakerConfig, CircuitState, DegradationRule } from "./toolFeatureFlags";

// ── 端侧工具指标采集 ───────────────────────────────

export {
  setMetricsWindow, recordToolMetric, recordFromExecution,
  getToolMetrics, getToolMetricsSummary, exportMetricsSnapshot,
  resetMetrics,
} from "./toolMetrics";
export type { ToolMetricsSample, ToolMetricsSummary } from "./toolMetrics";

// ── SDK 依赖注入 API ────────────────────────────────────────
// 以下注入函数供应用层在创建内核后绑定外部依赖

export { setSecretKeyProvider, setCapabilityProbeProvider } from "./pluginLifecycle";
export { setCapabilityReportProvider } from "./session";
export { setBuiltinToolPlugin } from "./taskExecutor";
export { setNativeGuiProvider, executeNativeGuiAction, SCREEN_CHANGING_ACTIONS } from "./guiActionKernel";
export type { NativeGuiProvider, GuiActionTarget, GuiActionResult, GuiActionParams } from "./guiActionKernel";

// ── OCR 缓存服务 ────────────────────────────────────────────
export { OcrCacheService, getOcrCacheService, resetOcrCacheService } from "./ocrCacheService";

// ── 插件沙箱 ────────────────────────────────────────────────
export { verifyPluginSignature, createPluginSandbox, executeInSandbox } from "./pluginSandbox";
export type { PluginManifest } from "./pluginSandbox";
