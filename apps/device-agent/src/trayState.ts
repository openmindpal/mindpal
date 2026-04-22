/**
 * trayState.ts — 托盘状态缓存服务
 *
 * 统一管理能力清单和插件状态查询的轻量缓存层，
 * 支持事件驱动更新，消除 trayMenuBuilder / trayToolHandlers 中重复的 listCapabilities() 调用。
 *
 * @layer infra
 */
import { listCapabilities } from "./kernel/capabilityRegistry";
import type { CapabilityDescriptor } from "./kernel/types";
import { listPluginStates } from "./kernel/pluginLifecycle";

type PluginStateEntry = ReturnType<typeof listPluginStates>[number];

let _cachedCapabilities: CapabilityDescriptor[] | null = null;
let _cachedPluginStates: PluginStateEntry[] | null = null;

// 事件监听器列表
const _listeners: Array<() => void> = [];

/** 获取缓存的能力清单（懒加载） */
export function getCachedCapabilities(): CapabilityDescriptor[] {
  if (!_cachedCapabilities) _cachedCapabilities = listCapabilities();
  return _cachedCapabilities;
}

/** 获取缓存的插件状态（懒加载） */
export function getCachedPluginStates(): PluginStateEntry[] {
  if (!_cachedPluginStates) _cachedPluginStates = listPluginStates();
  return _cachedPluginStates;
}

/**
 * 当能力或插件状态变化时调用，清除缓存并通知所有监听者。
 * 由 pluginLifecycle.ts 中的 _onCapabilityChanged 回调触发。
 */
export function invalidateTrayState(): void {
  _cachedCapabilities = null;
  _cachedPluginStates = null;
  for (const fn of _listeners) {
    try { fn(); } catch { /* 非致命 */ }
  }
}

/**
 * 注册托盘状态变更监听器，返回取消注册函数。
 * 由 tray.ts 调用，替代原有的 setInterval 定时刷新。
 */
export function onTrayStateChange(fn: () => void): () => void {
  _listeners.push(fn);
  return () => {
    const idx = _listeners.indexOf(fn);
    if (idx !== -1) _listeners.splice(idx, 1);
  };
}
