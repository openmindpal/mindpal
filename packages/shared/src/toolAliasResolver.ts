/**
 * 共享工具别名解析器
 *
 * 提供无状态的工具别名解析函数，供云端（hybridDispatcher / dispatch.stream）
 * 和端侧（capabilityRegistry / executors）共同使用。
 *
 * 端侧 capabilityRegistry 内部维护的是运行时动态注册的别名表；
 * 本模块提供：
 * 1. 默认内置别名映射（可配置覆盖）
 * 2. 前缀补全规则
 * 3. 纯函数解析（无副作用，适合云端无状态使用）
 *
 * @layer shared
 */

// ── 默认别名映射（等价于旧 TOOL_ALIAS_MAP） ───────────────────
export const DEFAULT_TOOL_ALIASES: Record<string, string> = {
  "browser.navigate": "device.browser.open",
  "device.browser.navigate": "device.browser.open",
  "browser.fill": "device.browser.type",
  "device.browser.fill": "device.browser.type",
  "desktop.screen.capture": "device.desktop.screenshot",
  "desktop.screenshot": "device.desktop.screenshot",
  "desktop.clipboard.get": "device.clipboard.read",
  "desktop.clipboard.set": "device.clipboard.write",
};

// ── 默认前缀补全规则 ──────────────────────────────────────────
export const DEFAULT_PREFIX_RULES: Record<string, string> = {
  "browser.": "device.browser.",
  "desktop.": "device.desktop.",
};

/**
 * 创建一个工具别名解析器实例（可自定义别名表和前缀规则）。
 * 返回的解析器是纯函数，适合在云端无状态场景中使用。
 */
export function createToolAliasResolver(options?: {
  aliases?: Record<string, string>;
  prefixRules?: Record<string, string>;
}) {
  const aliases = options?.aliases ?? DEFAULT_TOOL_ALIASES;
  const prefixRules = options?.prefixRules ?? DEFAULT_PREFIX_RULES;

  /**
   * 解析工具别名 → 标准名。
   * 优先级：1. 显式别名映射 → 2. 前缀补全规则 → 3. 原样返回
   */
  function resolve(name: string): string {
    // 1. 显式别名映射
    const explicit = aliases[name];
    if (explicit) return explicit;
    // 2. 前缀补全规则（最长前缀匹配）
    let bestPrefix = "";
    let bestReplacement = "";
    for (const [oldP, newP] of Object.entries(prefixRules)) {
      if (name.startsWith(oldP) && oldP.length > bestPrefix.length) {
        bestPrefix = oldP;
        bestReplacement = newP;
      }
    }
    if (bestPrefix) return bestReplacement + name.slice(bestPrefix.length);
    // 3. 原样返回
    return name;
  }

  /** 判断工具名（解析别名后）是否属于端侧设备工具 */
  function isDeviceTool(name: string): boolean {
    return resolve(name).startsWith("device.");
  }

  return { resolve, isDeviceTool };
}

// ── 默认实例（使用内置别名映射） ─────────────────────────────
const defaultResolver = createToolAliasResolver();

/** 使用默认别名映射解析工具名 */
export const resolveToolAlias = defaultResolver.resolve;

/** 判断工具名是否属于端侧设备工具（使用默认别名映射） */
export const isDeviceToolName = defaultResolver.isDeviceTool;
