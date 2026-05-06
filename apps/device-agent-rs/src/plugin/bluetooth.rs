use crate::types::*;
use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use tracing::info;

/// BLE 设备信息
#[derive(Debug, Clone, serde::Serialize)]
struct BleDevice {
    address: String,
    name: Option<String>,
    rssi: i16,
    services: Vec<String>,
}

/// 蓝牙BLE插件
pub struct BluetoothPlugin {
    connected_devices: HashMap<String, BleDevice>,
    scanning: bool,
}

impl BluetoothPlugin {
    pub fn new() -> Self {
        Self {
            connected_devices: HashMap::new(),
            scanning: false,
        }
    }

    async fn scan(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let timeout_ms = ctx.input.get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(5000);
        let name_filter = ctx.input.get("name_filter")
            .and_then(|v| v.as_str())
            .map(String::from);

        info!(timeout_ms, "bluetooth: scanning for BLE devices");

        // TODO: 使用 btleplug 或平台BLE API进行真实扫描
        let mut discovered = vec![
            BleDevice {
                address: "AA:BB:CC:DD:EE:01".into(),
                name: Some("Robot-Sensor-Hub".into()),
                rssi: -45,
                services: vec!["0000180a-0000-1000-8000-00805f9b34fb".into()],
            },
            BleDevice {
                address: "AA:BB:CC:DD:EE:02".into(),
                name: Some("Vehicle-OBD".into()),
                rssi: -62,
                services: vec!["0000fff0-0000-1000-8000-00805f9b34fb".into()],
            },
        ];

        // 按名称过滤
        if let Some(filter) = &name_filter {
            discovered.retain(|d| {
                d.name.as_ref().map(|n| n.contains(filter.as_str())).unwrap_or(false)
            });
        }

        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "devices": discovered,
                "count": discovered.len(),
                "scan_duration_ms": timeout_ms,
            })),
            evidence_refs: None,
        })
    }

    async fn connect(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let address = ctx.input.get("address")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if address.is_empty() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("invalid_input".into()),
                output_digest: Some(json!({"error": "address is required"})),
                evidence_refs: None,
            });
        }

        // TODO: 使用 btleplug 建立真实BLE连接
        info!(address, "bluetooth: connecting");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "address": address,
                "connected": true,
                "mtu": 512,
            })),
            evidence_refs: None,
        })
    }

    async fn disconnect(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let address = ctx.input.get("address")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if address.is_empty() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("invalid_input".into()),
                output_digest: Some(json!({"error": "address is required"})),
                evidence_refs: None,
            });
        }

        // TODO: 断开真实BLE连接
        info!(address, "bluetooth: disconnecting");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({"address": address, "connected": false})),
            evidence_refs: None,
        })
    }

    async fn read_characteristic(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let address = ctx.input.get("address")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let characteristic = ctx.input.get("characteristic")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if address.is_empty() || characteristic.is_empty() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("invalid_input".into()),
                output_digest: Some(json!({"error": "address and characteristic are required"})),
                evidence_refs: None,
            });
        }

        // TODO: 读取真实BLE特征值
        info!(address, characteristic, "bluetooth: reading characteristic");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "address": address,
                "characteristic": characteristic,
                "value": [0x01, 0x02, 0x03, 0x04],
                "encoding": "bytes",
            })),
            evidence_refs: None,
        })
    }

    async fn write_characteristic(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let address = ctx.input.get("address")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let characteristic = ctx.input.get("characteristic")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let value = ctx.input.get("value");

        if address.is_empty() || characteristic.is_empty() || value.is_none() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("invalid_input".into()),
                output_digest: Some(json!({"error": "address, characteristic and value are required"})),
                evidence_refs: None,
            });
        }

        // TODO: 写入真实BLE特征值
        info!(address, characteristic, "bluetooth: writing characteristic");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({
                "address": address,
                "characteristic": characteristic,
                "written": true,
            })),
            evidence_refs: None,
        })
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
impl DevicePlugin for BluetoothPlugin {
    fn name(&self) -> &str { "bluetooth" }

    fn tool_prefixes(&self) -> Vec<String> {
        vec!["device.bluetooth.".to_string()]
    }

    fn tool_names(&self) -> Vec<String> {
        vec![
            "device.bluetooth.scan",
            "device.bluetooth.connect",
            "device.bluetooth.disconnect",
            "device.bluetooth.read",
            "device.bluetooth.write",
        ].into_iter().map(String::from).collect()
    }

    fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        vec![
            cap("device.bluetooth.scan", RiskLevel::Low, "BLE设备扫描"),
            cap("device.bluetooth.connect", RiskLevel::Medium, "连接BLE设备"),
            cap("device.bluetooth.disconnect", RiskLevel::Low, "断开BLE设备"),
            cap("device.bluetooth.read", RiskLevel::Low, "读取BLE特征值"),
            cap("device.bluetooth.write", RiskLevel::Medium, "写入BLE特征值"),
        ]
    }

    fn version(&self) -> &str { "1.0.0" }

    async fn init(&mut self) -> anyhow::Result<()> {
        info!("bluetooth: initializing BLE adapter");
        // TODO: 初始化蓝牙适配器
        Ok(())
    }

    async fn healthcheck(&self) -> anyhow::Result<HealthStatus> {
        Ok(HealthStatus {
            healthy: true,
            details: Some(HashMap::from([
                ("connected_devices".into(), json!(self.connected_devices.len())),
                ("scanning".into(), json!(self.scanning)),
            ])),
        })
    }

    async fn execute(&self, ctx: ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        match ctx.tool_name.as_str() {
            "device.bluetooth.scan" => self.scan(&ctx).await,
            "device.bluetooth.connect" => self.connect(&ctx).await,
            "device.bluetooth.disconnect" => self.disconnect(&ctx).await,
            "device.bluetooth.read" => self.read_characteristic(&ctx).await,
            "device.bluetooth.write" => self.write_characteristic(&ctx).await,
            _ => Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("unknown_tool".into()),
                output_digest: Some(json!({"error": format!("unknown tool: {}", ctx.tool_name)})),
                evidence_refs: None,
            }),
        }
    }

    async fn dispose(&mut self) -> anyhow::Result<()> {
        info!("bluetooth: disposing, disconnecting all devices");
        self.connected_devices.clear();
        Ok(())
    }
}
