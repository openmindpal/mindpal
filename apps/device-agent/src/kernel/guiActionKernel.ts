/**
 * GUI Action Kernel — 统一的 native GUI 操作内核
 *
 * 提取 streamingExecutor / guiAutomationPlugin 中重复的
 * click / doubleClick / type / pressKey / pressCombo / scroll / moveTo
 * 底层调用，消除三链路之间的冗余实现。
 *
 * 注意：本内核仅封装 native 操作（localVision 底层原语），
 * Playwright 操作保留在 perceptionRouter 中，不在此统一。
 * 目标解析（resolveTarget）和 OCR 缓存管理由各链路自行负责。
 */

import {
  clickMouse,
  doubleClick,
  typeText,
  pressKey,
  pressCombo,
  moveMouse,
  scroll,
} from "../plugins/localVision";

// ── 类型 ─────────────────────────────────────────────────────────

export interface GuiActionTarget {
  x: number;
  y: number;
}

export interface GuiActionResult {
  success: boolean;
  action: string;
  durationMs: number;
  detail?: Record<string, unknown>;
}

export interface GuiActionParams {
  /** click button: "left" | "right" */
  button?: string;
  /** type 的文本内容 */
  text?: string;
  /** pressKey 的键名 */
  key?: string;
  /** pressCombo 的组合键 */
  keys?: string[];
  /** scroll 方向 */
  direction?: string;
  /** scroll 滚动格数 */
  clicks?: number;
  /** type 操作：点击目标后的等待时间（ms），默认 50 */
  typeClickDelayMs?: number;
}

// ── 屏幕变化操作集合（统一定义，各链路共享） ─────────────────────

export const SCREEN_CHANGING_ACTIONS = new Set([
  "click", "doubleClick", "type", "pressKey", "pressCombo", "scroll",
]);

// ── sleep ────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 统一 native GUI 操作执行 ─────────────────────────────────────

/**
 * 执行单个 native GUI 操作。
 *
 * @param action  操作类型
 * @param target  屏幕坐标（click/doubleClick/moveTo/type 可选先点击时必传）
 * @param params  操作参数
 * @returns       执行结果（含耗时）
 */
export async function executeNativeGuiAction(
  action: string,
  target?: GuiActionTarget,
  params?: GuiActionParams,
): Promise<GuiActionResult> {
  const start = Date.now();
  const detail: Record<string, unknown> = {};

  switch (action) {
    case "click": {
      if (!target) throw new Error("click requires target coordinates");
      await clickMouse(target.x, target.y, (params?.button ?? "left") as "left" | "right");
      detail.x = target.x;
      detail.y = target.y;
      detail.button = params?.button ?? "left";
      break;
    }
    case "doubleClick": {
      if (!target) throw new Error("doubleClick requires target coordinates");
      await doubleClick(target.x, target.y);
      detail.x = target.x;
      detail.y = target.y;
      break;
    }
    case "type": {
      if (target) {
        await clickMouse(target.x, target.y);
        await sleep(params?.typeClickDelayMs ?? 50);
        detail.x = target.x;
        detail.y = target.y;
      }
      const text = params?.text ?? "";
      await typeText(text);
      detail.textLen = text.length;
      break;
    }
    case "pressKey": {
      const key = params?.key ?? "";
      await pressKey(key);
      detail.key = key;
      break;
    }
    case "pressCombo": {
      const keys = params?.keys ?? [];
      await pressCombo(keys);
      detail.keys = keys;
      break;
    }
    case "scroll": {
      const direction = (params?.direction ?? "down") as "up" | "down";
      const clicks = params?.clicks ?? 3;
      await scroll(direction, clicks);
      detail.direction = direction;
      detail.clicks = clicks;
      break;
    }
    case "moveTo": {
      if (!target) throw new Error("moveTo requires target coordinates");
      await moveMouse(target.x, target.y);
      detail.x = target.x;
      detail.y = target.y;
      break;
    }
    default:
      throw new Error(`unknown_gui_action: ${action}`);
  }

  return {
    success: true,
    action,
    durationMs: Date.now() - start,
    detail,
  };
}
