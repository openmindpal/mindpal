use crate::config::{load_config, default_config_path, acquire_lock, release_lock, kill_existing_instance};
use crate::env::{DeviceAgentEnv, TransportMode as EnvTransportMode};
use crate::transport::{Transport, TransportMode, create_transport};
use crate::security::audit::init_audit;
use crate::security::access::AccessController;
use crate::session::heartbeat::HeartbeatManager;
use crate::session::policy_cache::PolicyCache;
use crate::plugin::registry::PluginRegistry;
use crate::plugin::sandbox::PluginSandbox;
use crate::types::*;
use std::sync::Arc;
use std::path::PathBuf;
use tokio::signal;
use tracing::{info, error, warn};

/// 运行时配置
pub struct RuntimeConfig {
    pub config_path: Option<PathBuf>,
    pub heartbeat_ms: u64,
    pub poll_ms: u64,
    pub idle_timeout_ms: u64,
}

/// 运行设备代理守护进程
pub async fn run_agent(
    rt_cfg: RuntimeConfig,
    registry: Arc<PluginRegistry>,
) -> anyhow::Result<()> {
    // 1. 单实例管理
    let killed = kill_existing_instance().await?;
    if killed {
        info!("killed existing device-agent instance");
    }
    acquire_lock().await?;

    // 2. 加载配置
    let cfg_path = rt_cfg.config_path.unwrap_or_else(default_config_path);
    let cfg = load_config(&cfg_path).await?;
    let env = DeviceAgentEnv::resolve();
    let api_base = cfg.api_base.clone();

    info!(
        device_id = %cfg.device_id,
        device_type = ?cfg.device_type,
        api_base = %api_base,
        transport = ?env.transport,
        "starting device agent runtime"
    );

    // 3. 初始化子系统
    // 3a. 审计日志
    init_audit(&cfg.device_id, env.audit_enabled);

    // 3b. 访问控制（非轻量模式）
    let access_controller = if !env.lightweight {
        Some(AccessController::new(env.secret_key.as_deref(), 3_600_000))
    } else {
        None
    };

    // 3c. 心跳管理器
    let mut heartbeat = HeartbeatManager::new(
        &cfg.device_id,
        &api_base,
        &cfg.device_token,
        rt_cfg.heartbeat_ms,
        env.session_heartbeat_enabled,
        &cfg.os,
        &cfg.agent_version,
    );
    let _heartbeat_handle = heartbeat.start();

    // 3d. 策略缓存
    let policy_cache = Arc::new(PolicyCache::new(
        &cfg.device_id,
        24 * 60 * 60 * 1000,
        env.policy_cache_enabled,
    ));

    // 3e. 插件沙箱
    let sandbox = Arc::new(PluginSandbox::new(None));

    // 4. 建立通信连接
    let transport_mode = match env.transport {
        EnvTransportMode::Auto => TransportMode::Auto,
        EnvTransportMode::Ws => TransportMode::Ws,
        EnvTransportMode::Http => TransportMode::Http,
    };
    let mut transport = create_transport(transport_mode, &cfg).await?;

    info!("device agent runtime initialized, entering main loop");

    // 5. 主循环：接收任务 → 检查策略 → 执行 → 回传结果
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        signal::ctrl_c().await.ok();
        let _ = shutdown_tx.send(());
    });

    loop {
        tokio::select! {
            // 等待任务到来
            task_result = transport.recv_task() => {
                match task_result {
                    Ok(envelope) => {
                        let execution_id = envelope.execution.device_execution_id.clone();
                        let tool_ref = envelope.execution.tool_ref.clone();
                        info!(execution_id = %execution_id, tool_ref = %tool_ref, "received task");

                        // 策略检查
                        if let Some(ref ac) = access_controller {
                            if let Some(policy) = policy_cache.get() {
                                if !ac.check_tool_allowed(&tool_ref, &policy) {
                                    warn!(tool_ref = %tool_ref, "tool not allowed by policy");
                                    let denied_result = ToolExecutionResult {
                                        status: ExecutionStatus::Failed,
                                        error_category: Some("policy_denied".to_string()),
                                        output_digest: None,
                                        evidence_refs: None,
                                    };
                                    transport.send_result(&execution_id, &denied_result).await.ok();
                                    continue;
                                }
                            }
                        }

                        // 构建执行上下文
                        let ctx = ToolExecutionContext {
                            api_base: api_base.clone(),
                            device_token: cfg.device_token.clone(),
                            execution_id: execution_id.clone(),
                            tool_ref: tool_ref.clone(),
                            tool_name: tool_ref.clone(),
                            input: envelope.execution.input.unwrap_or(serde_json::Value::Null),
                            policy: envelope.policy,
                            require_user_presence: envelope.require_user_presence.unwrap_or(false),
                        };

                        // 沙箱化执行
                        let registry_clone = Arc::clone(&registry);
                        let sandbox_clone = Arc::clone(&sandbox);
                        let result = sandbox_clone.execute(|| async move {
                            registry_clone.execute_tool(ctx).await
                        }).await;

                        // 回传结果
                        match result {
                            Ok(exec_result) => {
                                info!(execution_id = %execution_id, status = ?exec_result.status, "task completed");
                                transport.send_result(&execution_id, &exec_result).await.ok();
                            }
                            Err(e) => {
                                error!(execution_id = %execution_id, error = %e, "task execution error");
                                let err_result = ToolExecutionResult {
                                    status: ExecutionStatus::Failed,
                                    error_category: Some("internal_error".to_string()),
                                    output_digest: Some(serde_json::json!({ "error": e.to_string() })),
                                    evidence_refs: None,
                                };
                                transport.send_result(&execution_id, &err_result).await.ok();
                            }
                        }
                    }
                    Err(e) => {
                        error!(error = %e, "failed to receive task, will retry");
                        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    }
                }
            }
            // 优雅关闭
            _ = &mut shutdown_rx => {
                info!("received shutdown signal, stopping gracefully");
                break;
            }
        }
    }

    // 6. 清理
    info!("shutting down device agent");
    heartbeat.stop();
    transport.disconnect().await.ok();
    registry.dispose_all().await.ok();
    release_lock().await.ok();
    info!("device agent stopped");

    Ok(())
}
