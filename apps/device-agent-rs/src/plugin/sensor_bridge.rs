use crate::types::*;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use tracing::{info, warn};

/// 传感器类型
#[derive(Debug, Clone)]
pub enum SensorType {
    Gps,
    Imu,
    Lidar,
    Ultrasonic,
    Temperature,
    Humidity,
    Pressure,
    Accelerometer,
    Gyroscope,
}

impl SensorType {
    fn as_str(&self) -> &str {
        match self {
            SensorType::Gps => "gps",
            SensorType::Imu => "imu",
            SensorType::Lidar => "lidar",
            SensorType::Ultrasonic => "ultrasonic",
            SensorType::Temperature => "temperature",
            SensorType::Humidity => "humidity",
            SensorType::Pressure => "pressure",
            SensorType::Accelerometer => "accelerometer",
            SensorType::Gyroscope => "gyroscope",
        }
    }
}

/// 传感器数据点
#[derive(Debug, Clone, serde::Serialize)]
pub struct SensorReading {
    pub sensor_id: String,
    pub sensor_type: String,
    pub value: Value,
    pub unit: String,
    pub timestamp: i64,
    pub accuracy: Option<f64>,
}

/// 传感器描述符
#[derive(Debug, Clone)]
struct SensorDescriptor {
    id: String,
    sensor_type: SensorType,
    name: String,
    unit: String,
    sample_rate_hz: Option<f64>,
}

/// 传感器桥接插件
pub struct SensorBridgePlugin {
    sensors: Vec<SensorDescriptor>,
    streaming: HashMap<String, bool>,
}

impl SensorBridgePlugin {
    pub fn new() -> Self {
        Self {
            sensors: Vec::new(),
            streaming: HashMap::new(),
        }
    }

    /// 探测系统传感器（模拟实现）
    async fn probe_sensors(&self) -> Vec<SensorDescriptor> {
        // TODO: 替换为真实硬件探测（sysfs/HAL/平台API）
        vec![
            SensorDescriptor {
                id: "gps_0".into(),
                sensor_type: SensorType::Gps,
                name: "Primary GPS".into(),
                unit: "degrees".into(),
                sample_rate_hz: Some(10.0),
            },
            SensorDescriptor {
                id: "imu_0".into(),
                sensor_type: SensorType::Imu,
                name: "6-axis IMU".into(),
                unit: "m/s²".into(),
                sample_rate_hz: Some(100.0),
            },
            SensorDescriptor {
                id: "lidar_0".into(),
                sensor_type: SensorType::Lidar,
                name: "Front LiDAR".into(),
                unit: "mm".into(),
                sample_rate_hz: Some(20.0),
            },
            SensorDescriptor {
                id: "ultrasonic_0".into(),
                sensor_type: SensorType::Ultrasonic,
                name: "Rear Ultrasonic".into(),
                unit: "cm".into(),
                sample_rate_hz: Some(40.0),
            },
            SensorDescriptor {
                id: "temp_0".into(),
                sensor_type: SensorType::Temperature,
                name: "Ambient Temperature".into(),
                unit: "°C".into(),
                sample_rate_hz: Some(1.0),
            },
        ]
    }

