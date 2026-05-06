use crate::config::DeviceAgentFullConfig;
use crate::transport::http_client::HttpClient;
use crate::transport::Transport;
use crate::types::{DeviceClaimEnvelope, ToolExecutionResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingExecutionsResponse {
    executions: Vec<PendingExecution>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingExecution {
    device_execution_id: String,
    tool_ref: String,
    input: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRequest {
    device_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultPayload {
    status: String,
    error_category: Option<String>,
    output_digest: Option<serde_json::Value>,
    evidence_refs: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatPayload {
    device_id: String,
    timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct EmptyResponse {}

pub struct HttpPollingTransport {
    client: Option<HttpClient>,
    poll_interval_ms: u64,
    connected: bool,
    device_id: String,
}

impl HttpPollingTransport {
    pub fn new(poll_interval_ms: u64) -> Self {
        Self {
            client: None,
            poll_interval_ms,
            connected: false,
            device_id: String::new(),
        }
    }
}

#[async_trait]
impl Transport for HttpPollingTransport {
    async fn connect(&mut self, cfg: &DeviceAgentFullConfig) -> anyhow::Result<()> {
        self.client = Some(HttpClient::new(&cfg.api_base, &cfg.device_token));
        self.device_id = cfg.device_id.clone();
        self.connected = true;
        tracing::info!("HTTP polling transport connected, device_id={}", self.device_id);
        Ok(())
    }

    async fn send_result(
        &self,
        execution_id: &str,
        result: &ToolExecutionResult,
    ) -> anyhow::Result<()> {
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("HTTP client not initialized"))?;

        let payload = ResultPayload {
            status: serde_json::to_value(&result.status)?
                .as_str()
                .unwrap_or("failed")
                .to_string(),
            error_category: result.error_category.clone(),
            output_digest: result.output_digest.clone(),
            evidence_refs: result.evidence_refs.clone(),
        };

        let path = format!("/device-agent/executions/{}/result", execution_id);
        let _resp: crate::transport::http_client::ApiResponse<EmptyResponse> =
            client.post_json(&path, &payload).await?;

        tracing::debug!("Sent result for execution {}", execution_id);
        Ok(())
    }

    async fn recv_task(&mut self) -> anyhow::Result<DeviceClaimEnvelope> {
        loop {
            let client = self
                .client
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("HTTP client not initialized"))?;

            // 轮询待执行任务
            let resp: crate::transport::http_client::ApiResponse<PendingExecutionsResponse> =
                client
                    .get_json("/device-agent/executions?status=pending")
                    .await?;

            if !resp.json.executions.is_empty() {
                let exec = &resp.json.executions[0];
                let claim_path = format!(
                    "/device-agent/executions/{}/claim",
                    exec.device_execution_id
                );
                let claim_req = ClaimRequest {
                    device_id: self.device_id.clone(),
                };

                let claim_resp: crate::transport::http_client::ApiResponse<DeviceClaimEnvelope> =
                    client.post_json(&claim_path, &claim_req).await?;

                tracing::info!(
                    "Claimed execution: {}",
                    claim_resp.json.execution.device_execution_id
                );
                return Ok(claim_resp.json);
            }

            // 无任务，等待后重试
            tokio::time::sleep(tokio::time::Duration::from_millis(self.poll_interval_ms)).await;
        }
    }

    async fn heartbeat(&self) -> anyhow::Result<()> {
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("HTTP client not initialized"))?;

        let payload = HeartbeatPayload {
            device_id: self.device_id.clone(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };

        let _resp: crate::transport::http_client::ApiResponse<EmptyResponse> =
            client.post_json("/device-agent/heartbeat", &payload).await?;

        tracing::debug!("Heartbeat sent");
        Ok(())
    }

    async fn disconnect(&mut self) -> anyhow::Result<()> {
        self.connected = false;
        tracing::info!("HTTP polling transport disconnected");
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }
}
