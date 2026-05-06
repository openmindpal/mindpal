pub mod registry;
pub mod sandbox;

// 机器人/汽车场景插件（Task 5 创建，此处先声明）
pub mod sensor_bridge;
pub mod camera;
pub mod audio;
pub mod bluetooth;
pub mod file_ops;
pub mod evidence;

use std::collections::{HashMap, HashSet};
use crate::types::DeviceType;

/// 内置别名映射（对齐 Node.js 版 BUILTIN_ALIASES）
/// 每种设备类型展开为对应的插件组合
fn builtin_aliases() -> HashMap<&'static str, Vec<&'static str>> {
    HashMap::from([
        ("desktop", vec!["file_ops", "evidence"]),
        ("robot", vec!["sensor_bridge", "camera", "audio", "bluetooth", "file_ops", "evidence"]),
        ("vehicle", vec!["sensor_bridge", "camera", "audio", "bluetooth", "file_ops", "evidence"]),
        ("iot", vec!["sensor_bridge", "bluetooth", "file_ops"]),
        ("home", vec!["sensor_bridge", "bluetooth", "audio", "file_ops"]),
        ("gateway", vec!["file_ops", "bluetooth"]),
        ("mobile", vec!["camera", "audio", "bluetooth", "file_ops"]),
    ])
}

/// 展开别名 + 去重
/// 输入如 ["robot"] → 输出 ["sensor_bridge", "camera", "audio", "bluetooth", "file_ops", "evidence"]
/// 输入如 ["file_ops", "camera"] → 原样返回（非别名直接保留）
pub fn expand_plugin_names(names: &[String]) -> Vec<String> {
    let aliases = builtin_aliases();
    let mut result = Vec::new();
    let mut seen = HashSet::new();

    for name in names {
        if let Some(expanded) = aliases.get(name.as_str()) {
            for p in expanded {
                if seen.insert(p.to_string()) {
                    result.push(p.to_string());
                }
            }
        } else if seen.insert(name.clone()) {
            result.push(name.clone());
        }
    }
    result
}

/// 根据设备类型获取默认插件列表（对齐 Node.js 的 getDefaultPluginsForDeviceType）
pub fn default_plugins_for_device_type(device_type: &DeviceType) -> Vec<String> {
    let alias = match device_type {
        DeviceType::Desktop => "desktop",
        DeviceType::Mobile => "mobile",
        DeviceType::Iot => "iot",
        DeviceType::Robot => "robot",
        DeviceType::Vehicle => "vehicle",
        DeviceType::Home => "home",
        DeviceType::Gateway => "gateway",
    };
    expand_plugin_names(&[alias.to_string()])
}
