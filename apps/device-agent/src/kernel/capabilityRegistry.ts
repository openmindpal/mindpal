/**
 * Device-OS 内核模块 #3：能力注册与发现
 *
 * 正式的 Capability Registry，支持：
 * - 插件声明 toolRef / schema / riskLevel / 资源需求 / 并发限制
 * - 按前缀匹配、标签过滤、风险等级查询
 * - 统一 device.<domain>.<action>[@version] 命名
 *
 * @layer kernel
 */
import type { CapabilityDescriptor, RiskLevel, DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult, DeviceMessageContext } from "./types";
import { DEFAULT_TOOL_ALIASES, DEFAULT_PREFIX_RULES } from "@openslin/shared";

// ── 内部注册表 ──────────────────────────────────────────────

const _capabilities = new Map<string, CapabilityDescriptor>();
const _plugins = new Map<string, DeviceToolPlugin>();

// ── 动态别名注册表（替代硬编码 TOOL_ALIAS_MAP） ─────────────
// alias → canonical name，如 "browser.navigate" → "device.browser.open"
const _toolAliases = new Map<string, string>();
// 前缀补全规则：oldPrefix → newPrefix，如 "browser." → "device.browser."
const _prefixRules = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCapabilityDescriptor(cap: CapabilityDescriptor): void {
  if (!cap.toolRef || typeof cap.toolRef !== "string") throw new Error("capability_invalid_toolRef");
  if (!["low", "medium", "high", "critical"].includes(cap.riskLevel)) throw new Error(`capability_invalid_risk_level: ${cap.toolRef}`);
  if (cap.inputSchema !== undefined && !isRecord(cap.inputSchema)) throw new Error(`capability_invalid_input_schema: ${cap.toolRef}`);
  if (cap.outputSchema !== undefined && !isRecord(cap.outputSchema)) throw new Error(`capability_invalid_output_schema: ${cap.toolRef}`);
  if (cap.resourceRequirements !== undefined && !isRecord(cap.resourceRequirements)) throw new Error(`capability_invalid_resource_requirements: ${cap.toolRef}`);
  if (cap.concurrencyLimit !== undefined && (!Number.isInteger(cap.concurrencyLimit) || cap.concurrencyLimit < 0)) {
    throw new Error(`capability_invalid_concurrency_limit: ${cap.toolRef}`);
  }
  if (cap.version !== undefined && (typeof cap.version !== "string" || cap.version.trim() === "")) {
    throw new Error(`capability_invalid_version: ${cap.toolRef}`);
  }
  if (cap.tags !== undefined && (!Array.isArray(cap.tags) || cap.tags.some((tag) => typeof tag !== "string" || tag.trim() === ""))) {
    throw new Error(`capability_invalid_tags: ${cap.toolRef}`);
  }
  if (cap.description !== undefined && (typeof cap.description !== "string" || cap.description.trim() === "")) {
    throw new Error(`capability_invalid_description: ${cap.toolRef}`);
  }
}

function inferRiskLevel(toolRef: string): RiskLevel {
  if (/\b(revoke|rotate|delete|remove|shutdown|kill|format|wipe|emergency|launch|write|upload)\b/i.test(toolRef)) return "high";
  if (/\b(click|type|scroll|select|move|drag|focus|resize|open|close|capture|screenshot|ocr|evaluate)\b/i.test(toolRef)) return "medium";
  return "low";
}

function inferCapabilitiesFromPlugin(plugin: DeviceToolPlugin): CapabilityDescriptor[] {
  const names = Array.isArray(plugin.toolNames) ? plugin.toolNames : [];
  const uniqueDeviceTools = [...new Set(names.filter((name) => typeof name === "string" && name.startsWith("device.")))];
  return uniqueDeviceTools.map((toolRef) => ({
    toolRef,
    riskLevel: inferRiskLevel(toolRef),
    version: plugin.version,
    tags: [plugin.name, ...plugin.toolPrefixes.filter((prefix) => toolRef === prefix || toolRef.startsWith(`${prefix}.`))],
    description: `${plugin.name}:${toolRef}`,
  }));
}

// ── 别名注册 API（P4 动态化：运行时可注册/替换） ─────────────

/** 注册单个工具别名：alias → canonical */
export function registerToolAlias(alias: string, canonical: string): void {
  _toolAliases.set(alias, canonical);
}

/** 批量注册工具别名 */
export function registerToolAliases(map: Record<string, string>): void {
  for (const [alias, canonical] of Object.entries(map)) {
    _toolAliases.set(alias, canonical);
  }
}

/** 注册前缀补全规则：oldPrefix → newPrefix */
export function registerPrefixRule(oldPrefix: string, newPrefix: string): void {
  _prefixRules.set(oldPrefix, newPrefix);
}

/** 批量注册前缀补全规则 */
export function registerPrefixRules(rules: Record<string, string>): void {
  for (const [old, nw] of Object.entries(rules)) {
    _prefixRules.set(old, nw);
  }
}

