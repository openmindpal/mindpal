/**
 * devicePluginPolicy.ts — 设备类型 → 插件策略映射（Single Source of Truth）
 *
 * 统一 device-agent 端侧与 API 云端两处重复定义。
 * 新增设备类型只需在此维护，无需修改任何加载逻辑。
 */

/**
 * 设备类型 → 默认内置插件映射。
 *
 * - desktop: 桌面全量（含 GUI 相关）
 * - mobile: 移动端（音频、摄像头、本地输入、对话引擎、蓝牙）
 * - iot: 物联网（传感器、本地输入、蓝牙）
 * - robot: 机器人（音频、摄像头、传感器、本地输入、对话引擎、蓝牙）
 * - vehicle: 车载（同 robot）
 * - home: 家居（音频、传感器、本地输入、对话引擎、蓝牙）
 * - gateway: 网关（传感器、本地输入）
 */
export const DEVICE_TYPE_PLUGIN_POLICY = new Map<string, string[]>([
  ["desktop",  ["desktop", "audio", "localInput", "dialogEngine"]],
  ["mobile",   ["audio", "camera", "localInput", "dialogEngine", "bluetooth"]],
  ["iot",      ["sensorBridge", "localInput", "bluetooth"]],
  ["robot",    ["audio", "camera", "sensorBridge", "localInput", "dialogEngine", "bluetooth"]],
  ["vehicle",  ["audio", "camera", "sensorBridge", "localInput", "dialogEngine", "bluetooth"]],
  ["home",     ["audio", "sensorBridge", "localInput", "dialogEngine", "bluetooth"]],
  ["gateway",  ["sensorBridge", "localInput"]],
]);

/**
 * 根据设备类型获取默认插件列表。
 * 未知类型返回空数组。
 */
export function getDefaultPluginsForDeviceType(deviceType: string): string[] {
  return DEVICE_TYPE_PLUGIN_POLICY.get(deviceType) ?? [];
}
