use crate::config::DeviceAgentFullConfig;
use crate::types::{DeviceClaimEnvelope, ToolExecutionResult};
use async_trait::async_trait;

pub mod http_client;
pub mod http_poll;
pub mod ws;

/// 传输模式
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportMode {
    Auto,
    Ws,
    Http,
}

/// 传输层统一抽象
#[async_trait]
pub trait Transport: Send + Sync {
    /// 建立连接
    async fn connect(&mut self, cfg: &DeviceAgentFullConfig) -> anyhow::Result<()>;
    /// 发送执行结果
    async fn send_result(
        &self,
        execution_id: &str,
        result: &ToolExecutionResult,
    ) -> anyhow::Result<()>;
    /// 接收任务（阻塞直到有任务到来）
    async fn recv_task(&mut self) -> anyhow::Result<DeviceClaimEnvelope>;
    /// 发送心跳
    async fn heartbeat(&self) -> anyhow::Result<()>;
    /// 断开连接
    async fn disconnect(&mut self) -> anyhow::Result<()>;
    /// 是否已连接
    fn is_connected(&self) -> bool;
}

/// 根据模式创建传输实例
pub async fn create_transport(
    mode: TransportMode,
    cfg: &DeviceAgentFullConfig,
) -> anyhow::Result<Box<dyn Transport>> {
    match mode {
        TransportMode::Ws => {
            let mut t = ws::WebSocketTransport::new();
            t.connect(cfg).await?;
            Ok(Box::new(t))
        }
        TransportMode::Http => {
            let mut t = http_poll::HttpPollingTransport::new(3000);
            t.connect(cfg).await?;
            Ok(Box::new(t))
        }
        TransportMode::Auto => {
            // 优先尝试 WebSocket，失败则降级到 HTTP 轮询
            let mut ws_t = ws::WebSocketTransport::new();
            match ws_t.connect(cfg).await {
                Ok(()) => {
                    tracing::info!("Transport: WebSocket connected successfully");
                    Ok(Box::new(ws_t))
                }
                Err(e) => {
                    tracing::warn!(
                        "Transport: WebSocket failed ({}), falling back to HTTP polling",
                        e
                    );
                    let mut http_t = http_poll::HttpPollingTransport::new(3000);
                    http_t.connect(cfg).await?;
                    Ok(Box::new(http_t))
                }
            }
        }
    }
}
