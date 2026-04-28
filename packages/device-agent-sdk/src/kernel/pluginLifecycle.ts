/**
 * Device-OS 内核模块 #8：插件生命周期管理
 *
 * 统一插件 init → register → healthcheck → ready → execute → dispose → upgrade/rollback
 * 增加插件资源限制（内存上限、CPU 配额、并发上限）与隔离策略声明。
 *
 * @layer kernel
 *
 * [SDK迁移] 跨层依赖已解耦：
 * - `../deviceAgentEnv` → secretKey 通过 setSecretKeyProvider 注入
 * - `../plugins/capabilityProbe` → 通过 setCapabilityProbeProvider 注入
 */
import type { DeviceToolPlugin, PluginState, PluginResourceLimits, ToolExecutionContext, ToolExecutionResult, DeviceMessageContext, DeviceType, CapabilityDescriptor, DeviceCapabilityReport } from "./types";
import { verifyPluginSignature } from "./pluginSandbox";
import { registerPlugin, findPluginForTool, listPlugins, unregisterPlugin, dispatchMessageToPlugins, exportCapabilityManifest } from "./capabilityRegistry";

// ── 可注入的外部依赖 ──────────────────────────────────────
// [SDK迁移] 替代原 `resolveDeviceAgentEnv().secretKey` 和 `getCachedCapabilityReport`

let _secretKeyProvider: (() => string | undefined) | null = null;
let _capabilityProbeProvider: {
  getCachedCapabilityReport: () => DeviceCapabilityReport | null;
  isToolAvailableOnDevice: (toolRef: string, report: DeviceCapabilityReport) => boolean;
} | null = null;

/** 设置密钥提供者（由应用层注入，替代 resolveDeviceAgentEnv().secretKey） */
export function setSecretKeyProvider(fn: (() => string | undefined) | null): void {
  _secretKeyProvider = fn;
}

/** 设置能力探测提供者（由应用层注入，替代 capabilityProbe 模块） */
export function setCapabilityProbeProvider(provider: {
  getCachedCapabilityReport: () => DeviceCapabilityReport | null;
  isToolAvailableOnDevice: (toolRef: string, report: DeviceCapabilityReport) => boolean;
} | null): void {
  _capabilityProbeProvider = provider;
}

// ── 内部状态 ──────────────────────────────────────────────

// 插件注册成功后的回调（用于通知云端能力变更）
let _onCapabilityChanged: ((manifest: ReturnType<typeof exportCapabilityManifest>) => void) | null = null;

/** 设置能力变更回调（由 agent.ts / transport 层设置，用于向云端发送 capability_registered 消息） */
export function setOnCapabilityChanged(fn: ((manifest: ReturnType<typeof exportCapabilityManifest>) => void) | null): void {
  _onCapabilityChanged = fn;
}

const pluginStates = new Map<string, PluginState>();
const pluginErrors = new Map<string, string>();
const pluginLimits = new Map<string, PluginResourceLimits>();

// 当前设备类型（由 agent 启动时设置）
let _currentDeviceType: DeviceType = "desktop";

/** 设置当前设备类型（影响插件资源约束强制检查） */
export function setCurrentDeviceType(dt: DeviceType): void {
  _currentDeviceType = dt;
}
export function getCurrentDeviceType(): DeviceType {
  return _currentDeviceType;
}

// 设备类型硬约束
const DEVICE_RESOURCE_CAPS: Record<string, { maxMemoryMb: number; maxColdStartMs: number }> = {
  desktop: { maxMemoryMb: 50, maxColdStartMs: 5000 },
  mobile: { maxMemoryMb: 30, maxColdStartMs: 800 },
  iot: { maxMemoryMb: 30, maxColdStartMs: 800 },
  robot: { maxMemoryMb: 30, maxColdStartMs: 800 },
  vehicle: { maxMemoryMb: 30, maxColdStartMs: 800 },
  home: { maxMemoryMb: 30, maxColdStartMs: 800 },
  gateway: { maxMemoryMb: 30, maxColdStartMs: 800 },
};

function enforceResourceLimits(plugin: DeviceToolPlugin): PluginResourceLimits {
  const profileLimits = plugin.deviceTypeResourceProfiles?.[_currentDeviceType];
  const baseLimits = profileLimits ?? plugin.resourceLimits ?? {};
  const caps = DEVICE_RESOURCE_CAPS[_currentDeviceType] ?? DEVICE_RESOURCE_CAPS.desktop;
  return {
    ...baseLimits,
    maxMemoryMb: Math.min(baseLimits.maxMemoryMb ?? caps.maxMemoryMb, caps.maxMemoryMb),
  };
}

// 不可用能力记录（被能力探测过滤掉的能力，供诊断查询）
const _unavailableCapabilities = new Map<string, { toolRef: string; reason: string }[]>();

/** 获取因设备能力不足而被过滤的能力列表 */
export function getUnavailableCapabilities(): Map<string, { toolRef: string; reason: string }[]> {
  return new Map(_unavailableCapabilities);
}