/**
 * 解析工具别名 → 标准名。
 * 优先级：1. 显式别名映射 → 2. 前缀补全规则 → 3. 原样返回
 */
export function resolveToolAlias(name: string): string {
  // 1. 显式别名映射
  const explicit = _toolAliases.get(name) ?? DEFAULT_TOOL_ALIASES[name];
  if (explicit) return explicit;
  // 2. 前缀补全规则（最长前缀匹配）
  let bestPrefix = "";
  let bestReplacement = "";
  const allPrefixRules = new Map<string, string>([
    ...Object.entries(DEFAULT_PREFIX_RULES),
    ...Array.from(_prefixRules.entries()),
  ]);
  for (const [oldP, newP] of allPrefixRules) {
    if (name.startsWith(oldP) && oldP.length > bestPrefix.length) {
      bestPrefix = oldP;
      bestReplacement = newP;
    }
  }
  if (bestPrefix) return bestReplacement + name.slice(bestPrefix.length);
  // 3. 原样返回
  return name;
}

/** 列出所有已注册别名 */
export function listToolAliases(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [alias, canonical] of _toolAliases) result[alias] = canonical;
  return result;
}

/** 列出所有前缀补全规则 */
export function listPrefixRules(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [old, nw] of _prefixRules) result[old] = nw;
  return result;
}

/**
 * 从 JSON 配置文件加载别名和前缀规则。
 * 文件格式：{ "aliases": { "old": "new" }, "prefixRules": { "oldPrefix": "newPrefix" } }
 * 支持热重载：多次调用会追加而非覆盖。
 */
export async function loadAliasesFromFile(filePath: string): Promise<{ aliasCount: number; prefixCount: number }> {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(content);
  let aliasCount = 0;
  let prefixCount = 0;
  if (data.aliases && typeof data.aliases === "object") {
    registerToolAliases(data.aliases);
    aliasCount = Object.keys(data.aliases).length;
  }
  if (data.prefixRules && typeof data.prefixRules === "object") {
    registerPrefixRules(data.prefixRules);
    prefixCount = Object.keys(data.prefixRules).length;
  }
  return { aliasCount, prefixCount };
}

/**
 * 从环境变量加载别名映射。
 * 约定：DEVICE_TOOL_ALIAS_<ALIAS>=<CANONICAL>
 * 例如：DEVICE_TOOL_ALIAS_browser_navigate=device.browser.open
 * 别名中的 "_" 会被转为 "."。
 */
export function loadAliasesFromEnv(): number {
  const PREFIX = "DEVICE_TOOL_ALIAS_";
  let count = 0;
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(PREFIX) && value) {
      const alias = key.slice(PREFIX.length).replace(/_/g, ".").toLowerCase();
      registerToolAlias(alias, value);
      count++;
    }
  }
  return count;
}

/**
 * 初始化别名注册表：加载默认内置别名 + 环境变量覆盖 + 可选配置文件。
 * 应在设备代理启动时调用一次。
 */
export async function initToolAliases(configFilePath?: string): Promise<void> {
  // 1. 加载共享包中的默认内置别名
  registerToolAliases(DEFAULT_TOOL_ALIASES);
  registerPrefixRules(DEFAULT_PREFIX_RULES);
  // 2. 环境变量覆盖
  loadAliasesFromEnv();
  // 3. 配置文件覆盖（优先级最高）
  if (configFilePath) {
    try {
      await loadAliasesFromFile(configFilePath);
    } catch {
      // 配置文件不存在时静默忽略
    }
  }
}

// ── 能力清单导出（供心跳/会话同步上报） ──────────────────────

