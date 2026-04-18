/**
 * configRegistry.ts — 统一配置注册表
 *
 * 所有环境变量的唯一注册来源。每个变量携带元数据：
 * - level: bootstrap（启动时固定，需重启）| runtime（运行时可变，可热更新）
 * - scope: 该变量影响的应用组件
 * - default: 默认值
 * - sensitive: 是否敏感（不可明文日志输出）
 * - runtimeMutable: runtime 级变量是否可通过 governance control plane 热更新
 *
 * 数据条目外置于 configRegistry.data.json，便于工具链消费和非开发者编辑。
 */

import registryData from "./configRegistry.data.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 配置级别 */
export type ConfigLevel = "bootstrap" | "runtime";

/** 配置所属应用范围 */
export type ConfigScope = "api" | "worker" | "shared" | "runner";

/** 配置值类型 */
export type ConfigValueType = "string" | "number" | "boolean" | "string[]";

/** 单条配置条目元数据 */
export interface ConfigEntry {
  /** 环境变量名 */
  envKey: string;
  /** 配置级别 */
  level: ConfigLevel;
  /** 配置值类型 */
  valueType: ConfigValueType;
  /** 默认值（字符串形式，undefined 表示无默认值必须提供） */
  defaultValue?: string;
  /** 影响的应用范围 */
  scopes: ConfigScope[];
  /** 是否敏感（密钥/密码等） */
  sensitive: boolean;
  /** runtime 级是否可通过 governance control plane 热更新 */
  runtimeMutable: boolean;
  /** 人类可读描述 */
  description: string;
  /** 可选：已知合法值枚举 */
  validValues?: string[];
}

// ---------------------------------------------------------------------------
// Registry — 数据从 JSON 加载，保持类型安全
// ---------------------------------------------------------------------------

export const CONFIG_REGISTRY: readonly ConfigEntry[] = registryData as ConfigEntry[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 按级别筛选 */
export function getConfigsByLevel(level: ConfigLevel): ConfigEntry[] {
  return CONFIG_REGISTRY.filter((e) => e.level === level);
}

/** 按应用范围筛选 */
export function getConfigsByScope(scope: ConfigScope): ConfigEntry[] {
  return CONFIG_REGISTRY.filter((e) => e.scopes.includes(scope));
}

/** 获取所有可通过 governance 热更新的 runtime 配置 */
export function getRuntimeMutableConfigs(): ConfigEntry[] {
  return CONFIG_REGISTRY.filter((e) => e.level === "runtime" && e.runtimeMutable);
}

/** 按 envKey 查找 */
export function findConfigEntry(envKey: string): ConfigEntry | undefined {
  return CONFIG_REGISTRY.find((e) => e.envKey === envKey);
}

/** 解析 env 字符串值为目标类型 */
export function parseConfigValue(entry: ConfigEntry, raw: string | undefined): string | number | boolean | string[] | undefined {
  const v = raw?.trim();
  if (v === undefined || v === "") {
    if (entry.defaultValue !== undefined) return parseConfigValue(entry, entry.defaultValue);
    return undefined;
  }
  switch (entry.valueType) {
    case "number": return Number(v) || 0;
    case "boolean": return v === "1" || v === "true" || v === "yes";
    case "string[]": return v.split(",").map((s) => s.trim()).filter(Boolean);
    default: return v;
  }
}

/** 验证 env 值是否在合法范围内（如果有定义 validValues） */
export function validateConfigValue(entry: ConfigEntry, raw: string | undefined): { valid: boolean; reason?: string } {
  if (!entry.validValues || entry.validValues.length === 0) return { valid: true };
  const v = (raw ?? "").trim();
  if (!v && entry.defaultValue !== undefined) return { valid: true };
  if (!v) return { valid: true }; // 空值由 required 逻辑处理
  if (!entry.validValues.includes(v)) {
    return { valid: false, reason: `${entry.envKey}="${v}" not in [${entry.validValues.join(", ")}]` };
  }
  return { valid: true };
}
