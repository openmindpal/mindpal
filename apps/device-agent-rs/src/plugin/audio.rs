use crate::types::*;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use tracing::{info, warn};

/// 音频设备描述
#[derive(Debug, Clone)]
struct AudioDevice {
    id: String,
    name: String,
    direction: AudioDirection,
    sample_rate: u32,
    channels: u8,
}

#[derive(Debug, Clone, PartialEq)]
enum AudioDirection {
    Input,
    Output,
    Duplex,
}

impl AudioDirection {
    fn as_str(&self) -> &str {
        match self {
            AudioDirection::Input => "input",
            AudioDirection::Output => "output",
            AudioDirection::Duplex => "duplex",
        }
    }
}

/// 音频插件
pub struct AudioPlugin {
    devices: Vec<AudioDevice>,
    recording: bool,
    playing: bool,
}

impl AudioPlugin {
    pub fn new() -> Self {
        Self {
            devices: Vec::new(),
            recording: false,
            playing: false,
        }
    }

    /// 探测音频设备（模拟实现）
    async fn probe_devices(&self) -> Vec<AudioDevice> {
        // TODO: 使用 ALSA/PulseAudio/CoreAudio/WASAPI 枚举真实设备
        vec![
            AudioDevice {
                id: "mic_0".into(),
                name: "Built-in Microphone".into(),
                direction: AudioDirection::Input,
                sample_rate: 44100,
                channels: 1,
            },
            AudioDevice {
                id: "spk_0".into(),
                name: "Built-in Speaker".into(),
                direction: AudioDirection::Output,
                sample_rate: 48000,
                channels: 2,
            },
        ]
    }

    async fn record(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let duration_ms = ctx.input.get("duration_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(5000);
        let format = ctx.input.get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("wav");
        let device_id = ctx.input.get("device_id")
            .and_then(|v| v.as_str())
            .unwrap_or("mic_0");

        if !self.devices.iter().any(|d| d.id == device_id && d.direction != AudioDirection::Output) {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("device_not_found".into()),
                output_digest: Some(json!({"error": format!("input device '{}' not found", device_id)})),
                evidence_refs: None,
            });
        }

        // TODO: 通过音频库录制真实音频
        let now = chrono::Utc::now().timestamp_millis();
        let file_path = format!("/tmp/recording_{}_{}.{}", device_id, now, format);
        info!(device_id, duration_ms, format, "audio recording started");

        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "device_id": device_id,
                "duration_ms": duration_ms,
                "format": format,
                "file_path": file_path,
                "sample_rate": 44100,
                "channels": 1,
            })),
            evidence_refs: None,
        })
    }

    async fn play(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let file_path = ctx.input.get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let device_id = ctx.input.get("device_id")
            .and_then(|v| v.as_str())
            .unwrap_or("spk_0");

        if file_path.is_empty() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("invalid_input".into()),
                output_digest: Some(json!({"error": "file_path is required"})),
                evidence_refs: None,
            });
        }

        // TODO: 通过音频库播放真实音频
        info!(device_id, file_path, "audio playback started");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "device_id": device_id,
                "file_path": file_path,
                "status": "playing",
            })),
            evidence_refs: None,
        })
    }

    async fn list_devices(&self, _ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let list: Vec<Value> = self.devices.iter().map(|d| {
            json!({
                "id": d.id,
                "name": d.name,
                "direction": d.direction.as_str(),
                "sample_rate": d.sample_rate,
                "channels": d.channels,
            })
        }).collect();
        let count = list.len();

        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({"devices": list, "count": count})),
            evidence_refs: None,
        })
    }

    async fn stop(&self, _ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        // TODO: 停止真实录制/播放
        info!("audio: stop all");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({"recording": false, "playing": false})),
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
impl DevicePlugin for AudioPlugin {
    fn name(&self) -> &str { "audio" }

    fn tool_prefixes(&self) -> Vec<String> {
        vec!["device.audio.".to_string()]
    }

    fn tool_names(&self) -> Vec<String> {
        vec![
            "device.audio.record",
            "device.audio.play",
            "device.audio.list_devices",
            "device.audio.stop",
        ].into_iter().map(String::from).collect()
    }

    fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        vec![
            cap("device.audio.record", RiskLevel::Medium, "录制音频"),
            cap("device.audio.play", RiskLevel::Low, "播放音频"),
            cap("device.audio.list_devices", RiskLevel::Low, "列出音频设备"),
            cap("device.audio.stop", RiskLevel::Low, "停止录制/播放"),
        ]
    }

    fn version(&self) -> &str { "1.0.0" }

    async fn init(&mut self) -> anyhow::Result<()> {
        info!("audio: initializing, probing audio devices");
        self.devices = self.probe_devices().await;
        info!(count = self.devices.len(), "audio: devices discovered");
        Ok(())
    }

    async fn healthcheck(&self) -> anyhow::Result<HealthStatus> {
        Ok(HealthStatus {
            healthy: !self.devices.is_empty(),
            details: Some(HashMap::from([
                ("device_count".into(), json!(self.devices.len())),
                ("recording".into(), json!(self.recording)),
                ("playing".into(), json!(self.playing)),
            ])),
        })
    }

    async fn execute(&self, ctx: ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        match ctx.tool_name.as_str() {
            "device.audio.record" => self.record(&ctx).await,
            "device.audio.play" => self.play(&ctx).await,
            "device.audio.list_devices" => self.list_devices(&ctx).await,
            "device.audio.stop" => self.stop(&ctx).await,
            _ => Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("unknown_tool".into()),
                output_digest: Some(json!({"error": format!("unknown tool: {}", ctx.tool_name)})),
                evidence_refs: None,
            }),
        }
    }

    async fn dispose(&mut self) -> anyhow::Result<()> {
        info!("audio: disposing");
        self.recording = false;
        self.playing = false;
        Ok(())
    }
}