/** 能力清单条目（与云端 DiscoveredTool 结构对齐，供心跳同步上报） */
export interface CapabilityManifestEntry {
  toolRef: string;
  riskLevel: string;
  version?: string;
  tags?: string[];
  description?: string;
  pluginName?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/**
 * 导出当前端侧已注册能力清单（标准 JSON 格式）。
 * 结构与云端 toolAutoDiscovery.ts 中的 DiscoveredTool 对齐，
 * 供心跳或会话同步时上报给 API 层。
 */
export function exportCapabilityManifest(): CapabilityManifestEntry[] {
  const entries: CapabilityManifestEntry[] = [];
  for (const [toolRef, cap] of _capabilities) {
    // 查找该能力属于哪个插件
    let pluginName: string | undefined;
    for (const p of _plugins.values()) {
      for (const prefix of p.toolPrefixes) {
        if (toolRef === prefix || toolRef.startsWith(prefix + ".")) {
          pluginName = p.name;
          break;
        }
      }
      if (pluginName) break;
    }
    entries.push({
      toolRef,
      riskLevel: cap.riskLevel,
      version: cap.version,
      tags: cap.tags,
      description: cap.description,
      pluginName,
      inputSchema: cap.inputSchema,
      outputSchema: cap.outputSchema,
    });
  }
  return entries;
}

// ── 能力注册 ────────────────────────────────────────────────

/** 注册单个能力 */
export function registerCapability(cap: CapabilityDescriptor): void {
  if (_capabilities.has(cap.toolRef)) {
    throw new Error(`capability_already_registered: ${cap.toolRef}`);
  }
  validateCapabilityDescriptor(cap);
  // 命名规范校验：必须以 device. 开头，或已通过 registerCapability 显式注册（如 noop/echo 由 builtinToolPlugin 注册）
  // 注：不再硬编码 isKernelTool 白名单，所有工具通过插件声明 capabilities 注册
  _capabilities.set(cap.toolRef, cap);
}

/** 批量注册能力（通常在插件注册时调用） */
export function registerCapabilities(caps: CapabilityDescriptor[]): void {
  for (const cap of caps) registerCapability(cap);
}

/** 注销能力 */
export function unregisterCapability(toolRef: string): boolean {
  return _capabilities.delete(toolRef);
}

/** 注销插件的所有能力 */
export function unregisterPluginCapabilities(pluginName: string): number {
  const plugin = _plugins.get(pluginName);
  if (!plugin) return 0;
  let count = 0;
  for (const prefix of plugin.toolPrefixes) {
    for (const [ref] of _capabilities) {
      if (ref === prefix || ref.startsWith(prefix + ".")) {
        _capabilities.delete(ref);
        count++;
      }
    }
  }
  return count;
}

// ── 能力查询 ────────────────────────────────────────────────

/** 获取单个能力 */
export function getCapability(toolRef: string): CapabilityDescriptor | null {
  return _capabilities.get(toolRef) ?? null;
}

/** 按前缀查询能力 */
export function findCapabilitiesByPrefix(prefix: string): CapabilityDescriptor[] {
  const results: CapabilityDescriptor[] = [];
  for (const [ref, cap] of _capabilities) {
    if (ref === prefix || ref.startsWith(prefix + ".")) results.push(cap);
  }
  return results;
}

/** 按风险等级查询能力 */
export function findCapabilitiesByRiskLevel(riskLevel: RiskLevel): CapabilityDescriptor[] {
  return Array.from(_capabilities.values()).filter((c) => c.riskLevel === riskLevel);
}

/** 按标签查询能力 */
export function findCapabilitiesByTag(tag: string): CapabilityDescriptor[] {
  return Array.from(_capabilities.values()).filter((c) => c.tags?.includes(tag));
}

/** 列出所有已注册能力 */
export function listCapabilities(): CapabilityDescriptor[] {
  return Array.from(_capabilities.values());
}

/** 获取工具的风险等级 */
export function getToolRiskLevel(toolName: string): RiskLevel | undefined {
  return _capabilities.get(toolName)?.riskLevel;
}

// ── 插件注册 ────────────────────────────────────────────────

/** 注册插件（包含其声明的能力） */
export function registerPlugin(plugin: DeviceToolPlugin): void {
  if (_plugins.has(plugin.name)) {
    throw new Error(`plugin_already_registered: ${plugin.name}`);
  }
  _plugins.set(plugin.name, plugin);

  const declaredCapabilities = Array.isArray(plugin.capabilities) && plugin.capabilities.length > 0
    ? plugin.capabilities.map((cap) => ({ ...cap, version: cap.version ?? plugin.version }))
    : inferCapabilitiesFromPlugin(plugin);
  if (declaredCapabilities.length > 0) registerCapabilities(declaredCapabilities);
}

/** 注销插件 */
export function unregisterPlugin(name: string): boolean {
  unregisterPluginCapabilities(name);
  return _plugins.delete(name);
}

/** 根据工具名查找能处理它的插件（最长前缀匹配） */
export function findPluginForTool(toolName: string): DeviceToolPlugin | null {
  let best: DeviceToolPlugin | null = null;
  let bestLen = 0;
  for (const p of _plugins.values()) {
    for (const prefix of p.toolPrefixes) {
      if (toolName === prefix || toolName.startsWith(prefix + ".")) {
        if (prefix.length > bestLen) { best = p; bestLen = prefix.length; }
      }
    }
  }
  return best;
}

/** 列出所有已注册插件 */
export function listPlugins(): DeviceToolPlugin[] {
  return Array.from(_plugins.values());
}

/** 清空所有插件、能力和别名（仅用于测试） */
export function clearAll(): void {
  _plugins.clear();
  _capabilities.clear();
  _toolAliases.clear();
  _prefixRules.clear();
}

// ── 消息分发 ────────────────────────────────────────────────

/** 广播消息给所有感兴趣的插件 */
export async function dispatchMessageToPlugins(ctx: DeviceMessageContext): Promise<void> {
  for (const p of _plugins.values()) {
    if (typeof p.onMessage !== "function") continue;
    if (ctx.topic && Array.isArray(p.messageTopics) && p.messageTopics.length > 0) {
      const match = p.messageTopics.some((t) => ctx.topic === t || ctx.topic!.startsWith(t + "."));
      if (!match) continue;
    }
    try { await p.onMessage(ctx); } catch (e: any) {
      process.stderr.write(`plugin_message_error: ${p.name} - ${e?.message ?? "unknown"}\n`);
    }
  }
}
