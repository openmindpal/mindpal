use std::env;

// ── 传输模式 ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportMode {
    Auto,
    Ws,
    Http,
}

impl TransportMode {
    fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "ws" => TransportMode::Ws,
            "http" => TransportMode::Http,
            _ => TransportMode::Auto,
        }
    }
}

// ── 环境变量配置 ─────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct DeviceAgentEnv {
    /// API 服务基础 URL
    pub api_base: String,
    /// 审计日志开关
    pub audit_enabled: bool,
    /// 轻量模式（跳过访问控制和任务队列）
    pub lightweight: bool,
    /// 会话心跳开关
    pub session_heartbeat_enabled: bool,
    /// 策略缓存开关
    pub policy_cache_enabled: bool,
    /// 代理版本号
    pub agent_version: String,
    /// 操作系统标识
    pub agent_os: String,
    /// 传输模式
    pub transport: TransportMode,
    /// 自动确认（跳过人工交互）
    pub auto_confirm: bool,
    /// GUI 步骤间延迟 (ms)
    pub gui_step_delay_ms: u64,
    /// OCR 缓存 TTL (ms)
    pub ocr_cache_ttl_ms: u64,
    /// 浏览器 CDP 调试 URL
    pub browser_cdp_url: String,
    /// 访问控制密钥
    pub secret_key: Option<String>,
}

impl DeviceAgentEnv {
    /// 从环境变量读取配置，带默认值
    pub fn resolve() -> Self {
        let os_info = format!("{}-{}", env::consts::OS, env::consts::ARCH);

        Self {
            api_base: env::var("API_BASE").unwrap_or_else(|_| "http://localhost:3001".to_string()),
            audit_enabled: env::var("AUDIT_ENABLED")
                .map(|v| v != "false")
                .unwrap_or(true),
            lightweight: env::var("DEVICE_AGENT_LIGHTWEIGHT")
                .map(|v| v == "true")
                .unwrap_or(false),
            session_heartbeat_enabled: env::var("SESSION_HEARTBEAT_ENABLED")
                .map(|v| v != "false")
                .unwrap_or(true),
            policy_cache_enabled: env::var("POLICY_CACHE_ENABLED")
                .map(|v| v != "false")
                .unwrap_or(true),
            agent_version: env::var("AGENT_VERSION").unwrap_or_else(|_| "1.0.0".to_string()),
            agent_os: env::var("AGENT_OS").unwrap_or(os_info),
            transport: TransportMode::from_str(
                &env::var("DEVICE_AGENT_TRANSPORT").unwrap_or_else(|_| "auto".to_string()),
            ),
            auto_confirm: env::var("DEVICE_AGENT_AUTO_CONFIRM")
                .map(|v| v == "true")
                .unwrap_or(false)
                || env::var("AUTO_CONFIRM")
                    .map(|v| v == "true")
                    .unwrap_or(false),
            gui_step_delay_ms: env::var("DEVICE_AGENT_GUI_STEP_DELAY_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(200),
            ocr_cache_ttl_ms: env::var("DEVICE_AGENT_OCR_CACHE_TTL_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .map(|v: u64| v.max(500))
                .unwrap_or(2000),
            browser_cdp_url: env::var("DEVICE_AGENT_BROWSER_CDP_URL")
                .unwrap_or_else(|_| "http://localhost:9222".to_string()),
            secret_key: env::var("DEVICE_AGENT_SECRET_KEY").ok(),
        }
    }
}