/**
 * 根据能力探测结果过滤插件 capabilities。
 * 返回可用能力列表和被过滤掉的能力列表。
 */
function filterCapabilitiesByProbe(
  plugin: DeviceToolPlugin,
  report: DeviceCapabilityReport | null,
): { available: CapabilityDescriptor[]; filtered: { toolRef: string; reason: string }[] } {
  const caps = plugin.capabilities ?? [];
  if (!report || caps.length === 0 || !_capabilityProbeProvider) return { available: caps, filtered: [] };

  const available: CapabilityDescriptor[] = [];
  const filtered: { toolRef: string; reason: string }[] = [];

  for (const cap of caps) {
    if (_capabilityProbeProvider.isToolAvailableOnDevice(cap.toolRef, report)) {
      available.push(cap);
    } else {
      filtered.push({ toolRef: cap.toolRef, reason: "device_capability_not_available" });
    }
  }

  return { available, filtered };
}

// ── 生命周期管理 ──────────────────────────────────────────

export async function initPlugin(plugin: DeviceToolPlugin): Promise<{ success: boolean; error?: string; filteredCapabilities?: { toolRef: string; reason: string }[] }> {
  if (pluginStates.has(plugin.name)) return { success: false, error: "plugin_already_initialized" };

  // 外部插件签名校验（内置插件自动跳过）
  if (plugin.source === "external" && plugin.manifest) {
    const secretKey = _secretKeyProvider?.() ?? process.env.DEVICE_AGENT_SECRET_KEY;
    if (!secretKey) {
      console.warn(`[pluginLifecycle] plugin_signature_skipped: ${plugin.name} (no secretKey configured)`);
    } else if (!plugin.manifest.signature) {
      console.warn(`[pluginLifecycle] plugin_signature_skipped: ${plugin.name} (no signature in manifest)`);
    } else {
      const sigResult = verifyPluginSignature(plugin.manifest, secretKey);
      if (!sigResult.valid) {
        pluginStates.set(plugin.name, "error");
        console.error(`[pluginLifecycle] plugin_signature_failed: ${plugin.name}, reason=${sigResult.reason}`);
        return { success: false, error: `signature_verification_failed: ${sigResult.reason}` };
      }
    }
  }

  pluginStates.set(plugin.name, "initializing");

  // 保存资源限制声明（强制约束）
  const effectiveLimits = enforceResourceLimits(plugin);
  pluginLimits.set(plugin.name, effectiveLimits);

  try {
    if (typeof plugin.init === "function") {
      await plugin.init();
    }

    // 能力探测过滤：根据实际设备能力过滤不可用的 capabilities
    const capabilityReport = _capabilityProbeProvider?.getCachedCapabilityReport() ?? null;
    const { available, filtered } = filterCapabilitiesByProbe(plugin, capabilityReport);
    if (filtered.length > 0) {
      _unavailableCapabilities.set(plugin.name, filtered);
      console.log(`[pluginLifecycle] ${plugin.name}: ${filtered.length} capabilities filtered by device probe: ${filtered.map(f => f.toolRef).join(", ")}`);
    }

    // 创建一个只包含可用能力的插件副本用于注册
    const pluginForRegister: DeviceToolPlugin = available.length !== (plugin.capabilities ?? []).length
      ? { ...plugin, capabilities: available }
      : plugin;

    // 注册到能力注册表
    registerPlugin(pluginForRegister);
    pluginStates.set(plugin.name, "registered");

    // 执行健康检查
    if (typeof plugin.healthcheck === "function") {
      pluginStates.set(plugin.name, "healthchecking");
      try {
        const health = await plugin.healthcheck();
        if (!health.healthy) {
          unregisterPlugin(plugin.name);
          pluginStates.set(plugin.name, "error");
          pluginErrors.set(plugin.name, `healthcheck_failed: ${JSON.stringify(health.details)}`);
          return { success: false, error: "healthcheck_failed" };
        }
      } catch (e: any) {
        unregisterPlugin(plugin.name);
        pluginStates.set(plugin.name, "error");
        pluginErrors.set(plugin.name, `healthcheck_error: ${e?.message ?? "unknown"}`);
        return { success: false, error: "healthcheck_error" };
      }
    }

    pluginStates.set(plugin.name, "ready");
    // 通知云端能力变更（热插拔同步）
    try { _onCapabilityChanged?.(exportCapabilityManifest()); } catch { /* 非致命 */ }
    return { success: true, filteredCapabilities: filtered.length > 0 ? filtered : undefined };
  } catch (e: any) {
    pluginStates.set(plugin.name, "error");
    pluginErrors.set(plugin.name, e?.message ?? "unknown");
    return { success: false, error: e?.message ?? "unknown" };
  }
}

