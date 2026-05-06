use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── 设备身份 ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceType {
    Desktop,
    Mobile,
    Iot,
    Robot,
    Vehicle,
    Home,
    Gateway,
}

// ── 能力描述符 ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRequirements {
    pub memory_mb: Option<u32>,
    pub cpu_percent: Option<u32>,
    pub disk_mb: Option<u32>,
    pub network_required: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDescriptor {
    pub tool_ref: String,
    pub input_schema: Option<serde_json::Value>,
    pub output_schema: Option<serde_json::Value>,
    pub risk_level: RiskLevel,
    pub resource_requirements: Option<ResourceRequirements>,
    pub concurrency_limit: Option<u32>,
    pub version: Option<String>,
    pub tags: Option<Vec<String>>,
    pub description: Option<String>,
}

// ── 任务状态机 ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Pending,
    Claimed,
    Running,
    Succeeded,
    Failed,
    Canceled,
    TimedOut,
}

impl TaskState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskState::Succeeded | TaskState::Failed | TaskState::Canceled | TaskState::TimedOut
        )
    }

    pub fn valid_transitions(&self) -> &[TaskState] {
        match self {
            TaskState::Pending => &[TaskState::Claimed, TaskState::Canceled, TaskState::TimedOut],
            TaskState::Claimed => &[TaskState::Running, TaskState::Canceled, TaskState::TimedOut],
            TaskState::Running => &[
                TaskState::Succeeded,
                TaskState::Failed,
                TaskState::Canceled,
                TaskState::TimedOut,
            ],
            TaskState::Succeeded => &[],
            TaskState::Failed => &[],
            TaskState::Canceled => &[],
            TaskState::TimedOut => &[],
        }
    }

    pub fn can_transition_to(&self, target: TaskState) -> bool {
        self.valid_transitions().contains(&target)
    }
}

// ── 插件状态机 ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PluginState {
    Unloaded,
    Initializing,
    Registered,
    Healthchecking,
    Ready,
    Executing,
    Disposing,
    Disposed,
    Upgrading,
    RollingBack,
    Error,
}

// ── 审计事件 ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AuditEventType {
    #[serde(rename = "tool.execute.start")]
    ToolExecuteStart,
    #[serde(rename = "tool.execute.success")]
    ToolExecuteSuccess,
    #[serde(rename = "tool.execute.failed")]
    ToolExecuteFailed,
    #[serde(rename = "tool.execute.denied")]
    ToolExecuteDenied,
    #[serde(rename = "auth.verify")]
    AuthVerify,
    #[serde(rename = "auth.token.rotate")]
    AuthTokenRotate,
    #[serde(rename = "policy.check")]
    PolicyCheck,
    #[serde(rename = "policy.cache.sync")]
    PolicyCacheSync,
    #[serde(rename = "session.start")]
    SessionStart,
    #[serde(rename = "session.end")]
    SessionEnd,
    #[serde(rename = "session.heartbeat")]
    SessionHeartbeat,
    #[serde(rename = "plugin.init")]
    PluginInit,
    #[serde(rename = "plugin.dispose")]
    PluginDispose,
    #[serde(rename = "plugin.healthcheck")]
    PluginHealthcheck,
    #[serde(rename = "device.enroll")]
    DeviceEnroll,
    #[serde(rename = "device.pair")]
    DevicePair,
    #[serde(rename = "device.revoke")]
    DeviceRevoke,
    #[serde(rename = "evidence.upload")]
    EvidenceUpload,
    #[serde(rename = "replay.trace")]
    ReplayTrace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub event_id: String,
    pub timestamp: String,
    pub event_type: AuditEventType,
    pub device_id: String,
    pub tool_ref: Option<String>,
    pub tool_name: Option<String>,
    pub execution_id: Option<String>,
    pub caller_id: Option<String>,
    pub status: Option<String>,
    pub error_category: Option<String>,
    pub duration_ms: Option<u64>,
    pub input_digest: Option<serde_json::Value>,
    pub output_digest: Option<serde_json::Value>,
    pub policy_digest: Option<serde_json::Value>,
    pub evidence_refs: Option<Vec<String>>,
    pub parent_event_id: Option<String>,
    pub trace_chain: Option<Vec<String>>,
    pub extra: Option<HashMap<String, serde_json::Value>>,
}

// ── 消息信封 ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEnvelope {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub correlation_id: String,
    pub timestamp: u64,
    pub payload: HashMap<String, serde_json::Value>,
    pub reply_to: Option<String>,
    pub idempotency_key: Option<String>,
    pub ttl_ms: Option<u64>,
}

