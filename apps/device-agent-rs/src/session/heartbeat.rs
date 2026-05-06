use tokio::time::{interval, Duration};
use tokio::sync::watch;
use tracing::{info, warn, debug, error};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatPayload {
    device_id: String,
    os: String,
    agent_version: String,
    timestamp: String,
}

/// 心跳管理器
pub struct HeartbeatManager {
    device_id: String,
    api_base: String,
    device_token: String,
    interval_ms: u64,
    enabled: bool,
    os: String,
    agent_version: String,
    stop_tx: Option<watch::Sender<bool>>,
}

impl HeartbeatManager {
    pub fn new(
        device_id: &str,
        api_base: &str,
        device_token: &str,
        interval_ms: u64,
        enabled: bool,
        os: &str,
        agent_version: &str,
    ) -> Self {
        Self {
            device_id: device_id.to_string(),
            api_base: api_base.to_string(),
            device_token: device_token.to_string(),
            interval_ms,
            enabled,
            os: os.to_string(),
            agent_version: agent_version.to_string(),
            stop_tx: None,
        }
    }

    /// 启动心跳后台任务
    pub fn start(&mut self) -> tokio::task::JoinHandle<()> {
        let (stop_tx, mut stop_rx) = watch::channel(false);
        self.stop_tx = Some(stop_tx);

        let device_id = self.device_id.clone();
        let api_base = self.api_base.clone();
        let device_token = self.device_token.clone();
        let interval_ms = self.interval_ms;
        let enabled = self.enabled;
        let os = self.os.clone();
        let agent_version = self.agent_version.clone();

        tokio::spawn(async move {
            if !enabled {
                info!("Heartbeat disabled, task exiting");
                return;
            }

            info!(interval_ms, "Heartbeat task started");
            let mut ticker = interval(Duration::from_millis(interval_ms));

            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        if let Err(e) = Self::do_send_heartbeat(
                            &api_base, &device_token, &device_id, &os, &agent_version
                        ).await {
                            warn!(error = %e, "Heartbeat send failed");
                        } else {
                            debug!("Heartbeat sent successfully");
                        }
                    }
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            info!("Heartbeat task stopping");
                            break;
                        }
                    }
                }
            }
        })
    }

    /// 停止心跳
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(true);
            info!("Heartbeat stop signal sent");
        }
    }

    /// 发送一次心跳（实例方法）
    pub async fn send_heartbeat(&self) -> anyhow::Result<()> {
        Self::do_send_heartbeat(
            &self.api_base,
            &self.device_token,
            &self.device_id,
            &self.os,
            &self.agent_version,
        )
        .await
    }

    /// 内部静态方法：发送心跳请求
    async fn do_send_heartbeat(
        api_base: &str,
        device_token: &str,
        device_id: &str,
        os: &str,
        agent_version: &str,
    ) -> anyhow::Result<()> {
        let url = format!("{}/device-agent/heartbeat", api_base.trim_end_matches('/'));
        let payload = HeartbeatPayload {
            device_id: device_id.to_string(),
            os: os.to_string(),
            agent_version: agent_version.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };

        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .bearer_auth(device_token)
            .json(&payload)
            .timeout(Duration::from_secs(10))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            error!(status = %status, body = %body, "Heartbeat response error");
            anyhow::bail!("Heartbeat failed with status {}", status);
        }

        Ok(())
    }
}
