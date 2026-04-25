"use client";

/**
 * 工具显示名称缓存 - 从后端 API 工具元数据动态获取
 * 替代 i18n 文件中的硬编码工具名，支持无限数量的自定义技能
 */

import { apiFetch } from "@/lib/api";

interface ToolDisplayNameEntry {
  displayName: Record<string, string>; // multi-lang { "zh-CN": "xx", "en-US": "xx" }
}

const cache = new Map<string, ToolDisplayNameEntry>();
let lastFullLoad = 0;
const FULL_LOAD_TTL = 5 * 60 * 1000; // 5 min TTL
let loadingPromise: Promise<void> | null = null;

/**
 * 同步获取工具显示名称（从缓存中读取）
 * 如果缓存未命中，返回 null（调用方应降级到工具名原文）
 */
export function getToolDisplayName(toolName: string, locale: string = "zh-CN"): string | null {
  const entry = cache.get(toolName);
  if (!entry) return null;
  return entry.displayName[locale] || entry.displayName["zh-CN"] || entry.displayName["en-US"] || null;
}

/**
 * 预热工具名称缓存 - 批量加载所有工具的 displayName
 * 应在面板数据加载完成后调用一次
 */
export async function preloadToolNames(): Promise<void> {
  const now = Date.now();
  if (now - lastFullLoad < FULL_LOAD_TTL) return; // skip reload within TTL
  if (loadingPromise) return loadingPromise; // prevent concurrent loads

  loadingPromise = (async () => {
    try {
      // 使用 governance/tools 端点获取完整工具列表
      const res = await apiFetch("/governance/tools?limit=500&fields=name,display_name");
      if (!res.ok) return;
      const json = await res.json();
      const tools: Record<string, unknown>[] = json?.tools || json?.items || [];

      for (const tool of tools) {
        const name = (tool.name || tool.toolRef) as string | undefined;
        if (!name) continue;
        // 去除 @version 后缀
        const cleanName = name.includes("@") ? name.slice(0, name.lastIndexOf("@")) : name;
        const displayName = (tool.displayName || tool.display_name) as Record<string, string> | undefined;
        if (displayName && typeof displayName === "object") {
          cache.set(cleanName, { displayName });
        }
      }
      lastFullLoad = Date.now();
    } catch {
      // 加载失败静默降级，不影响UI
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}
