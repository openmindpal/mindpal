use crate::types::{
    CapabilityDescriptor, DevicePlugin, HealthStatus, PluginState, ToolExecutionContext,
    ToolExecutionResult,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

/// 插件注册条目
#[derive(Debug)]
pub struct PluginEntry {
    pub name: String,
    pub state: PluginState,
    pub version: String,
    pub tool_names: Vec<String>,
    pub capabilities: Vec<CapabilityDescriptor>,
    pub registered_at: chrono::DateTime<chrono::Utc>,
    pub last_healthcheck: Option<chrono::DateTime<chrono::Utc>>,
    pub error_count: u32,
}

/// 插件注册表（全局单例）
pub struct PluginRegistry {
    plugins: RwLock<HashMap<String, (PluginEntry, Arc<RwLock<Box<dyn DevicePlugin>>>)>>,
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self {
            plugins: RwLock::new(HashMap::new()),
        }
    }

    /// 注册并初始化插件
    pub async fn register(&self, mut plugin: Box<dyn DevicePlugin>) -> anyhow::Result<()> {
        let name = plugin.name().to_string();
        info!(plugin = %name, "registering plugin");

        // 1. 调用 plugin.init()
        plugin.init().await?;

        // 2. 记录元数据
        let entry = PluginEntry {
            name: name.clone(),
            state: PluginState::Ready,
            version: plugin.version().to_string(),
            tool_names: plugin.tool_names(),
            capabilities: plugin.capabilities(),
            registered_at: chrono::Utc::now(),
            last_healthcheck: None,
            error_count: 0,
        };

        // 3. 存入注册表
        let mut plugins = self.plugins.write().await;
        plugins.insert(name.clone(), (entry, Arc::new(RwLock::new(plugin))));
        info!(plugin = %name, "plugin registered successfully");
        Ok(())
    }

    /// 查找能处理指定 toolRef 的插件
    pub async fn find_plugin_for_tool(
        &self,
        tool_ref: &str,
    ) -> Option<Arc<RwLock<Box<dyn DevicePlugin>>>> {
        let plugins = self.plugins.read().await;
        for (_, (entry, plugin)) in plugins.iter() {
            if entry
                .tool_names
                .iter()
                .any(|t| t == tool_ref || tool_ref.starts_with(t))
            {
                return Some(Arc::clone(plugin));
            }
        }
        None
    }

    /// 执行工具（查找插件 → 委托执行）
    pub async fn execute_tool(
        &self,
        ctx: ToolExecutionContext,
    ) -> anyhow::Result<ToolExecutionResult> {
        let plugin = self
            .find_plugin_for_tool(&ctx.tool_ref)
            .await
            .ok_or_else(|| anyhow::anyhow!("no plugin found for tool: {}", ctx.tool_ref))?;

        let plugin_guard = plugin.read().await;
        plugin_guard.execute(ctx).await
    }

    /// 列出所有已注册插件
    pub async fn list_plugins(&self) -> Vec<PluginInfo> {
        let plugins = self.plugins.read().await;
        plugins
            .iter()
            .map(|(_, (entry, _))| PluginInfo {
                name: entry.name.clone(),
                version: entry.version.clone(),
                state: entry.state,
                tool_names: entry.tool_names.clone(),
            })
            .collect()
    }

    /// 聚合所有插件的能力描述符（用于配对时上报）
    pub async fn aggregate_capabilities(&self) -> Vec<CapabilityDescriptor> {
        let plugins = self.plugins.read().await;
        plugins
            .iter()
            .flat_map(|(_, (entry, _))| entry.capabilities.clone())
            .collect()
    }

    /// 执行全部插件的健康检查
    pub async fn healthcheck_all(&self) -> Vec<(String, HealthStatus)> {
        let plugins = self.plugins.read().await;
        let mut results = Vec::new();
        for (name, (_, plugin)) in plugins.iter() {
            let p = plugin.read().await;
            let status = match p.healthcheck().await {
                Ok(s) => s,
                Err(e) => {
                    error!(plugin = %name, error = %e, "healthcheck failed");
                    HealthStatus {
                        healthy: false,
                        details: None,
                    }
                }
            };
            results.push((name.clone(), status));
        }
        results
    }

    /// 卸载所有插件（优雅关闭）
    pub async fn dispose_all(&self) -> anyhow::Result<()> {
        let mut plugins = self.plugins.write().await;
        for (name, (_, plugin)) in plugins.iter_mut() {
            info!(plugin = %name, "disposing plugin");
            let mut p = plugin.write().await;
            if let Err(e) = p.dispose().await {
                error!(plugin = %name, error = %e, "plugin dispose failed");
            }
        }
        plugins.clear();
        Ok(())
    }

    /// 插件数量
    pub async fn count(&self) -> usize {
        self.plugins.read().await.len()
    }
}

#[derive(Debug, Clone)]
pub struct PluginInfo {
    pub name: String,
    pub version: String,
    pub state: PluginState,
    pub tool_names: Vec<String>,
}

/// 创建全局注册表实例
pub fn create_registry() -> Arc<PluginRegistry> {
    Arc::new(PluginRegistry::new())
}
