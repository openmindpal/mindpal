use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub struct ApiResponse<T> {
    pub status: u16,
    pub json: T,
}

pub struct HttpClient {
    client: Client,
    base_url: String,
    device_token: String,
}

impl HttpClient {
    pub fn new(base_url: &str, device_token: &str) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to build HTTP client");

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            device_token: device_token.to_string(),
        }
    }

    pub async fn post_json<T: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &T,
    ) -> anyhow::Result<ApiResponse<R>> {
        let url = format!("{}{}", self.base_url, path);
        tracing::debug!("POST {}", url);

        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await?;

        let status = resp.status().as_u16();
        let json: R = resp.json().await?;

        Ok(ApiResponse { status, json })
    }

    pub async fn get_json<R: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
    ) -> anyhow::Result<ApiResponse<R>> {
        let url = format!("{}{}", self.base_url, path);
        tracing::debug!("GET {}", url);

        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .send()
            .await?;

        let status = resp.status().as_u16();
        let json: R = resp.json().await?;

        Ok(ApiResponse { status, json })
    }
}
