use crate::config::DeviceAgentFullConfig;
use crate::transport::Transport;
use crate::types::{DeviceClaimEnvelope, ToolExecutionResult};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// WebSocket 协议消息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    correlation_id: Option<String>,
    #[serde(flatten)]
    payload: HashMap<String, serde_json::Value>,
}

/// 握手消息
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeMessage {
    #[serde(rename = "type")]
    msg_type: String,
    protocol_version: String,
    agent_version: String,
    capabilities: Vec<String>,
    device_id: String,
}

/// 命令确认消息
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandAckMessage {
    #[serde(rename = "type")]
    msg_type: String,
    execution_id: String,
    status: String,
    error_category: Option<String>,
    output_digest: Option<serde_json::Value>,
    evidence_refs: Option<Vec<String>>,
}

pub struct WebSocketTransport {
    cfg: Option<DeviceAgentFullConfig>,
    connected: bool,
    task_rx: mpsc::Receiver<DeviceClaimEnvelope>,
    task_tx: mpsc::Sender<DeviceClaimEnvelope>,
    ws_tx: Option<mpsc::Sender<String>>,
    reconnect_attempts: u32,
    max_reconnect_delay_ms: u64,
    _bg_handle: Option<tokio::task::JoinHandle<()>>,
}

impl WebSocketTransport {
    pub fn new() -> Self {
        let (task_tx, task_rx) = mpsc::channel(64);
        Self {
            cfg: None,
            connected: false,
            task_rx,
            task_tx,
            ws_tx: None,
            reconnect_attempts: 0,
            max_reconnect_delay_ms: 30_000,
            _bg_handle: None,
        }
    }

    /// 将 http(s) URL 转换为 ws(s) URL
    fn to_ws_url(api_base: &str) -> String {
        let base = api_base.trim_end_matches('/');
        let ws_base = if base.starts_with("https://") {
            base.replacen("https://", "wss://", 1)
        } else if base.starts_with("http://") {
            base.replacen("http://", "ws://", 1)
        } else {
            format!("ws://{}", base)
        };
        format!("{}/device-agent/ws", ws_base)
    }

    /// 计算指数退避延迟
    fn backoff_delay(&self) -> u64 {
        let base_ms: u64 = 1000;
        let delay = base_ms * 2u64.saturating_pow(self.reconnect_attempts);
        delay.min(self.max_reconnect_delay_ms)
    }
}

#[async_trait]
impl Transport for WebSocketTransport {
    async fn connect(&mut self, cfg: &DeviceAgentFullConfig) -> anyhow::Result<()> {
        self.cfg = Some(cfg.clone());
        let ws_url = Self::to_ws_url(&cfg.api_base);
        tracing::info!("WebSocket connecting to {}", ws_url);

        // 构建带 Authorization header 的请求
        let mut request = ws_url.into_client_request()?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", cfg.device_token).parse()?,
        );

        let (ws_stream, _response) = tokio_tungstenite::connect_async(request).await?;
        let (mut write, mut read) = ws_stream.split();

        // 发送握手
        let handshake = HandshakeMessage {
            msg_type: "protocol.handshake".to_string(),
            protocol_version: "2.0".to_string(),
            agent_version: cfg.agent_version.clone(),
            capabilities: vec!["tool.execute".to_string(), "heartbeat".to_string()],
            device_id: cfg.device_id.clone(),
        };
        let handshake_json = serde_json::to_string(&handshake)?;
        write.send(Message::Text(handshake_json)).await?;
        tracing::debug!("Sent protocol.handshake");

