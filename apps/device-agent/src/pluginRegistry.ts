/**
 * Device-Agent Plugin Registry — 设备代理插件注册中心
 *
 * 重新导出内核接口 + 提供外部目录加载能力。
 */

// ── 从内核重新导出 ────────────────────────────────────
export {
  registerPlugin,
  unregisterPlugin,
  findPluginForTool,
  listPlugins,
  clearAll as clearPlugins,
  dispatchMessageToPlugins,
} from "./kernel/capabilityRegistry";
export { initPlugin, disposeAllPlugins } from "./kernel/pluginLifecycle";
export type { ToolExecutionContext, ToolExecutionResult, DeviceMessageContext, DeviceToolPlugin } from "./kernel/types";

import { initPlugin } from "./kernel/pluginLifecycle";
import type { DeviceToolPlugin } from "./kernel/types";

// ── 外部插件加载 ──────────────────────────────────────────────

/**
 * 从指定目录加载外部插件。
 * 目录下每个 .js 文件应默认导出一个 DeviceToolPlugin 对象。
 *
 * 示例目录结构：
 *   /opt/device-plugins/
 *     factory-plc-plugin.js    → export default { name: "factory.plc", toolPrefixes: ["device.plc"], execute: ... }
 *     campus-gate-plugin.js   → export default { name: "campus.gate", toolPrefixes: ["device.gate"], execute: ... }
 *     robot-ros2-plugin.js    → export default { name: "robot.ros2", toolPrefixes: ["device.robot"], execute: ... }
 */
export async function loadPluginsFromDir(dirPath: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const loaded: string[] = [];

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (e: any) {
    throw new Error(`plugin_dir_read_failed: ${dirPath} - ${e?.message ?? "unknown"}`);
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js")) continue;

    const fullPath = nodePath.join(dirPath, entry.name);
    try {
      const mod = await import(fullPath);
      const plugin: any = mod.default ?? mod;
      if (
        !plugin ||
        typeof plugin !== "object" ||
        !plugin.name ||
        !Array.isArray(plugin.toolPrefixes) ||
        typeof plugin.execute !== "function"
      ) {
        process.stderr.write(`plugin_invalid_export: ${fullPath}（需导出 { name, toolPrefixes, execute }）\n`);
        continue;
      }
      const result = await initPlugin(plugin as DeviceToolPlugin);
      if (!result.success) {
        process.stderr.write(`plugin_init_failed: ${fullPath} - ${result.error ?? "unknown"}\n`);
        continue;
      }
      loaded.push(plugin.name);
    } catch (e: any) {
      process.stderr.write(`plugin_load_failed: ${fullPath} - ${e?.message ?? "unknown"}\n`);
    }
  }

  return loaded;
}
