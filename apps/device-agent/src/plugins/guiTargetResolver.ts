/**
 * GUI Target Resolver — 目标定位与 OCR 缓存管理
 *
 * 从 guiAutomationPlugin.ts 拆出，提供目标解析、缓存优先解析、批量预解析。
 */

import { type PlanStep, type TargetSpec, isTargetCoord, isTargetPercent, isTargetText } from "./guiTypes";
import {
  captureScreen,
  cleanupCapture,
  ocrScreen,
  findTextInOcrResults,
  type OcrMatch,
  type ScreenCapture,
} from "./localVision";
import { getOcrCacheService, type OcrCacheService } from "@mindpal/device-agent-sdk";
import { SCREEN_CHANGING_ACTIONS } from "@mindpal/device-agent-sdk";

// ── 类型重导出 ──────────────────────────────────────────────

export type { PlanStep, TargetSpec };

/** OCR 缓存结构（在步骤执行期间共享） */
export type OcrCacheState = { capture: ScreenCapture | null; results: OcrMatch[] | null };

// ── 基础目标解析 ────────────────────────────────────────────

/**
 * 解析目标为绝对屏幕坐标。
 * - 绝对坐标 → 直接返回
 * - 百分比坐标 → 按屏幕尺寸换算
 * - 文字 → 本地 OCR 截图后定位（核心闭环）
 */
export async function resolveTarget(
  target: TargetSpec,
  ocrCache: OcrCacheState,
): Promise<{ x: number; y: number } | { error: string }> {
  if (isTargetCoord(target)) return { x: target.x, y: target.y };

  // 需要截图 + OCR
  if (!ocrCache.capture) {
    ocrCache.capture = await captureScreen();
    ocrCache.results = await ocrScreen(ocrCache.capture);
  }

  if (isTargetPercent(target)) {
    return {
      x: Math.round((target.xPercent / 100) * ocrCache.capture.width),
      y: Math.round((target.yPercent / 100) * ocrCache.capture.height),
    };
  }

  if (isTargetText(target)) {
    const match = findTextInOcrResults(ocrCache.results!, target.text, { fuzzy: target.fuzzy });
    if (!match) return { error: `未找到文字: "${target.text}"` };
    return { x: match.x, y: match.y };
  }

  return { error: "无效的目标定位方式" };
}

export function hasError(r: { x: number; y: number } | { error: string }): r is { error: string } {
  return "error" in r;
}

// ── 增强的缓存优先解析 ─────────────────────────────────────

/**
 * 增强的目标解析（缓存优先）
 * 解析顺序：绝对坐标 → 坐标缓存 → 截图+OCR
 */
export async function resolveTargetWithCache(
  target: TargetSpec,
  ocrCache: OcrCacheState,
  coordCache: OcrCacheService,
): Promise<{ x: number; y: number; fromCache: boolean; source?: string } | { error: string }> {
  if (isTargetCoord(target)) return { x: target.x, y: target.y, fromCache: false, source: "coord" };

  if (isTargetText(target)) {
    // 1. 坐标缓存
    const cached = coordCache.get(target.text);
    if (cached) return { x: cached.x, y: cached.y, fromCache: true, source: "coord_cache" };
  }

  if (!ocrCache.capture) {
    ocrCache.capture = await captureScreen();
    ocrCache.results = await ocrScreen(ocrCache.capture);
  }

  if (isTargetPercent(target)) {
    return {
      x: Math.round((target.xPercent / 100) * ocrCache.capture.width),
      y: Math.round((target.yPercent / 100) * ocrCache.capture.height),
      fromCache: false,
      source: "percent",
    };
  }

  if (isTargetText(target)) {
    // 2. OCR 定位
    if (!ocrCache.results) {
      ocrCache.results = await ocrScreen(ocrCache.capture);
    }
    const match = findTextInOcrResults(ocrCache.results!, target.text, { fuzzy: target.fuzzy });
    if (!match) return { error: `未找到文字: "${target.text}"` };
    coordCache.set(target.text, { x: match.x, y: match.y }, match.confidence);
    return { x: match.x, y: match.y, fromCache: false, source: "ocr" };
  }

  return { error: "无效的目标定位方式" };
}

export function hasErrorV2(r: { x: number; y: number; fromCache: boolean; source?: string } | { error: string }): r is { error: string } {
  return "error" in r;
}

// ── 批量预解析 ──────────────────────────────────────────────

/**
 * 批量预解析—扫描连续的文字目标步骤，一次 OCR 解析所有目标
 * 场景：列表逐行点击、表单多字段填写等
 */
export async function batchPreResolveTargets(
  plan: PlanStep[],
  maxSteps: number,
  ocrCache: OcrCacheState,
  coordCache: OcrCacheService,
): Promise<void> {
  // 收集前 N 步中的文字目标（仅在第一个屏幕变化动作之前）
  const textTargets: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const step = plan[i];
    // 屏幕变化动作之后的目标无法预解析
    if (SCREEN_CHANGING_ACTIONS.has(step.action) && textTargets.length > 0) break;
    if ("target" in step && step.target && isTargetText(step.target as TargetSpec)) {
      textTargets.push((step.target as { text: string }).text);
    }
  }

  if (textTargets.length < 2) return; // 少于 2 个目标时不值得批量

  // 一次 OCR
  if (!ocrCache.capture) {
    ocrCache.capture = await captureScreen();
    ocrCache.results = await ocrScreen(ocrCache.capture);
  }

  // 批量解析并写入缓存
  for (const text of textTargets) {
    const match = findTextInOcrResults(ocrCache.results!, text, { fuzzy: true });
    if (match) {
      coordCache.set(text, { x: match.x, y: match.y }, match.confidence);
    }
  }
}
