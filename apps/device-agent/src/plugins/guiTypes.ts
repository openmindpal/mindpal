/**
 * GUI 自动化共享类型定义
 *
 * 被 guiAutomationPlugin（批量计划链路）和 streamingExecutor（流式推送链路）共同引用。
 * 任何 GUI 步骤 / 目标定位 / 类型守卫的规范定义均在此维护。
 *
 * @layer plugins
 */

// ── 目标定位 ──────────────────────────────────────────────────────

/** 目标定位方式：文字 / 绝对坐标 / 相对坐标 */
export type TargetSpec =
  | { text: string; index?: number; fuzzy?: boolean }
  | { x: number; y: number }
  | { xPercent: number; yPercent: number };

// ── 感知策略（云端下发） ─────────────────────────────────────────

/** 云端下发的感知方式选择策略 */
export type PerceptionStrategy = 'playwright' | 'ocr' | 'auto';

// ── 动作步骤 ──────────────────────────────────────────────────────

/** 通用 GUI 动作步骤（guiAutomationPlugin.PlanStep 和 streamingExecutor.StreamingStep 的统一定义） */
export type GuiActionStep =
  | { action: "click";        target: TargetSpec; button?: "left" | "right"; perceptionStrategy?: PerceptionStrategy }
  | { action: "doubleClick";  target: TargetSpec; perceptionStrategy?: PerceptionStrategy }
  | { action: "type";         target?: TargetSpec; text: string; perceptionStrategy?: PerceptionStrategy }
  | { action: "pressKey";     key: string; perceptionStrategy?: PerceptionStrategy }
  | { action: "pressCombo";   keys: string[]; perceptionStrategy?: PerceptionStrategy }
  | { action: "scroll";       direction: "up" | "down"; clicks?: number; perceptionStrategy?: PerceptionStrategy }
  | { action: "moveTo";       target: TargetSpec; perceptionStrategy?: PerceptionStrategy }
  | { action: "wait";         ms: number; perceptionStrategy?: PerceptionStrategy }
  | { action: "waitForText";  text: string; timeoutMs?: number; perceptionStrategy?: PerceptionStrategy }
  | { action: "assertText";   text: string; present?: boolean; perceptionStrategy?: PerceptionStrategy }
  | { action: "screenshot";   perceptionStrategy?: PerceptionStrategy };

/** 语义别名：在 GUI 自动化和流式执行场景下的语境类型 */
export type PlanStep = GuiActionStep;
export type StreamingStep = GuiActionStep;
export type StreamingTargetSpec = TargetSpec;

// ── 类型守卫 ──────────────────────────────────────────────────────

export function isTargetCoord(t: TargetSpec): t is { x: number; y: number } {
  return "x" in t && "y" in t;
}

export function isTargetPercent(t: TargetSpec): t is { xPercent: number; yPercent: number } {
  return "xPercent" in t && "yPercent" in t;
}

export function isTargetText(t: TargetSpec): t is { text: string; index?: number; fuzzy?: boolean } {
  return "text" in t;
}