        // 等待 handshake.ack
        let ack_timeout = tokio::time::Duration::from_secs(10);
        let ack = tokio::time::timeout(ack_timeout, async {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(parsed) = serde_json::from_str::<WsMessage>(&text) {
                            if parsed.msg_type == "handshake.ack" {
                                return Ok(());
                            }
                        }
                    }
                    Ok(Message::Close(_)) => {
                        return Err(anyhow::anyhow!("Connection closed during handshake"));
                    }
                    Err(e) => {
                        return Err(anyhow::anyhow!("WebSocket error during handshake: {}", e));
                    }
                    _ => {}
                }
            }
            Err(anyhow::anyhow!("Connection closed before handshake.ack"))
        })
        .await;

        match ack {
            Ok(Ok(())) => {
                tracing::info!("Handshake acknowledged");
            }
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(anyhow::anyhow!("Handshake timeout (10s)")),
        }

        // 创建发送通道
        let (ws_send_tx, mut ws_send_rx) = mpsc::channel::<String>(64);
        self.ws_tx = Some(ws_send_tx);

        // 启动后台消息处理任务
        let task_tx = self.task_tx.clone();
        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    // 处理接收到的消息
                    msg = read.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                Self::handle_incoming_message(&text, &task_tx).await;
                            }
                            Some(Ok(Message::Ping(data))) => {
                                if let Err(e) = write.send(Message::Pong(data)).await {
                                    tracing::error!("Failed to send pong: {}", e);
                                    break;
                                }
                            }
                            Some(Ok(Message::Close(_))) => {
                                tracing::info!("WebSocket closed by server");
                                break;
                            }
                            Some(Err(e)) => {
                                tracing::error!("WebSocket read error: {}", e);
                                break;
                            }
                            None => {
                                tracing::info!("WebSocket stream ended");
                                break;
                            }
                            _ => {}
                        }
                    }
                    // 处理要发送的消息
                    outgoing = ws_send_rx.recv() => {
                        match outgoing {
                            Some(text) => {
                                if let Err(e) = write.send(Message::Text(text)).await {
                                    tracing::error!("Failed to send message: {}", e);
                                    break;
                                }
                            }
                            None => {
                                tracing::debug!("Send channel closed");
                                break;
                            }
                        }
                    }
                }
            }
        });

        self._bg_handle = Some(handle);
        self.connected = true;
        self.reconnect_attempts = 0;
        tracing::info!("WebSocket transport connected");
        Ok(())
    }

    async fn send_result(
        &self,
        execution_id: &str,
        result: &ToolExecutionResult,
    ) -> anyhow::Result<()> {
        let ws_tx = self
            .ws_tx
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("WebSocket not connected"))?;

        let ack = CommandAckMessage {
            msg_type: "device_command_ack".to_string(),
            execution_id: execution_id.to_string(),
            status: serde_json::to_value(&result.status)?
                .as_str()
                .unwrap_or("failed")
                .to_string(),
            error_category: result.error_category.clone(),
            output_digest: result.output_digest.clone(),
            evidence_refs: result.evidence_refs.clone(),
        };

        let json = serde_json::to_string(&ack)?;
        ws_tx
            .send(json)
            .await
            .map_err(|_| anyhow::anyhow!("WebSocket send channel closed"))?;

        tracing::debug!("Sent command ack for execution {}", execution_id);
        Ok(())
    }

    async fn recv_task(&mut self) -> anyhow::Result<DeviceClaimEnvelope> {
        self.task_rx
            .recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("Task channel closed, connection may be lost"))
    }

    async fn heartbeat(&self) -> anyhow::Result<()> {
        let ws_tx = self
            .ws_tx
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("WebSocket not connected"))?;

        let msg = serde_json::json!({
            "type": "heartbeat",
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        });

        ws_tx
            .send(msg.to_string())
            .await
            .map_err(|_| anyhow::anyhow!("WebSocket send channel closed"))?;

        tracing::debug!("Heartbeat sent via WebSocket");
        Ok(())
    }

    async fn disconnect(&mut self) -> anyhow::Result<()> {
        self.connected = false;
        self.ws_tx = None; // Drop sender, which will close the background task's send loop

        if let Some(handle) = self._bg_handle.take() {
            handle.abort();
        }

        tracing::info!("WebSocket transport disconnected");
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }
}

impl WebSocketTransport {
    /// 处理收到的 WebSocket 消息
    async fn handle_incoming_message(text: &str, task_tx: &mpsc::Sender<DeviceClaimEnvelope>) {
        let parsed: WsMessage = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("Failed to parse WS message: {}", e);
                return;
            }
        };

        match parsed.msg_type.as_str() {
            "task_pending" | "device_command" => {
                // 解析任务信封
                match serde_json::from_str::<DeviceClaimEnvelope>(text) {
                    Ok(envelope) => {
                        if let Err(e) = task_tx.send(envelope).await {
                            tracing::error!("Failed to enqueue task: {}", e);
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to parse task envelope: {}", e);
                    }
                }
            }
            "heartbeat.ack" => {
                tracing::debug!("Heartbeat acknowledged");
            }
            "policy.update" => {
                tracing::info!("Received policy update notification");
            }
            other => {
                tracing::debug!("Received unhandled message type: {}", other);
            }
        }
    }
}
