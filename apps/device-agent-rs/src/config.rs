use crate::types::DeviceType;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── 插件配置 ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfig {
    pub builtin_plugins: Vec<String>,
    pub plugin_dirs: Option<Vec<String>>,
    pub skill_dirs: Option<Vec<String>>,
    pub updated_at: Option<String>,
    pub source: Option<String>,
}

// ── 完整配置 ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAgentFullConfig {
    pub api_base: String,
    pub device_id: String,
    pub device_token: String,
    pub enrolled_at: String,
    pub device_type: DeviceType,
    pub os: String,
    pub agent_version: String,
    pub plugin_config: Option<PluginConfig>,
}

// ── 默认路径 ─────────────────────────────────────────────────

pub fn default_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".mindpal")
        .join("device-agent.json")
}

pub fn default_lock_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".mindpal")
        .join("device-agent.lock")
}

// ── 配置文件读写 ─────────────────────────────────────────────

pub async fn load_config(path: &PathBuf) -> anyhow::Result<DeviceAgentFullConfig> {
    let content = tokio::fs::read_to_string(path).await?;
    let cfg: DeviceAgentFullConfig = serde_json::from_str(&content)?;
    Ok(cfg)
}

pub async fn save_config(path: &PathBuf, cfg: &DeviceAgentFullConfig) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let content = serde_json::to_string_pretty(cfg)?;
    tokio::fs::write(path, content).await?;
    Ok(())
}

// ── 锁文件管理 ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockInfo {
    pub pid: u32,
    pub started_at: String,
    pub heartbeat_at: String,
    pub hostname: String,
}

pub async fn acquire_lock() -> anyhow::Result<()> {
    let lock_path = default_lock_path();
    if let Some(parent) = lock_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let info = LockInfo {
        pid: std::process::id(),
        started_at: chrono::Utc::now().to_rfc3339(),
        heartbeat_at: chrono::Utc::now().to_rfc3339(),
        hostname: gethostname::gethostname()
            .to_string_lossy()
            .to_string(),
    };
    let content = serde_json::to_string(&info)?;
    tokio::fs::write(&lock_path, content).await?;
    Ok(())
}

pub async fn release_lock() -> anyhow::Result<()> {
    let lock_path = default_lock_path();
    if lock_path.exists() {
        tokio::fs::remove_file(&lock_path).await?;
    }
    Ok(())
}

pub async fn kill_existing_instance() -> anyhow::Result<bool> {
    let lock_path = default_lock_path();
    if !lock_path.exists() {
        return Ok(false);
    }
    let content = tokio::fs::read_to_string(&lock_path).await?;
    let info: LockInfo = serde_json::from_str(&content)?;

    // 如果是当前进程，不需要清理
    if info.pid == std::process::id() {
        return Ok(false);
    }

    // 清理过期锁文件
    tokio::fs::remove_file(&lock_path).await?;
    Ok(true)
}