    async fn read_sensor(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let sensor_id = ctx.input.get("sensor_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let sensor = self.sensors.iter().find(|s| s.id == sensor_id);
        match sensor {
            Some(s) => {
                // TODO: 读取真实传感器硬件数据
                let now = chrono::Utc::now().timestamp_millis();
                let reading = SensorReading {
                    sensor_id: s.id.clone(),
                    sensor_type: s.sensor_type.as_str().to_string(),
                    value: self.simulate_reading(&s.sensor_type),
                    unit: s.unit.clone(),
                    timestamp: now,
                    accuracy: Some(0.95),
                };
                Ok(ToolExecutionResult {
                    status: ExecutionStatus::Succeeded,
                    error_category: None,
                    output_digest: Some(serde_json::to_value(&reading)?),
                    evidence_refs: None,
                })
            }
            None => {
                warn!(sensor_id, "sensor not found");
                Ok(ToolExecutionResult {
                    status: ExecutionStatus::Failed,
                    error_category: Some("sensor_not_found".into()),
                    output_digest: Some(json!({"error": format!("sensor '{}' not found", sensor_id)})),
                    evidence_refs: None,
                })
            }
        }
    }

    async fn list_sensors(&self, _ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let list: Vec<Value> = self.sensors.iter().map(|s| {
            json!({
                "id": s.id,
                "type": s.sensor_type.as_str(),
                "name": s.name,
                "unit": s.unit,
                "sample_rate_hz": s.sample_rate_hz,
            })
        }).collect();
        let count = list.len();

        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({"sensors": list, "count": count})),
            evidence_refs: None,
        })
    }

    async fn stream_start(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let sensor_id = ctx.input.get("sensor_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if !self.sensors.iter().any(|s| s.id == sensor_id) {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("sensor_not_found".into()),
                output_digest: Some(json!({"error": format!("sensor '{}' not found", sensor_id)})),
                evidence_refs: None,
            });
        }

        // TODO: 启动真实流式传输（通过channel/事件总线推送）
        info!(sensor_id, "stream started");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({"sensor_id": sensor_id, "streaming": true})),
            evidence_refs: None,
        })
    }

    async fn stream_stop(&self, ctx: &ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        let sensor_id = ctx.input.get("sensor_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // TODO: 停止真实流式传输
        info!(sensor_id, "stream stopped");
        Ok(ToolExecutionResult {
            status: ExecutionStatus::Succeeded,
            error_category: None,
            output_digest: Some(json!({"sensor_id": sensor_id, "streaming": false})),
            evidence_refs: None,
        })
    }

    /// 模拟传感器读数
    fn simulate_reading(&self, sensor_type: &SensorType) -> Value {
        // TODO: 替换为真实传感器读数
        match sensor_type {
            SensorType::Gps => json!({"lat": 31.2304, "lon": 121.4737, "alt": 4.2}),
            SensorType::Imu => json!({"ax": 0.01, "ay": -0.02, "az": 9.81, "gx": 0.0, "gy": 0.0, "gz": 0.0}),
            SensorType::Lidar => json!({"points": 1024, "range_min_mm": 200, "range_max_mm": 12000}),
            SensorType::Ultrasonic => json!({"distance_cm": 35.2}),
            SensorType::Temperature => json!({"celsius": 23.5}),
            SensorType::Humidity => json!({"percent": 65.0}),
            SensorType::Pressure => json!({"hpa": 1013.25}),
            SensorType::Accelerometer => json!({"x": 0.01, "y": -0.02, "z": 9.81}),
            SensorType::Gyroscope => json!({"x": 0.001, "y": -0.002, "z": 0.0}),
        }
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
impl DevicePlugin for SensorBridgePlugin {
    fn name(&self) -> &str { "sensor_bridge" }

    fn tool_prefixes(&self) -> Vec<String> {
        vec!["device.sensor.".to_string()]
    }

    fn tool_names(&self) -> Vec<String> {
        vec![
            "device.sensor.read",
            "device.sensor.list",
            "device.sensor.stream_start",
            "device.sensor.stream_stop",
        ].into_iter().map(String::from).collect()
    }

    fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        vec![
            cap("device.sensor.read", RiskLevel::Low, "读取传感器数据"),
            cap("device.sensor.list", RiskLevel::Low, "列出可用传感器"),
            cap("device.sensor.stream_start", RiskLevel::Medium, "启动传感器数据流"),
            cap("device.sensor.stream_stop", RiskLevel::Low, "停止传感器数据流"),
        ]
    }

    fn version(&self) -> &str { "1.0.0" }

    async fn init(&mut self) -> anyhow::Result<()> {
        info!("sensor_bridge: initializing, probing available sensors");
        self.sensors = self.probe_sensors().await;
        info!(count = self.sensors.len(), "sensor_bridge: sensors discovered");
        Ok(())
    }

    async fn healthcheck(&self) -> anyhow::Result<HealthStatus> {
        Ok(HealthStatus {
            healthy: !self.sensors.is_empty(),
            details: Some(HashMap::from([
                ("sensor_count".into(), json!(self.sensors.len())),
                ("streaming_count".into(), json!(self.streaming.values().filter(|v| **v).count())),
            ])),
        })
    }

    async fn execute(&self, ctx: ToolExecutionContext) -> anyhow::Result<ToolExecutionResult> {
        match ctx.tool_name.as_str() {
            "device.sensor.read" => self.read_sensor(&ctx).await,
            "device.sensor.list" => self.list_sensors(&ctx).await,
            "device.sensor.stream_start" => self.stream_start(&ctx).await,
            "device.sensor.stream_stop" => self.stream_stop(&ctx).await,
            _ => Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("unknown_tool".into()),
                output_digest: Some(json!({"error": format!("unknown tool: {}", ctx.tool_name)})),
                evidence_refs: None,
            }),
        }
    }

    async fn dispose(&mut self) -> anyhow::Result<()> {
        info!("sensor_bridge: disposing");
        self.streaming.clear();
        Ok(())
    }
}