export async function disposePlugin(pluginName: string): Promise<{ success: boolean; error?: string }> {
  const currentState = pluginStates.get(pluginName);
  if (!currentState) return { success: false, error: "plugin_not_found" };
  if (currentState === "disposing") return { success: false, error: "plugin_already_disposing" };

  pluginStates.set(pluginName, "disposing");
  const plugin = listPlugins().find((p) => p.name === pluginName);
  if (!plugin) { pluginStates.delete(pluginName); return { success: false, error: "plugin_not_registered" }; }

  try {
    if (typeof plugin.dispose === "function") await plugin.dispose();
    unregisterPlugin(pluginName);
    pluginStates.set(pluginName, "disposed");
    return { success: true };
  } catch (e: any) {
    pluginStates.set(pluginName, "error");
    pluginErrors.set(pluginName, `dispose_error: ${e?.message ?? "unknown"}`);
    return { success: false, error: e?.message ?? "unknown" };
  }
}

export async function disposeAllPlugins(): Promise<{ successCount: number; errorCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;
  for (const plugin of listPlugins()) {
    const result = await disposePlugin(plugin.name);
    if (result.success) successCount++; else errors.push(`${plugin.name}: ${result.error}`);
  }
  return { successCount, errorCount: errors.length, errors };
}

export async function upgradePlugin(pluginName: string, newVersion: string): Promise<{ success: boolean; error?: string }> {
  const currentState = pluginStates.get(pluginName);
  if (currentState !== "ready") return { success: false, error: `plugin_not_ready (state=${currentState})` };

  const plugin = listPlugins().find((p) => p.name === pluginName);
  if (!plugin) return { success: false, error: "plugin_not_found" };
  if (typeof plugin.upgrade !== "function") return { success: false, error: "upgrade_not_supported" };

  pluginStates.set(pluginName, "upgrading");
  try {
    await plugin.upgrade(newVersion);
    pluginStates.set(pluginName, "ready");
    return { success: true };
  } catch (e: any) {
    pluginStates.set(pluginName, "error");
    pluginErrors.set(pluginName, `upgrade_error: ${e?.message ?? "unknown"}`);
    return { success: false, error: e?.message ?? "unknown" };
  }
}

export async function rollbackPlugin(pluginName: string, previousVersion: string): Promise<{ success: boolean; error?: string }> {
  const currentState = pluginStates.get(pluginName);
  if (currentState !== "ready" && currentState !== "error") return { success: false, error: `plugin_not_rollbackable (state=${currentState})` };

  const plugin = listPlugins().find((p) => p.name === pluginName);
  if (!plugin) return { success: false, error: "plugin_not_found" };
  if (typeof plugin.rollback !== "function") return { success: false, error: "rollback_not_supported" };

  pluginStates.set(pluginName, "rollingBack");
  try {
    await plugin.rollback(previousVersion);
    pluginStates.set(pluginName, "ready");
    return { success: true };
  } catch (e: any) {
    pluginStates.set(pluginName, "error");
    pluginErrors.set(pluginName, `rollback_error: ${e?.message ?? "unknown"}`);
    return { success: false, error: e?.message ?? "unknown" };
  }
}

// ── 健康检查 ──────────────────────────────────────────────

export async function healthcheckPlugin(pluginName: string): Promise<{ healthy: boolean; details?: Record<string, unknown>; error?: string }> {
  const plugin = listPlugins().find((p) => p.name === pluginName);
  if (!plugin) return { healthy: false, error: "plugin_not_found" };

  if (typeof plugin.healthcheck !== "function") return { healthy: true, details: { noHealthcheck: true } };

  try {
    pluginStates.set(pluginName, "healthchecking");
    const result = await plugin.healthcheck();
    pluginStates.set(pluginName, result.healthy ? "ready" : "error");
    if (!result.healthy) pluginErrors.set(pluginName, JSON.stringify(result.details));
    return result;
  } catch (e: any) {
    pluginStates.set(pluginName, "error");
    pluginErrors.set(pluginName, e?.message ?? "unknown");
    return { healthy: false, error: e?.message ?? "unknown" };
  }
}

export async function healthcheckAllPlugins(): Promise<Record<string, { healthy: boolean; details?: Record<string, unknown>; error?: string }>> {
  const results: Record<string, { healthy: boolean; details?: Record<string, unknown>; error?: string }> = {};
  for (const plugin of listPlugins()) results[plugin.name] = await healthcheckPlugin(plugin.name);
  return results;
}

// ── 状态查询 ──────────────────────────────────────────────

export function getPluginState(pluginName: string): PluginState | undefined { return pluginStates.get(pluginName); }
export function getPluginError(pluginName: string): string | undefined { return pluginErrors.get(pluginName); }
export function getPluginResourceLimits(pluginName: string): PluginResourceLimits | undefined { return pluginLimits.get(pluginName); }

export function listPluginStates(): Array<{ name: string; state: PluginState; error?: string; toolPrefixes: string[] }> {
  return listPlugins().map((p) => ({ name: p.name, state: pluginStates.get(p.name) ?? "unloaded", error: pluginErrors.get(p.name), toolPrefixes: p.toolPrefixes }));
}

// ── 直接注册函数（跳过 init/healthcheck）──

export function registerPluginDirect(plugin: DeviceToolPlugin): void {
  registerPlugin(plugin);
  if (!pluginStates.has(plugin.name)) pluginStates.set(plugin.name, "ready");
}
