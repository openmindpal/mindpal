/**
 * Device-OS 内核服务：OCR 坐标缓存
 *
 * 统一 streamingExecutor 和 guiAutomationPlugin 中两套
 * CoordCache / OcrCoordinateCache 为单一内核级服务。
 * TTL + LRU 淘汰，全局单例共享缓存状态。
 *
 * @layer kernel
 *
 * [SDK迁移] 原 `from "../deviceAgentEnv"` 跨层依赖已解耦：
 * TTL 和 maxEntries 参数改为构造函数传参，不再硬绑定环境变量读取。
 * 默认值与原 deviceAgentEnv 一致（TTL=2000ms, maxEntries=100）。
 */

export class OcrCacheService {
  private cache = new Map<string, { x: number; y: number; cachedAt: number; confidence: number }>();
  private ttlMs: number;
  private maxEntries: number;

  constructor(ttlMs?: number, maxEntries?: number) {
    this.ttlMs = ttlMs ?? 2000;
    this.maxEntries = maxEntries ?? 100;
  }

  get(key: string): { x: number; y: number; confidence: number } | null {
    const e = this.cache.get(key);
    if (!e) return null;
    if (Date.now() - e.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    // LRU touch: delete and re-set to move entry to Map tail
    this.cache.delete(key);
    this.cache.set(key, e);
    return { x: e.x, y: e.y, confidence: e.confidence };
  }

  set(key: string, coord: { x: number; y: number }, confidence = 1): void {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { ...coord, cachedAt: Date.now(), confidence });
  }

  invalidateAll(): void { this.cache.clear(); }

  get size(): number { return this.cache.size; }
}

// 全局单例
let _instance: OcrCacheService | null = null;

export function getOcrCacheService(ttlMs?: number, maxEntries?: number): OcrCacheService {
  if (!_instance) _instance = new OcrCacheService(ttlMs, maxEntries);
  return _instance;
}

/** 重置全局单例（仅用于测试） */
export function resetOcrCacheService(): void {
  if (_instance) _instance.invalidateAll();
  _instance = null;
}
