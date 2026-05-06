use crate::types::{AuditEvent, AuditEventType};
use std::path::PathBuf;
use std::sync::OnceLock;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use std::sync::Arc;
use tracing::{info, warn, error, debug};
use chrono::Utc;
use uuid::Uuid;

/// 审计日志管理器
pub struct AuditLogger {
    device_id: String,
    enabled: bool,
    log_dir: PathBuf,
    current_file: Arc<Mutex<Option<tokio::fs::File>>>,
    current_date: Arc<Mutex<String>>,
}

impl AuditLogger {
    pub fn new(device_id: &str, enabled: bool) -> Self {
        let log_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".mindpal")
            .join("audit");

        Self {
            device_id: device_id.to_string(),
            enabled,
            log_dir,
            current_file: Arc::new(Mutex::new(None)),
            current_date: Arc::new(Mutex::new(String::new())),
        }
    }

    /// 初始化（创建目录、打开当天日志文件）
    pub async fn init(&self) -> anyhow::Result<()> {
        if !self.enabled {
            info!("Audit logging disabled");
            return Ok(());
        }

        fs::create_dir_all(&self.log_dir).await?;
        self.rotate_file_if_needed().await?;
        info!(dir = %self.log_dir.display(), "Audit logger initialized");
        Ok(())
    }

    /// 确保当前文件对应今天的日期
    async fn rotate_file_if_needed(&self) -> anyhow::Result<()> {
        let today = Utc::now().format("%Y-%m-%d").to_string();
        let mut current_date = self.current_date.lock().await;

        if *current_date == today {
            return Ok(());
        }

        let file_path = self.log_dir.join(format!("audit-{}.jsonl", today));
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .await?;

        let mut current_file = self.current_file.lock().await;
        *current_file = Some(file);
        *current_date = today;

        Ok(())
    }

    /// 记录审计事件（JSON Lines 格式追加写入）
    pub async fn log_event(&self, event: AuditEvent) -> anyhow::Result<()> {
        if !self.enabled {
            return Ok(());
        }

        self.rotate_file_if_needed().await?;

        let line = serde_json::to_string(&event)?;
        let mut current_file = self.current_file.lock().await;

        if let Some(ref mut file) = *current_file {
            file.write_all(line.as_bytes()).await?;
            file.write_all(b"\n").await?;
            file.flush().await?;
        } else {
            warn!("Audit file not initialized, dropping event");
        }

        debug!(event_type = ?event.event_type, "Audit event logged");
        Ok(())
    }

    /// 便捷方法：记录工具执行开始
    pub async fn log_tool_start(&self, tool_ref: &str, execution_id: &str) -> anyhow::Result<()> {
        let event = AuditEvent {
            event_id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            event_type: AuditEventType::ToolExecuteStart,
            device_id: self.device_id.clone(),
            tool_ref: Some(tool_ref.to_string()),
            tool_name: Some(crate::types::tool_name(tool_ref)),
            execution_id: Some(execution_id.to_string()),
            caller_id: None,
            status: Some("running".to_string()),
            error_category: None,
            duration_ms: None,
            input_digest: None,
            output_digest: None,
            policy_digest: None,
            evidence_refs: None,
            parent_event_id: None,
            trace_chain: None,
            extra: None,
        };
        self.log_event(event).await
    }

    /// 便捷方法：记录工具执行结果
    pub async fn log_tool_result(
        &self,
        tool_ref: &str,
        execution_id: &str,
        status: &str,
        duration_ms: u64,
    ) -> anyhow::Result<()> {
        let event_type = if status == "succeeded" {
            AuditEventType::ToolExecuteSuccess
        } else {
            AuditEventType::ToolExecuteFailed
        };

        let event = AuditEvent {
            event_id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            event_type,
            device_id: self.device_id.clone(),
            tool_ref: Some(tool_ref.to_string()),
            tool_name: Some(crate::types::tool_name(tool_ref)),
            execution_id: Some(execution_id.to_string()),
            caller_id: None,
            status: Some(status.to_string()),
            error_category: None,
            duration_ms: Some(duration_ms),
            input_digest: None,
            output_digest: None,
            policy_digest: None,
            evidence_refs: None,
            parent_event_id: None,
            trace_chain: None,
            extra: None,
        };
        self.log_event(event).await
    }

    /// 清理过期日志（保留最近 retention_days 天）
    pub async fn cleanup_old_logs(&self, retention_days: u32) -> anyhow::Result<u32> {
        let mut removed = 0u32;
        let cutoff = Utc::now() - chrono::Duration::days(retention_days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%d").to_string();

        let mut entries = fs::read_dir(&self.log_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if let Some(date_str) = file_name
                .strip_prefix("audit-")
                .and_then(|s| s.strip_suffix(".jsonl"))
            {
                if date_str < cutoff_str.as_str() {
                    if let Err(e) = fs::remove_file(entry.path()).await {
                        warn!(file = %file_name, error = %e, "Failed to remove old audit log");
                    } else {
                        removed += 1;
                        debug!(file = %file_name, "Removed old audit log");
                    }
                }
            }
        }

        info!(removed, retention_days, "Audit log cleanup completed");
        Ok(removed)
    }
}

// ── 全局审计实例 ──────────────────────────────────────────────

static AUDIT: OnceLock<AuditLogger> = OnceLock::new();

pub fn init_audit(device_id: &str, enabled: bool) {
    let _ = AUDIT.set(AuditLogger::new(device_id, enabled));
}

pub fn get_audit() -> Option<&'static AuditLogger> {
    AUDIT.get()
}

pub async fn audit_event(event: AuditEvent) {
    if let Some(logger) = AUDIT.get() {
        if let Err(e) = logger.log_event(event).await {
            error!(error = %e, "Failed to write audit event");
        }
    }
}