// ── 插件资源限制 ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginResourceLimits {
    pub max_memory_mb: Option<u32>,
    pub max_cpu_percent: Option<u32>,
    pub max_concurrency: Option<u32>,
    pub max_execution_time_ms: Option<u64>,
}

// ── 执行上下文与结果 ─────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ToolExecutionContext {
    pub api_base: String,
    pub device_token: String,
    pub execution_id: String,
    pub tool_ref: String,
    pub tool_name: String,
    pub input: serde_json::Value,
    pub policy: Option<serde_json::Value>,
    pub require_user_presence: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionStatus {
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionResult {
    pub status: ExecutionStatus,
    pub error_category: Option<String>,
    pub output_digest: Option<serde_json::Value>,
    pub evidence_refs: Option<Vec<String>>,
}

// ── 策略类型 ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceClaimEnvelope {
    pub execution: ClaimExecution,
    pub require_user_presence: Option<bool>,
    pub policy: Option<serde_json::Value>,
    pub policy_digest: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimExecution {
    pub device_execution_id: String,
    pub tool_ref: String,
    pub input: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPolicy {
    pub allowed_tools: Option<Vec<String>>,
    pub file_policy: Option<serde_json::Value>,
    pub network_policy: Option<serde_json::Value>,
    pub ui_policy: Option<serde_json::Value>,
    pub evidence_policy: Option<serde_json::Value>,
    pub clipboard_policy: Option<serde_json::Value>,
    pub limits: Option<serde_json::Value>,
    pub tool_feature_flags: Option<HashMap<String, bool>>,
    pub degradation_rules: Option<HashMap<String, DegradationRule>>,
    pub circuit_breaker_config: Option<CircuitBreakerConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DegradationRule {
    pub fallback_tool: Option<String>,
    pub error_category: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitBreakerConfig {
    pub failure_threshold: Option<u32>,
    pub half_open_window_ms: Option<u64>,
    pub half_open_max_attempts: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyCacheEntry {
    pub device_id: String,
    pub policy: CachedPolicy,
    pub policy_digest: String,
    pub cached_at: String,
    pub expires_at: String,
    pub version: u32,
}

// ── 健康检查 ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthStatus {
    pub healthy: bool,
    pub details: Option<HashMap<String, serde_json::Value>>,
}

// ── 核心 DevicePlugin trait ──────────────────────────────────

#[async_trait]
pub trait DevicePlugin: Send + Sync {
    fn name(&self) -> &str;
    fn tool_prefixes(&self) -> Vec<String>;
    fn tool_names(&self) -> Vec<String>;
    fn capabilities(&self) -> Vec<CapabilityDescriptor>;
    fn version(&self) -> &str;
    async fn init(&mut self) -> anyhow::Result<()>;
    async fn healthcheck(&self) -> anyhow::Result<HealthStatus>;
    async fn execute(&self, ctx: ToolExecutionContext) -> anyhow::Result<ToolExecutionResult>;
    async fn dispose(&mut self) -> anyhow::Result<()>;
}

// ── 调用方身份 ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdentity {
    pub caller_id: String,
    pub caller_type: CallerType,
    pub tenant_id: Option<String>,
    pub subject_id: Option<String>,
    pub verified_at: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CallerType {
    Api,
    Local,
    Plugin,
}

// ── 设备能力探测报告 ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCapabilityReport {
    pub probed_at: String,
    pub platform: String,
    pub arch: String,
    pub total_memory_mb: u64,
    pub free_memory_mb: u64,
    pub cpu_cores: u32,
    pub hardware: HashMap<String, serde_json::Value>,
    pub software: HashMap<String, serde_json::Value>,
    pub network: HashMap<String, serde_json::Value>,
}

// ── 工具引用解析 ─────────────────────────────────────────────

pub struct ParsedToolRef {
    pub name: String,
    pub version: Option<String>,
}

pub fn parse_tool_ref(tool_ref: &str) -> ParsedToolRef {
    match tool_ref.find('@') {
        Some(idx) if idx > 0 => ParsedToolRef {
            name: tool_ref[..idx].to_string(),
            version: Some(tool_ref[idx + 1..].to_string()),
        },
        _ => ParsedToolRef {
            name: tool_ref.to_string(),
            version: None,
        },
    }
}

pub fn tool_name(tool_ref: &str) -> String {
    parse_tool_ref(tool_ref).name
}
