use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::sync::Arc;
use tracing_subscriber::{fmt, EnvFilter};

use mindpal_device_agent::types::DeviceType;
use mindpal_device_agent::env::DeviceAgentEnv;
use mindpal_device_agent::plugin::{expand_plugin_names, default_plugins_for_device_type};
use mindpal_device_agent::plugin::registry::create_registry;
use mindpal_device_agent::types::DevicePlugin;

#[derive(Parser)]
#[command(name = "mindpal-device-agent", version, about = "MindPal Device Agent - 轻量级设备运行时（机器人/汽车/IoT）")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// 配对设备到云端服务器
    Pair {
        #[arg(long, required = true)]
        pairing_code: String,
        #[arg(long)]
        api_base: Option<String>,
        #[arg(long, default_value = "desktop")]
        device_type: String,
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// 守护进程模式运行
    Run {
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long, default_value = "60000")]
        heartbeat_ms: u64,
        #[arg(long, default_value = "5000")]
        poll_ms: u64,
        #[arg(long, default_value = "300000")]
        idle_timeout_ms: u64,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .with_target(true)
        .json()
        .init();

    let cli = Cli::parse();
    let env = DeviceAgentEnv::resolve();

    match cli.command {
        Some(Commands::Pair { pairing_code, api_base, device_type, config }) => {
            let api = api_base.unwrap_or(env.api_base.clone());
            let dt = parse_device_type(&device_type);

            // 根据设备类型加载插件（用于上报能力清单）
            let registry = create_registry();
            let plugin_names = default_plugins_for_device_type(&dt);
            init_plugins(&registry, &plugin_names).await;

            mindpal_device_agent::pair::run_pair(&pairing_code, &api, dt, config, registry).await?;
        }
        Some(Commands::Run { config, heartbeat_ms, poll_ms, idle_timeout_ms }) => {
            // 从配置文件加载插件列表
            let registry = create_registry();
            let cfg_path = config.clone().unwrap_or_else(mindpal_device_agent::config::default_config_path);

            if let Ok(cfg) = mindpal_device_agent::config::load_config(&cfg_path).await {
                let plugin_names = if let Some(ref pc) = cfg.plugin_config {
                    expand_plugin_names(&pc.builtin_plugins)
                } else {
                    default_plugins_for_device_type(&cfg.device_type)
                };
                init_plugins(&registry, &plugin_names).await;
            }

            let rt_cfg = mindpal_device_agent::runtime::RuntimeConfig {
                config_path: config,
                heartbeat_ms,
                poll_ms,
                idle_timeout_ms,
            };
            mindpal_device_agent::runtime::run_agent(rt_cfg, registry).await?;
        }
        None => {
            println!("mindpal-device-agent — 灵智MindPal轻量级设备运行时");
            println!();
            println!("命令：");
            println!("  pair  配对设备到云端");
            println!("  run   守护进程模式运行");
            println!();
            println!("使用 --help 查看详细参数");
        }
    }

    Ok(())
}

fn parse_device_type(s: &str) -> DeviceType {
    match s {
        "mobile" => DeviceType::Mobile,
        "iot" => DeviceType::Iot,
        "robot" => DeviceType::Robot,
        "vehicle" => DeviceType::Vehicle,
        "home" => DeviceType::Home,
        "gateway" => DeviceType::Gateway,
        _ => DeviceType::Desktop,
    }
}

/// 根据插件名列表初始化并注册插件到注册表
async fn init_plugins(registry: &Arc<mindpal_device_agent::plugin::registry::PluginRegistry>, names: &[String]) {
    use mindpal_device_agent::plugin::{sensor_bridge, camera, audio, bluetooth, file_ops, evidence};

    for name in names {
        let plugin: Option<Box<dyn DevicePlugin>> = match name.as_str() {
            "sensor_bridge" => Some(Box::new(sensor_bridge::SensorBridgePlugin::new())),
            "camera" => Some(Box::new(camera::CameraPlugin::new())),
            "audio" => Some(Box::new(audio::AudioPlugin::new())),
            "bluetooth" => Some(Box::new(bluetooth::BluetoothPlugin::new())),
            "file_ops" => Some(Box::new(file_ops::FileOpsPlugin::new())),
            "evidence" => Some(Box::new(evidence::EvidencePlugin::new())),
            _ => {
                tracing::warn!(plugin = %name, "unknown plugin, skipping");
                None
            }
        };

        if let Some(p) = plugin {
            if let Err(e) = registry.register(p).await {
                tracing::error!(plugin = %name, error = %e, "failed to register plugin");
            }
        }
    }

    let count = registry.count().await;
    tracing::info!(count = count, "plugins initialized");
}
