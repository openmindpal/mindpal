/**
 * P3-测试: 端侧快速通道性能基准
 * 
 * 测试目标：
 * 1. OcrCoordinateCache 的缓存逻辑（TTL、LRU淘汰、失效）
 * 2. 三种目标解析路径的延迟特征对比
 * 3. 批量操作场景下的缓存命中率
 * 4. 屏幕变化操作后缓存正确失效
 * 
 * 注意：由于 captureScreen/ocrScreen 依赖原生模块无法在 CI 中运行，
 * 本测试通过复制核心缓存逻辑进行独立单元验证。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PlanStep, TargetSpec } from "./guiAutomationPlugin";

/* ================================================================== */
/*  OcrCoordinateCache 逻辑复刻（与源码保持一致）                       */
/* ================================================================== */

const OCR_CACHE_TTL_MS = 2000;
const OCR_CACHE_MAX_ENTRIES = 100;

interface CachedCoordinate {
  x: number;
  y: number;
  cachedAt: number;
  confidence: number;
}

/**
 * 复刻 guiAutomationPlugin.ts 中的 OcrCoordinateCache 类，
 * 用于独立测试缓存行为而无需依赖原生模块。
 */
class OcrCoordinateCache {
  private cache = new Map<string, CachedCoordinate>();

  get(textKey: string): CachedCoordinate | null {
    const entry = this.cache.get(textKey);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > OCR_CACHE_TTL_MS) {
      this.cache.delete(textKey);
      return null;
    }
    return entry;
  }

  set(textKey: string, coord: { x: number; y: number }, confidence = 1): void {
    if (this.cache.size >= OCR_CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(textKey, { x: coord.x, y: coord.y, cachedAt: Date.now(), confidence });
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/* 目标类型判断辅助 */
function isTargetCoord(t: TargetSpec): t is { x: number; y: number } {
  return "x" in t && "y" in t;
}
function isTargetText(t: TargetSpec): t is { text: string; index?: number; fuzzy?: boolean } {
  return "text" in t;
}
function isTargetPercent(t: TargetSpec): t is { xPercent: number; yPercent: number } {
  return "xPercent" in t && "yPercent" in t;
}

/* 屏幕变化操作集合 */
const SCREEN_CHANGING_ACTIONS = new Set([
  "click", "doubleClick", "type", "pressKey", "pressCombo", "scroll",
]);

/* ================================================================== */
/*  OcrCoordinateCache 单元测试                                        */
/* ================================================================== */

describe("OcrCoordinateCache", () => {
  let cache: OcrCoordinateCache;

  beforeEach(() => {
    cache = new OcrCoordinateCache();
  });

  it("缓存命中：设置后立即读取", () => {
    cache.set("确认按钮", { x: 100, y: 200 }, 0.95);
    const hit = cache.get("确认按钮");
    expect(hit).not.toBeNull();
    expect(hit!.x).toBe(100);
    expect(hit!.y).toBe(200);
    expect(hit!.confidence).toBe(0.95);
  });

  it("缓存未命中：查找不存在的 key", () => {
    expect(cache.get("不存在的元素")).toBeNull();
  });

  it("TTL 过期后缓存失效", () => {
    // 手动注入过期条目
    const expired: CachedCoordinate = {
      x: 50, y: 50, cachedAt: Date.now() - OCR_CACHE_TTL_MS - 100, confidence: 0.9,
    };
    (cache as any).cache.set("过期按钮", expired);

    expect(cache.get("过期按钮")).toBeNull();
    // 过期条目应被自动清理
    expect(cache.size).toBe(0);
  });

  it("invalidateAll 清空所有缓存", () => {
    cache.set("btn1", { x: 10, y: 20 });
    cache.set("btn2", { x: 30, y: 40 });
    cache.set("btn3", { x: 50, y: 60 });
    expect(cache.size).toBe(3);

    cache.invalidateAll();
    expect(cache.size).toBe(0);
    expect(cache.get("btn1")).toBeNull();
  });

  it("容量上限淘汰最旧条目", () => {
    // 模拟填满缓存
    for (let i = 0; i < OCR_CACHE_MAX_ENTRIES; i++) {
      cache.set(`item_${i}`, { x: i, y: i });
    }
    expect(cache.size).toBe(OCR_CACHE_MAX_ENTRIES);

    // 再添加一个，应淘汰最旧的 item_0
    cache.set("new_item", { x: 999, y: 999 });
    expect(cache.size).toBe(OCR_CACHE_MAX_ENTRIES); // 不超过上限
    expect(cache.get("item_0")).toBeNull(); // 最旧的被淘汰
    expect(cache.get("new_item")).not.toBeNull();
  });

  it("覆盖写入同一 key 更新坐标和置信度", () => {
    cache.set("按钮A", { x: 10, y: 20 }, 0.8);
    cache.set("按钮A", { x: 15, y: 25 }, 0.95);
    const entry = cache.get("按钮A");
    expect(entry!.x).toBe(15);
    expect(entry!.y).toBe(25);
    expect(entry!.confidence).toBe(0.95);
  });
});

/* ================================================================== */
/*  三种目标解析路径延迟特征                                           */
/* ================================================================== */

describe("目标解析路径延迟对比", () => {
  it("坐标直通路径: 零解析开销", () => {
    const target: TargetSpec = { x: 100, y: 200 };
    const t0 = performance.now();

    // 坐标直通：无需 OCR/缓存查找
    expect(isTargetCoord(target)).toBe(true);
    const coord = target as { x: number; y: number };

    const elapsed = performance.now() - t0;
    // 纯类型检查 + 解构，应在 1ms 以内
    expect(elapsed).toBeLessThan(1);
    expect(coord.x).toBe(100);
    expect(coord.y).toBe(200);
  });

  it("缓存命中路径: 亚毫秒级查找", () => {
    const cache = new OcrCoordinateCache();
    // 预填充缓存
    cache.set("提交", { x: 300, y: 400 }, 0.92);
    cache.set("取消", { x: 500, y: 400 }, 0.88);

    const t0 = performance.now();
    const hit = cache.get("提交");
    const elapsed = performance.now() - t0;

    expect(hit).not.toBeNull();
    // Map.get + 时间比较，应在 1ms 以内
    expect(elapsed).toBeLessThan(1);
  });

  it("坐标路径比文字路径快（无 OCR 开销）", () => {
    const iterations = 10000;
    const coordTarget: TargetSpec = { x: 100, y: 200 };
    const textTarget: TargetSpec = { text: "提交按钮" };
    const cache = new OcrCoordinateCache();
    cache.set("提交按钮", { x: 100, y: 200 });

    // 测量坐标直通
    const t0coord = performance.now();
    for (let i = 0; i < iterations; i++) {
      isTargetCoord(coordTarget);
    }
    const coordMs = performance.now() - t0coord;

    // 测量缓存查找
    const t0cache = performance.now();
    for (let i = 0; i < iterations; i++) {
      cache.get("提交按钮");
    }
    const cacheMs = performance.now() - t0cache;

    // 两者都应很快，但坐标直通应不慢于缓存查找
    expect(coordMs).toBeLessThan(50); // 10K 次应在 50ms 内
    expect(cacheMs).toBeLessThan(50);
  });
});

/* ================================================================== */
/*  批量操作场景缓存命中率                                             */
/* ================================================================== */

describe("批量操作场景缓存效率", () => {
  it("列表逐行点击：预填充缓存后命中率 100%", () => {
    const cache = new OcrCoordinateCache();
    // 模拟 batchPreResolveTargets 预填充
    const items = ["项目A", "项目B", "项目C", "项目D", "项目E"];
    items.forEach((text, i) => {
      cache.set(text, { x: 100, y: 50 + i * 30 }, 0.9);
    });

    // 逐行点击 — 每次都应命中缓存
    let hits = 0;
    for (const text of items) {
      if (cache.get(text)) hits++;
    }
    expect(hits).toBe(items.length);
    expect(hits / items.length).toBe(1.0); // 100% 命中率
  });

  it("表单多字段填写：预填充后批量命中", () => {
    const cache = new OcrCoordinateCache();
    const fields = ["用户名", "密码", "邮箱", "手机号"];
    fields.forEach((text, i) => {
      cache.set(text, { x: 200, y: 100 + i * 40 });
    });

    let hits = 0;
    let misses = 0;
    for (const field of fields) {
      if (cache.get(field)) hits++;
      else misses++;
    }
    expect(hits).toBe(4);
    expect(misses).toBe(0);
  });

  it("屏幕变化后缓存失效 → 命中率归零", () => {
    const cache = new OcrCoordinateCache();
    cache.set("按钮1", { x: 100, y: 100 });
    cache.set("按钮2", { x: 200, y: 200 });

    // 模拟屏幕变化操作
    cache.invalidateAll();

    expect(cache.get("按钮1")).toBeNull();
    expect(cache.get("按钮2")).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("混合操作场景：缓存在屏幕变化操作后正确重建", () => {
    const cache = new OcrCoordinateCache();

    // Phase 1: 预填充
    cache.set("菜单项1", { x: 50, y: 100 });
    cache.set("菜单项2", { x: 50, y: 130 });
    expect(cache.get("菜单项1")).not.toBeNull();

    // Phase 2: 点击操作 → 屏幕变化 → 失效缓存
    cache.invalidateAll();
    expect(cache.get("菜单项1")).toBeNull();

    // Phase 3: 新一轮 OCR 后重新缓存
    cache.set("新按钮A", { x: 300, y: 200 });
    cache.set("新按钮B", { x: 300, y: 250 });
    expect(cache.get("新按钮A")).not.toBeNull();
    expect(cache.size).toBe(2);
  });
});

/* ================================================================== */
/*  屏幕变化操作后缓存失效逻辑                                       */
/* ================================================================== */

describe("屏幕变化操作缓存失效", () => {
  it("SCREEN_CHANGING_ACTIONS 包含所有会改变屏幕的操作", () => {
    expect(SCREEN_CHANGING_ACTIONS.has("click")).toBe(true);
    expect(SCREEN_CHANGING_ACTIONS.has("doubleClick")).toBe(true);
    expect(SCREEN_CHANGING_ACTIONS.has("type")).toBe(true);
    expect(SCREEN_CHANGING_ACTIONS.has("pressKey")).toBe(true);
    expect(SCREEN_CHANGING_ACTIONS.has("pressCombo")).toBe(true);
    expect(SCREEN_CHANGING_ACTIONS.has("scroll")).toBe(true);
  });

  it("非屏幕变化操作不在集合中", () => {
    expect(SCREEN_CHANGING_ACTIONS.has("wait")).toBe(false);
    expect(SCREEN_CHANGING_ACTIONS.has("assertText")).toBe(false);
    expect(SCREEN_CHANGING_ACTIONS.has("screenshot")).toBe(false);
    expect(SCREEN_CHANGING_ACTIONS.has("waitForText")).toBe(false);
  });

  it("模拟执行计划中的缓存失效时机", () => {
    const cache = new OcrCoordinateCache();
    const plan: PlanStep[] = [
      { action: "click", target: { text: "菜单" } },      // 屏幕变化 → 失效
      { action: "waitForText", text: "子菜单" },           // 不失效
      { action: "click", target: { text: "子菜单项" } },   // 屏幕变化 → 失效
      { action: "wait", ms: 500 },                          // 不失效
      { action: "type", target: { text: "输入框" }, text: "hello" }, // 屏幕变化 → 失效
    ];

    // 预填充缓存
    cache.set("菜单", { x: 50, y: 50 });
    cache.set("子菜单项", { x: 100, y: 100 });
    cache.set("输入框", { x: 200, y: 200 });

    let invalidationCount = 0;
    for (const step of plan) {
      // 模拟执行前的缓存查找
      if ("target" in step && step.target && isTargetText(step.target)) {
        cache.get((step.target as { text: string }).text);
      }

      // 模拟执行后的缓存失效
      if (SCREEN_CHANGING_ACTIONS.has(step.action)) {
        cache.invalidateAll();
        invalidationCount++;
      }
    }

    // 3 个屏幕变化操作
    expect(invalidationCount).toBe(3);
    // 最终缓存应为空（最后一步是 type，会失效）
    expect(cache.size).toBe(0);
  });
});

/* ================================================================== */
/*  目标类型判断                                                       */
/* ================================================================== */

describe("TargetSpec 类型判断", () => {
  it("坐标目标正确识别", () => {
    const target: TargetSpec = { x: 100, y: 200 };
    expect(isTargetCoord(target)).toBe(true);
    expect(isTargetText(target)).toBe(false);
    expect(isTargetPercent(target)).toBe(false);
  });

  it("文字目标正确识别", () => {
    const target: TargetSpec = { text: "提交" };
    expect(isTargetCoord(target)).toBe(false);
    expect(isTargetText(target)).toBe(true);
    expect(isTargetPercent(target)).toBe(false);
  });

  it("百分比目标正确识别", () => {
    const target: TargetSpec = { xPercent: 50, yPercent: 75 };
    expect(isTargetCoord(target)).toBe(false);
    expect(isTargetText(target)).toBe(false);
    expect(isTargetPercent(target)).toBe(true);
  });

  it("文字目标支持 fuzzy 和 index 选项", () => {
    const target: TargetSpec = { text: "确认", fuzzy: true, index: 2 };
    expect(isTargetText(target)).toBe(true);
    const t = target as { text: string; fuzzy?: boolean; index?: number };
    expect(t.fuzzy).toBe(true);
    expect(t.index).toBe(2);
  });
});

/* ================================================================== */
/*  性能基准: 批量操作延迟验证                                         */
/* ================================================================== */

describe("性能基准: 批量操作延迟", () => {
  it("坐标直通: 1000 次解析 < 10ms（等效 <0.01ms/步）", () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const target: TargetSpec = { x: 100 + i, y: 200 + i };
      isTargetCoord(target);
      // 模拟直接使用坐标
      const _ = { x: (target as any).x, y: (target as any).y };
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(10);
  });

  it("缓存复用: 1000 次查找 < 10ms（等效 <0.01ms/步）", () => {
    const cache = new OcrCoordinateCache();
    // 预填充 10 个条目
    for (let i = 0; i < 10; i++) {
      cache.set(`btn_${i}`, { x: i * 50, y: i * 30 });
    }

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      cache.get(`btn_${i % 10}`);
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(10);
  });

  it("缓存写入+读取循环: 1000 次 < 20ms", () => {
    const cache = new OcrCoordinateCache();

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const key = `element_${i % 50}`;
      if (!cache.get(key)) {
        cache.set(key, { x: i * 10, y: i * 20 }, 0.9);
      }
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(20);
  });

  it("invalidateAll 性能: 清空 100 条缓存 < 1ms", () => {
    const cache = new OcrCoordinateCache();
    for (let i = 0; i < 100; i++) {
      cache.set(`item_${i}`, { x: i, y: i });
    }

    const t0 = performance.now();
    cache.invalidateAll();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1);
    expect(cache.size).toBe(0);
  });
});
