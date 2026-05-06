use crate::types::*;
use async_trait::async_trait;
use chrono::Utc;
use sha2::{Sha256, Digest};
use serde_json::{json, Value};
use std::collections::HashMap;
use tracing::info;

/// 证据记录
#[derive(Debug, Clone, serde::Serialize)]
struct EvidenceRecord {
    evidence_id: String,
    timestamp: String,
    device_id: String,
    collected_data: Value,
    sha256_signature: String,
}

/// 证据收集插件
pub struct EvidencePlugin {
    records: Vec<EvidenceRecord>,
    device_id: String,
}

impl EvidencePlugin {
    pub fn new() -> Self {
        Self {
            records: Vec::new(),
            device_id: String::new(),
        }
    }

    /// 对数据生成SHA256签名
    fn compute_signature(data: &Value) -> String {
        let serialized = serde_json::to_string(data).unwrap_or_default();
        let hash = Sha256::digest(serialized.as_bytes());
        hex::encode(hash)
    }

    async fn collect(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let label = ctx.input.get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("snapshot");
        let data = ctx.input.get("data")
            .cloned()
            .unwrap_or(json!({}));

        let now = Utc::now();
        let evidence_id = format!("ev_{}_{}", now.format("%Y%m%d%H%M%S"), uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("0000"));

        // 收集系统信息快照
        let collected_data = json!({
            "label": label,
            "user_data": data,
            "system_info": {
                "hostname": gethostname::gethostname().to_string_lossy().to_string(),
                "timestamp": now.to_rfc3339(),
                "uptime_approx": "unknown",
            },
        });

        let signature = Self::compute_signature(&collected_data);

        let record = EvidenceRecord {
            evidence_id: evidence_id.clone(),
            timestamp: now.to_rfc3339(),
            device_id: self.device_id.clone(),
            collected_data: collected_data.clone(),
            sha256_signature: signature.clone(),
        };

        info!(evidence_id = %record.evidence_id, "evidence: collected");

        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "evidence_id": record.evidence_id,
                "timestamp": record.timestamp,
                "sha256_signature": signature,
                "label": label,
            })),
            evidence_refs: Some(vec![evidence_id]),
        })
    }

    async fn list_evidence(&self, _ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let list: Vec<Value> = self.records.iter().map(|r| {
            json!({
                "evidence_id": r.evidence_id,
                "timestamp": r.timestamp,
                "sha256_signature": r.sha256_signature,
            })
        }).collect();
        let count = list.len();

        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({"records": list, "count": count})),
            evidence_refs: None,
        })
    }

    async fn export(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let format = ctx.input.get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("json");
        let evidence_ids: Vec<String> = ctx.input.get("evidence_ids")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let to_export: Vec<&EvidenceRecord> = if evidence_ids.is_empty() {
            self.records.iter().collect()
        } else {
            self.records.iter().filter(|r| evidence_ids.contains(&r.evidence_id)).collect()
        };

        // TODO: 真实实现中写入文件/tar.gz打包
        let now = Utc::now();
        let export_path = format!("/tmp/evidence_export_{}.{}", now.format("%Y%m%d%H%M%S"), format);

        info!(format, count = to_export.len(), path = %export_path, "evidence: exporting");

        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "format": format,
                "export_path": export_path,
                "record_count": to_export.len(),
                "total_available": self.records.len(),
            })),
            evidence_refs: None,
        })
    }
}

fn cap(tool_ref: &str, risk_level: RiskLevel, description: &str) -> CapabilityDescriptor {
    CapabilityDescriptor {
        tool_ref: tool_ref.into(),
        input_schema: None,
        output_schema: None,
        risk_level,
        resource_requirements: None,
        concurrency_limit: None,
        version: None,
        tags: None,
        description: Some(description.into()),
    }
}

#[async_trait]
impl DevicePlugin for EvidencePlugin {
    fn name(&self) -> &str { "evidence" }

    fn tool_prefixes(&self) -> Vec<String> {
        vec!["device.evidence.".to_string()]
    }

    fn tool_names(&self) -> Vec<String> {
        vec![
            "device.evidence.collect",
            "device.evidence.list",
            "device.evidence.export",
        ].into_iter().map(String::from).collect()
    }

    fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        vec![
            cap("device.evidence.collect", RiskLevel::Low, "收集当前状态证据"),
            cap("device.evidence.list", RiskLevel::Low, "列出已收集的证据"),
            cap("device.evidence.export", RiskLevel::Medium, "打包导出证据"),
        ]
    }

    fn version(&self) -> &str { "1.0.0" }

    async fn init(&mut self) -> anyhow::Result<()> {
        self.device_id = gethostname::gethostname().to_string_lossy().to_string();
        info!(device_id = %self.device_id, "evidence: initializing");
        Ok(())
    }

    async fn healthcheck(&self) -> anyhow::Result<HealthStatus> {
        Ok(HealthStatus {
            healthy: true,
            details: Some(HashMap::from([
                ("record_count".into(), json!(self.records.len())),
                ("device_id".into(), json!(self.device_id)),
            ])),
        })
    }

    async fn execute(&self, ctx: ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        match ctx.tool_name.as_str() {
            "device.evidence.collect" => self.collect(&ctx).await,
            "device.evidence.list" => self.list_evidence(&ctx).await,
            "device.evidence.export" => self.export(&ctx).await,
            _ => Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("unknown_tool".into()),
                output_digest: Some(json!({"error": format!("unknown tool: {}", ctx.tool_name)})),
                evidence_refs: None,
            }),
        }
    }

    async fn dispose(&mut self) -> anyhow::Result<()> {
        info!("evidence: disposing, {} records in memory", self.records.len());
        Ok(())
    }
}
