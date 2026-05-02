/**
 * Device-Agent Plugin Registry — 外部插件目录加载
 */
import { initPlugin } from "@mindpal/device-agent-sdk";
import type { DeviceToolPlugin } from "@mindpal/device-agent-sdk";
import type { PluginManifest } from "@mindpal/device-agent-sdk";

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
      // 尝试读取同目录下的 manifest.json（外部插件签名校验依赖）
      let manifest: PluginManifest | undefined;
      const manifestPath = nodePath.join(dirPath, entry.name.replace(/\.js$/, ".manifest.json"));
      const dirManifestPath = nodePath.join(dirPath, "manifest.json");
      try {
        // 优先查找 <pluginName>.manifest.json，其次查找目录级 manifest.json
        const raw = await fs.readFile(manifestPath, "utf-8").catch(() => fs.readFile(dirManifestPath, "utf-8"));
        manifest = JSON.parse(raw) as PluginManifest;
      } catch {
        // manifest 不存在：不阻塞加载（渐进式安全）
      }

      const mod = await import(fullPath);
      const plugin: Record<string, unknown> = mod.default ?? mod;
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
      const externalPlugin: DeviceToolPlugin = {
        ...(plugin as unknown as DeviceToolPlugin),
        source: "external" as const,
        ...(manifest ? { manifest } : {}),
      };
      const result = await initPlugin(externalPlugin);
      if (!result.success) {
        process.stderr.write(`plugin_init_failed: ${fullPath} - ${result.error ?? "unknown"}\n`);
        continue;
      }
      loaded.push(String(plugin.name));
    } catch (e: any) {
      process.stderr.write(`plugin_load_failed: ${fullPath} - ${e?.message ?? "unknown"}\n`);
    }
  }

  return loaded;
}
