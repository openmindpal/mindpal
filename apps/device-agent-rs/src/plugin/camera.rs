use crate::types::*;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use tracing::{info, warn};

/// 摄像头设备描述
#[derive(Debug, Clone)]
struct CameraDevice {
    id: String,
    name: String,
    path: String,
    resolution: (u32, u32),
    fps: u32,
}

/// 摄像头插件
pub struct CameraPlugin {
    cameras: Vec<CameraDevice>,
    streaming: HashMap<String, bool>,
}

impl CameraPlugin {
    pub fn new() -> Self {
        Self {
            cameras: Vec::new(),
            streaming: HashMap::new(),
        }
    }

    /// 探测可用摄像头（模拟实现）
    async fn probe_cameras(&self) -> Vec<CameraDevice> {
        // TODO: 真实实现中扫描 /dev/video* (V4L2) 或 Windows 设备枚举
        vec![
            CameraDevice {
                id: "cam_front".into(),
                name: "Front Camera".into(),
                path: "/dev/video0".into(),
                resolution: (1920, 1080),
                fps: 30,
            },
            CameraDevice {
                id: "cam_rear".into(),
                name: "Rear Camera".into(),
                path: "/dev/video1".into(),
                resolution: (1280, 720),
                fps: 30,
            },
        ]
    }

    async fn capture(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let camera_id = ctx.input.get("camera_id")
            .and_then(|v| v.as_str())
            .unwrap_or("cam_front");

        let camera = self.cameras.iter().find(|c| c.id == camera_id);
        match camera {
            Some(cam) => {
                // TODO: 通过 V4L2/GStreamer 采集真实帧
                let now = chrono::Utc::now().timestamp_millis();
                info!(camera_id, "frame captured");
                Ok(ToolExecutionResult {
                    status: ExecutionStatus::Succeeded,
                    error_category: None,
                    output_digest: Some(json!({
                        "camera_id": cam.id,
                        "resolution": format!("{}x{}", cam.resolution.0, cam.resolution.1),
                        "format": "jpeg",
                        "timestamp": now,
                        "file_path": format!("/tmp/capture_{}_{}.jpg", cam.id, now),
                        "size_bytes": 0,
                    })),
                    evidence_refs: None,
                })
            }
            None => {
                warn!(camera_id, "camera not found");
                Ok(ToolExecutionResult {
                    status: ExecutionStatus::Failed,
                    error_category: Some("camera_not_found".into()),
                    output_digest: Some(json!({"error": format!("camera '{}' not found", camera_id)})),
                    evidence_refs: None,
                })
            }
        }
    }

    async fn list_cameras(&self, _ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let list: Vec<Value> = self.cameras.iter().map(|c| {
            json!({
                "id": c.id,
                "name": c.name,
                "path": c.path,
                "resolution": format!("{}x{}", c.resolution.0, c.resolution.1),
                "fps": c.fps,
            })
        }).collect();
        let count = list.len();

        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({"cameras": list, "count": count})),
            evidence_refs: None,
        })
    }

    async fn stream_start(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let camera_id = ctx.input.get("camera_id")
            .and_then(|v| v.as_str())
            .unwrap_or("cam_front");

        if !self.cameras.iter().any(|c| c.id == camera_id) {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("camera_not_found".into()),
                output_digest: Some(json!({"error": format!("camera '{}' not found", camera_id)})),
                evidence_refs: None,
            });
        }

        // TODO: 启动真实视频流（RTSP/WebRTC/GStreamer pipeline）
        info!(camera_id, "video stream started");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({"camera_id": camera_id, "streaming": true})),
            evidence_refs: None,
        })
    }

    async fn stream_stop(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let camera_id = ctx.input.get("camera_id")
            .and_then(|v| v.as_str())
            .unwrap_or("cam_front");

        // TODO: 停止真实视频流
        info!(camera_id, "video stream stopped");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({"camera_id": camera_id, "streaming": false})),
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
impl DevicePlugin for CameraPlugin {
    fn name(&self) -> &str { "camera" }

    fn tool_prefixes(&self) -> Vec<String> {
        vec!["device.camera.".to_string()]
    }

    fn tool_names(&self) -> Vec<String> {
        vec![
            "device.camera.capture",
            "device.camera.list",
            "device.camera.stream_start",
            "device.camera.stream_stop",
        ].into_iter().map(String::from).collect()
    }

    fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        vec![
            cap("device.camera.capture", RiskLevel::Medium, "捕获单帧图片"),
            cap("device.camera.list", RiskLevel::Low, "列出可用摄像头"),
            cap("device.camera.stream_start", RiskLevel::Medium, "启动视频流"),
            cap("device.camera.stream_stop", RiskLevel::Medium, "停止视频流"),
        ]
    }

    fn version(&self) -> &str { "1.0.0" }

    async fn init(&mut self) -> anyhow::Result<()> {
        info!("camera: initializing, probing available cameras");
        self.cameras = self.probe_cameras().await;
        info!(count = self.cameras.len(), "camera: cameras discovered");
        Ok(())
    }

    async fn healthcheck(&self) -> anyhow::Result<HealthStatus> {
        Ok(HealthStatus {
            healthy: !self.cameras.is_empty(),
            details: Some(HashMap::from([
                ("camera_count".into(), json!(self.cameras.len())),
                ("streaming_count".into(), json!(self.streaming.values().filter(|v| **v).count())),
            ])),
        })
    }

    async fn execute(&self, ctx: ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        match ctx.tool_name.as_str() {
            "device.camera.capture" => self.capture(&ctx).await,
            "device.camera.list" => self.list_cameras(&ctx).await,
            "device.camera.stream_start" => self.stream_start(&ctx).await,
            "device.camera.stream_stop" => self.stream_stop(&ctx).await,
            _ => Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("unknown_tool".into()),
                output_digest: Some(json!({"error": format!("unknown tool: {}", ctx.tool_name)})),
                evidence_refs: None,
            }),
        }
    }

    async fn dispose(&mut self) -> anyhow::Result<()> {
        info!("camera: disposing");
        self.streaming.clear();
        Ok(())
    }
}
