use crate::types::*;
use async_trait::async_trait;
use serde_json::json;
use sha2::{Sha256, Digest};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// 文件操作插件
pub struct FileOpsPlugin {
    /// 允许访问的根目录（沙箱根），防止目录遍历
    sandbox_root: PathBuf,
}

impl FileOpsPlugin {
    pub fn new() -> Self {
        Self {
            sandbox_root: PathBuf::from("/data/device-agent"),
        }
    }

    /// 路径安全检查：确保路径在沙箱根目录内
    fn validate_path(&self, raw_path: &str) -> anyhow::Result<PathBuf> {
        let path = Path::new(raw_path);
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.sandbox_root.join(path)
        };

        // 规范化路径并检查是否在沙箱内
        // NOTE: 在真实环境中应使用 canonicalize()，此处模拟检查
        let resolved_str = resolved.to_string_lossy().replace('\\', "/");
        let root_str = self.sandbox_root.to_string_lossy().replace('\\', "/");

        if !resolved_str.starts_with(&*root_str) {
            anyhow::bail!("path traversal denied: '{}' is outside sandbox root '{}'", raw_path, root_str);
        }

        // 检查 .. 组件
        for component in path.components() {
            if let std::path::Component::ParentDir = component {
                anyhow::bail!("path traversal denied: '..' not allowed in path '{}'", raw_path);
            }
        }

        Ok(resolved)
    }

    async fn read_file(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let file_path = ctx.input.get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let encoding = ctx.input.get("encoding")
            .and_then(|v| v.as_str())
            .unwrap_or("text");

        if file_path.is_empty() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("invalid_input".into()),
                output_digest: Some(json!({"error": "path is required"})),
                evidence_refs: None,
            });
        }

        let validated = match self.validate_path(file_path) {
            Ok(p) => p,
            Err(e) => {
                warn!(path = file_path, "path validation failed");
                return Ok(ToolExecutionResult {
                    status: ExecutionStatus::Failed,
                    error_category: Some("path_denied".into()),
                    output_digest: Some(json!({"error": e.to_string()})),
                    evidence_refs: None,
                });
            }
        };

        // TODO: 读取真实文件内容
        info!(path = %validated.display(), encoding, "file_ops: reading file");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "path": validated.to_string_lossy(),
                "encoding": encoding,
                "content": "",
                "size_bytes": 0,
            })),
            evidence_refs: None,
        })
    }

    async fn write_file(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let file_path = ctx.input.get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let content = ctx.input.get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let create_dirs = ctx.input.get("create_dirs")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        if file_path.is_empty() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("invalid_input".into()),
                output_digest: Some(json!({"error": "path is required"})),
                evidence_refs: None,
            });
        }

        let validated = match self.validate_path(file_path) {
            Ok(p) => p,
            Err(e) => {
                return Ok(ToolExecutionResult {
                    status: ExecutionStatus::Failed,
                    error_category: Some("path_denied".into()),
                    output_digest: Some(json!({"error": e.to_string()})),
                    evidence_refs: None,
                });
            }
        };

        // TODO: 写入真实文件
        info!(path = %validated.display(), size = content.len(), create_dirs, "file_ops: writing file");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "path": validated.to_string_lossy(),
                "bytes_written": content.len(),
                "created_dirs": create_dirs,
            })),
            evidence_refs: None,
        })
    }

    async fn list_dir(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let dir_path = ctx.input.get("path")
            .and_then(|v| v.as_str())
            .unwrap_or(".");

        let validated = match self.validate_path(dir_path) {
            Ok(p) => p,
            Err(e) => {
                return Ok(ToolExecutionResult {
                    status: ExecutionStatus::Failed,
                    error_category: Some("path_denied".into()),
                    output_digest: Some(json!({"error": e.to_string()})),
                    evidence_refs: None,
                });
            }
        };

        // TODO: 读取真实目录内容
        info!(path = %validated.display(), "file_ops: listing directory");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "path": validated.to_string_lossy(),
                "entries": [],
                "count": 0,
            })),
            evidence_refs: None,
        })
    }

    async fn delete_file(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let file_path = ctx.input.get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if file_path.is_empty() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("invalid_input".into()),
                output_digest: Some(json!({"error": "path is required"})),
                evidence_refs: None,
            });
        }

        let validated = match self.validate_path(file_path) {
            Ok(p) => p,
            Err(e) => {
                return Ok(ToolExecutionResult {
                    status: ExecutionStatus::Failed,
                    error_category: Some("path_denied".into()),
                    output_digest: Some(json!({"error": e.to_string()})),
                    evidence_refs: None,
                });
            }
        };

        // TODO: 删除真实文件
        warn!(path = %validated.display(), "file_ops: deleting file");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "path": validated.to_string_lossy(),
                "deleted": true,
            })),
            evidence_refs: None,
        })
    }

    async fn hash_file(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let file_path = ctx.input.get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if file_path.is_empty() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("invalid_input".into()),
                output_digest: Some(json!({"error": "path is required"})),
                evidence_refs: None,
            });
        }

        let validated = match self.validate_path(file_path) {
            Ok(p) => p,
            Err(e) => {
                return Ok(ToolExecutionResult {
                    status: ExecutionStatus::Failed,
                    error_category: Some("path_denied".into()),
                    output_digest: Some(json!({"error": e.to_string()})),
                    evidence_refs: None,
                });
            }
        };

        // TODO: 计算真实文件的SHA256
        // 模拟：返回空文件的哈希
        let hash = hex::encode(Sha256::digest(b""));
        info!(path = %validated.display(), "file_ops: computing hash");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "path": validated.to_string_lossy(),
                "algorithm": "sha256",
                "hash": hash,
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
impl DevicePlugin for FileOpsPlugin {
    fn name(&self) -> &str { "file_ops" }

