use crate::config::{DeviceAgentFullConfig, PluginConfig, save_config, default_config_path};
use crate::env::DeviceAgentEnv;
use crate::types::DeviceType;
use crate::plugin::registry::PluginRegistry;
use crate::plugin::default_plugins_for_device_type;
use crate::security::token::sha256_8;
use std::sync::Arc;
use std::path::PathBuf;
use tracing::info;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    pairing_code: String,
    device_type: DeviceType,
    os: String,
    agent_version: String,
    capabilities: Vec<PairCapability>,
    plugin_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairCapability {
    tool_ref: String,
    plugin_name: String,
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    device_id: String,
    device_token: String,
    policy_auto_populated: Option<PolicyAutoPopulated>,
    plugin_policy: Option<PluginPolicyResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyAutoPopulated {
    allowed_tools_count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginPolicyResponse {
    builtin_plugins: Option<Vec<String>>,
    plugin_dirs: Option<Vec<String>>,
    skill_dirs: Option<Vec<String>>,
}

/// 执行配对命令
pub async fn run_pair(
    pairing_code: &str,
    api_base: &str,
    device_type: DeviceType,
    config_path: Option<PathBuf>,
    registry: Arc<PluginRegistry>,
) -> anyhow::Result<()> {
    let env = DeviceAgentEnv::resolve();
    let cfg_path = config_path.unwrap_or_else(default_config_path);

    info!(pairing_code = %pairing_code, device_type = ?device_type, "starting device pairing");

    // 1. 从注册表收集已加载插件的能力清单
    let plugins = registry.list_plugins().await;
    let all_capabilities = registry.aggregate_capabilities().await;
    let capabilities: Vec<PairCapability> = all_capabilities
        .iter()
        .filter(|c| c.tool_ref.starts_with("device."))
        .map(|c| PairCapability {
            tool_ref: c.tool_ref.clone(),
            plugin_name: "builtin".to_string(),
            version: c.version.clone().unwrap_or_else(|| "1.0.0".to_string()),
        })
        .collect();
    let plugin_names: Vec<String> = plugins.iter().map(|p| p.name.clone()).collect();

    // 2. 发送配对请求 POST /device-agent/pair
    let client = reqwest::Client::new();
    let pair_req = PairRequest {
        pairing_code: pairing_code.to_string(),
        device_type: device_type.clone(),
        os: env.agent_os.clone(),
        agent_version: env.agent_version.clone(),
        capabilities,
        plugin_names,
    };

    let resp = client
        .post(format!("{}/device-agent/pair", api_base))
        .json(&pair_req)
        .send()
        .await?;

    let status = resp.status().as_u16();
    if status != 200 {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("pair_failed_{}: {}", status, body);
    }

    let pair_resp: PairResponse = resp.json().await?;

    // 3. 日志记录
    if let Some(ref auto) = pair_resp.policy_auto_populated {
        info!(allowed_tools = auto.allowed_tools_count, "云端已自动配置工具策略");
    }

    // 4. 构建插件配置（元数据驱动：优先云端下发，否则用设备类型默认值）
    let plugin_config = if let Some(ref cloud_policy) = pair_resp.plugin_policy {
        PluginConfig {
            builtin_plugins: cloud_policy.builtin_plugins.clone().unwrap_or_default(),
            plugin_dirs: cloud_policy.plugin_dirs.clone(),
            skill_dirs: cloud_policy.skill_dirs.clone(),
            updated_at: Some(chrono::Utc::now().to_rfc3339()),
            source: Some("cloud".to_string()),
        }
    } else {
        PluginConfig {
            builtin_plugins: default_plugins_for_device_type(&device_type)
                .iter()
                .map(|s| s.to_string())
                .collect(),
            plugin_dirs: None,
            skill_dirs: None,
            updated_at: Some(chrono::Utc::now().to_rfc3339()),
            source: Some("local".to_string()),
        }
    };

    // 5. 持久化配置文件
    let full_config = DeviceAgentFullConfig {
        api_base: api_base.to_string(),
        device_id: pair_resp.device_id.clone(),
        device_token: pair_resp.device_token.clone(),
        enrolled_at: chrono::Utc::now().to_rfc3339(),
        device_type,
        os: env.agent_os.clone(),
        agent_version: env.agent_version.clone(),
        plugin_config: Some(plugin_config.clone()),
    };

    save_config(&cfg_path, &full_config).await?;

    info!(
        device_id = %pair_resp.device_id,
        token_digest = %sha256_8(&pair_resp.device_token),
        config = %cfg_path.display(),
        capabilities_count = all_capabilities.len(),
        plugin_source = %plugin_config.source.unwrap_or_else(|| "local".into()),
        "pairing successful"
    );

    Ok(())
}
