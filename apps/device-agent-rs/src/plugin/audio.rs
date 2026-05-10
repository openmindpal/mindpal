use crate::types::*;
use async_trait::async_trait;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
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

    // ── 流式 STT ────────────────────────────────────────────────────

    /// 流式STT：通过WebSocket逐帧推送音频到 `/v1/audio/stream-stt`，获取最终转录结果。
    /// 当 `streaming_enabled` 为 false 时降级到 HTTP POST。
    pub async fn stream_stt(
        api_base: &str,
        device_token: &str,
        audio_chunks: Vec<Vec<u8>>,
        streaming_enabled: bool,
    ) -> anyhow::Result<String> {
        if !streaming_enabled || audio_chunks.is_empty() {
            // 降级路径：收集所有音频，HTTP POST
            let collected: Vec<u8> = audio_chunks.into_iter().flatten().collect();
            return Self::http_transcribe(api_base, device_token, &collected).await;
        }

        // 流式路径：WebSocket
        let ws_url = {
            let base = api_base.trim_end_matches('/');
            let ws_base = if base.starts_with("https://") {
                base.replacen("https://", "wss://", 1)
            } else if base.starts_with("http://") {
                base.replacen("http://", "ws://", 1)
            } else {
                format!("ws://{}", base)
            };
            format!("{}/v1/audio/stream-stt?language=zh", ws_base)
        };

        info!(url = %ws_url, "STT: opening streaming WebSocket");

        let mut request = ws_url
            .into_client_request()
            .map_err(|e| anyhow::anyhow!("STT WS request build error: {}", e))?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", device_token)
                .parse()
                .map_err(|e| anyhow::anyhow!("header error: {}", e))?,
        );

        let ws_conn = tokio_tungstenite::connect_async(request).await;
        let (mut ws, _response) = match ws_conn {
            Ok(c) => c,
            Err(e) => {
                warn!("STT WebSocket connect failed ({}), falling back to HTTP", e);
                let collected: Vec<u8> = audio_chunks.into_iter().flatten().collect();
                return Self::http_transcribe(api_base, device_token, &collected).await;
            }
        };

        let b64_engine = base64::engine::general_purpose::STANDARD;

        // 逐帧推送
        for chunk in &audio_chunks {
            let msg = SttMessage::AudioChunk {
                data: b64_engine.encode(chunk),
            };
            let text = serde_json::to_string(&msg)?;
            if let Err(e) = ws.send(Message::Text(text)).await {
                warn!("STT WS send failed: {}, falling back to HTTP", e);
                let collected: Vec<u8> = audio_chunks.into_iter().flatten().collect();
                return Self::http_transcribe(api_base, device_token, &collected).await;
            }
        }

        // 发送 finish 信号
        let finish_msg = serde_json::to_string(&SttMessage::Finish)?;
        ws.send(Message::Text(finish_msg)).await?;

        // 等待 final 结果（带超时）
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(msg) = ws.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(resp) = serde_json::from_str::<SttResponse>(&text) {
                            match resp {
                                SttResponse::Final { text, .. } => return Ok(text),
                                SttResponse::Error { error } => {
                                    return Err(anyhow::anyhow!("STT error: {}", error));
                                }
                                SttResponse::Interim { .. } => { /* 继续等待 */ }
                            }
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Err(e) => return Err(anyhow::anyhow!("STT WS read error: {}", e)),
                    _ => {}
                }
            }
            Ok(String::new())
        })
        .await;

        match result {
            Ok(Ok(text)) => {
                info!(len = text.len(), "STT: streaming transcription complete");
                Ok(text)
            }
            Ok(Err(e)) => Err(e),
            Err(_) => {
                warn!("STT: timeout waiting for final result");
                Ok(String::new())
            }
        }
    }

    /// HTTP 降级路径：POST 音频到 `/v1/audio/transcriptions`
    async fn http_transcribe(
        api_base: &str,
        device_token: &str,
        audio: &[u8],
    ) -> anyhow::Result<String> {
        let url = format!(
            "{}/v1/audio/transcriptions",
            api_base.trim_end_matches('/')
        );
        info!(url = %url, bytes = audio.len(), "STT: HTTP fallback POST");

        let b64_engine = base64::engine::general_purpose::STANDARD;
        let body = serde_json::json!({
            "audio": b64_engine.encode(audio),
            "format": "pcm",
            "language": "zh",
        });

        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", device_token))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        #[derive(serde::Deserialize)]
        struct TranscribeResp {
            text: Option<String>,
        }

        let parsed: TranscribeResp = resp.json().await?;
        Ok(parsed.text.unwrap_or_default())
    }

    // ── 流式 TTS ────────────────────────────────────────────────────

    /// 通过设备WebSocket发送TTS请求，等待音频响应。
    /// 当 `streaming_enabled` 为 false 时返回 None，调用方应降级到 HTTP TTS。
    pub async fn request_tts_streaming(
        ws_tx: &mpsc::Sender<String>,
        session_id: &str,
        text: &str,
        seq_no: u32,
        streaming_enabled: bool,
        mut audio_rx: mpsc::Receiver<DeviceTtsAudio>,
    ) -> anyhow::Result<Option<(String, String)>> {
        if !streaming_enabled {
            return Ok(None); // 调用方降级到HTTP
        }

        let req = DeviceTtsRequest {
            msg_type: "device_tts_request".to_string(),
            session_id: session_id.to_string(),
            text: text.to_string(),
            voice: None,
            seq_no,
        };
        let json = serde_json::to_string(&req)?;
        ws_tx
            .send(json)
            .await
            .map_err(|_| anyhow::anyhow!("WS send channel closed"))?;

        info!(seq_no, session_id, "TTS: streaming request sent");

        // 等待响应（带超时 15s）
        let result = tokio::time::timeout(Duration::from_secs(15), async {
            while let Some(audio) = audio_rx.recv().await {
                if audio.seq_no == seq_no {
                    return Ok((audio.audio_base64, audio.format));
                }
            }
            Err(anyhow::anyhow!("TTS audio channel closed"))
        })
        .await;

        match result {
            Ok(Ok(data)) => {
                info!(seq_no, "TTS: streaming audio received");
                Ok(Some(data))
            }
            Ok(Err(e)) => Err(e),
            Err(_) => {
                warn!(seq_no, "TTS: timeout waiting for audio (15s)");
                Ok(None)
            }
        }
    }

    /// 解析传入的 WebSocket 消息，如果是 `device_tts_audio` 类型则返回解析结果
    pub fn try_parse_tts_audio(text: &str) -> Option<DeviceTtsAudio> {
        let v: serde_json::Value = serde_json::from_str(text).ok()?;
        if v.get("type")?.as_str()? == "device_tts_audio" {
            serde_json::from_str::<DeviceTtsAudio>(text).ok()
        } else {
            None
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

        // 检查是否请求流式STT转录
        let stream_stt = ctx.input.get("stream_stt")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let now = chrono::Utc::now().timestamp_millis();
        let file_path = format!("/tmp/recording_{}_{}.{}", device_id, now, format);
        info!(device_id, duration_ms, format, stream_stt, "audio recording started");

        // 如果开启了流式STT，记录到输出摘要中便于上层编排
        let mut output = json!({
            "device_id": device_id,
            "duration_ms": duration_ms,
            "format": format,
            "file_path": file_path,
            "sample_rate": 44100,
            "channels": 1,
        });
        if stream_stt {
            output["stream_stt_hint"] = json!(true);
        }

        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(output),
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

    /// 工具入口：流式STT
    async fn exec_stream_stt(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let audio_b64 = ctx.input.get("audio_base64")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let streaming = ctx.input.get("streaming")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        // 从 policy 中读取流式开关
        let stt_streaming_enabled = ctx.policy
            .as_ref()
            .and_then(|p| p.get("streaming"))
            .and_then(|s| s.get("sttStreaming"))
            .and_then(|v| v.as_bool())
            .unwrap_or(streaming);

        let b64_engine = base64::engine::general_purpose::STANDARD;
        let audio_data = if !audio_b64.is_empty() {
            b64_engine.decode(audio_b64).unwrap_or_default()
        } else {
            Vec::new()
        };

        let chunks = if audio_data.is_empty() {
            vec![]
        } else {
            // 将音频分片，每片约4KB
            audio_data.chunks(4096).map(|c| c.to_vec()).collect()
        };

        let text = Self::stream_stt(
            &ctx.api_base,
            &ctx.device_token,
            chunks,
            stt_streaming_enabled,
        ).await?;

        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "text": text,
                "mode": if stt_streaming_enabled { "streaming" } else { "http" },
            })),
            evidence_refs: None,
        })
    }

    /// 工具入口：TTS（返回提示信息，实际流式TTS由上层调用 `request_tts_streaming`）
    async fn exec_tts(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let text = ctx.input.get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if text.is_empty() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("invalid_input".into()),
                output_digest: Some(json!({"error": "text is required"})),
                evidence_refs: None,
            });
        }

        let tts_streaming_enabled = ctx.policy
            .as_ref()
            .and_then(|p| p.get("streaming"))
            .and_then(|s| s.get("ttsStreaming"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if tts_streaming_enabled {
            // 提示上层：应通过 request_tts_streaming 发送
            Ok(ToolExecutionResult {
                status: ExecutionStatus::Succeeded,
                error_category: None,
                output_digest: Some(json!({
                    "mode": "streaming",
                    "hint": "use request_tts_streaming via device WS",
                    "text": text,
                })),
                evidence_refs: None,
            })
        } else {
            // HTTP 降级：调用 /v1/audio/tts
            let url = format!("{}/v1/audio/tts", ctx.api_base.trim_end_matches('/'));
            let body = json!({ "text": text, "format": "mp3" });
            let client = reqwest::Client::new();
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", ctx.device_token))
                .json(&body)
                .send()
                .await;

            match resp {
                Ok(r) => {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct TtsResp {
                        audio_base64: Option<String>,
                        format: Option<String>,
                    }
                    let parsed: TtsResp = r.json().await.unwrap_or(TtsResp {
                        audio_base64: None,
                        format: None,
                    });
                    Ok(ToolExecutionResult {
                        status: ExecutionStatus::Succeeded,
                        error_category: None,
                        output_digest: Some(json!({
                            "mode": "http",
                            "audio_base64": parsed.audio_base64.unwrap_or_default(),
                            "format": parsed.format.unwrap_or_else(|| "mp3".to_string()),
                        })),
                        evidence_refs: None,
                    })
                }
                Err(e) => Ok(ToolExecutionResult {
                    status: ExecutionStatus::Failed,
                    error_category: Some("http_error".into()),
                    output_digest: Some(json!({"error": format!("TTS HTTP failed: {}", e)})),
                    evidence_refs: None,
                }),
            }
        }
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
            "device.audio.stream_stt",
            "device.audio.tts",
        ].into_iter().map(String::from).collect()
    }

    fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        vec![
            cap("device.audio.record", RiskLevel::Medium, "录制音频"),
            cap("device.audio.play", RiskLevel::Low, "播放音频"),
            cap("device.audio.list_devices", RiskLevel::Low, "列出音频设备"),
            cap("device.audio.stop", RiskLevel::Low, "停止录制/播放"),
            cap("device.audio.stream_stt", RiskLevel::Low, "流式语音转文字"),
            cap("device.audio.tts", RiskLevel::Low, "文字转语音"),
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
            "device.audio.stream_stt" => self.exec_stream_stt(&ctx).await,
            "device.audio.tts" => self.exec_tts(&ctx).await,
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