    fn tool_prefixes(&self) -> Vec<String> {
        vec!["device.file.".to_string()]
    }

    fn tool_names(&self) -> Vec<String> {
        vec![
            "device.file.read",
            "device.file.write",
            "device.file.list",
            "device.file.delete",
            "device.file.hash",
        ].into_iter().map(String::from).collect()
    }

    fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        vec![
            cap("device.file.read", RiskLevel::Low, "读取文件内容"),
            cap("device.file.write", RiskLevel::Medium, "写入文件"),
            cap("device.file.list", RiskLevel::Low, "列出目录内容"),
            cap("device.file.delete", RiskLevel::High, "删除文件"),
            cap("device.file.hash", RiskLevel::Low, "计算文件SHA256哈希"),
        ]
    }

    fn version(&self) -> &str { "1.0.0" }

    async fn init(&mut self) -> anyhow::Result<()> {
        info!(sandbox_root = %self.sandbox_root.display(), "file_ops: initializing");
        // TODO: 确保沙箱目录存在
        Ok(())
    }

    async fn healthcheck(&self) -> anyhow::Result<HealthStatus> {
        Ok(HealthStatus {
            healthy: true,
            details: Some(HashMap::from([
                ("sandbox_root".into(), json!(self.sandbox_root.to_string_lossy())),
            ])),
        })
    }

    async fn execute(&self, ctx: ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        match ctx.tool_name.as_str() {
            "device.file.read" => self.read_file(&ctx).await,
            "device.file.write" => self.write_file(&ctx).await,
            "device.file.list" => self.list_dir(&ctx).await,
            "device.file.delete" => self.delete_file(&ctx).await,
            "device.file.hash" => self.hash_file(&ctx).await,
            _ => Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("unknown_tool".into()),
                output_digest: Some(json!({"error": format!("unknown tool: {}", ctx.tool_name)})),
                evidence_refs: None,
            }),
        }
    }

    async fn dispose(&mut self) -> anyhow::Result<()> {
        info!("file_ops: disposing");
        Ok(())
    }
}
