/**
 * GUI 自动化插件 — 本地视觉闭环（Local Vision Loop）
 *
 * ============================================================
 * 三链路架构定位：
 *
 *   1️⃣  原子操作链路（desktopPlugin 子插件）
 *       └─ 单次 tool call → 单个操作（click / type / screenshot）
 *       └─ 云端每步下发，适合简单场景
 *
 *   2️⃣  批量计划链路（本文件 guiAutomationPlugin）  ◀◀ YOU ARE HERE
 *       └─ 云端一次性下发完整动作计划 (PlanStep[])
 *       └─ 本地闭环：截图 → OCR定位 → 执行 → 验证 → 下一步
 *       └─ 全部完成后一次性上报结果
 *       └─ 延迟 = 2×RTT + N×本地耗时（~200ms/步）
 *
 *   3️⃣  流式推送链路（streamingExecutor.ts）
 *       └─ WS 持续推送 step，实时入队执行
 *       └─ 支持暂停/恢复/取消、背压控制
 *       └─ 毫秒级闭环：~10-50ms（缓存命中）/ ~200ms（需 OCR）
 *
 * 调用边界：
 *   - 本插件仅通过 device.gui.* 工具前缀被 taskExecutor 调用
 *   - 与 streamingExecutor 共享 localVision 底层原语，但不直接互调
 *   - 共享类型定义见 guiTypes.ts（PlanStep / TargetSpec 等）
 * ============================================================
 *
 * 工具前缀：device.gui
 */
import type { CapabilityDescriptor } from "../kernel";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "../pluginRegistry";
import { apiPostJson } from "../api";
import { type PlanStep, type TargetSpec, isTargetCoord, isTargetPercent, isTargetText } from "./guiTypes";
import {
  captureScreen,
  cleanupCapture,
  ocrScreen,
  findTextInOcrResults,
  type OcrMatch,
  type ScreenCapture,
} from "./localVision";
import { executeNativeGuiAction, SCREEN_CHANGING_ACTIONS } from "../kernel/guiActionKernel";

// ── 类型重导出（从 guiTypes.ts 统一导入） ─────────────────────────────

export type { PlanStep, TargetSpec } from "./guiTypes";

/** 执行计划时每步的结果 */
type StepResult = {
  step: number;
  action: string;
  status: "ok" | "failed";
  detail?: any;
  durationMs: number;
};

// ── 辅助函数（从 guiTypes.ts 导入） ──────────────────────────────────

/**
 * 解析目标为绝对屏幕坐标。
 * - 绝对坐标 → 直接返回
 * - 百分比坐标 → 按屏幕尺寸换算
 * - 文字 → 本地 OCR 截图后定位（核心闭环）
 */
async function resolveTarget(
  target: TargetSpec,
  ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null },
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

function hasError(r: { x: number; y: number } | { error: string }): r is { error: string } {
  return "error" in r;
}

import { resolveDeviceAgentEnv } from "../deviceAgentEnv";
import { getOcrCacheService, type OcrCacheService } from "../kernel/ocrCacheService";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── GUI 步骤间延迟（毫秒），给 UI 渲染留出时间 ───────────────────
const INTER_STEP_DELAY_MS = resolveDeviceAgentEnv().guiStepDelayMs;

// OCR 坐标缓存已统一到内核 ocrCacheService
// SCREEN_CHANGING_ACTIONS 已统一到 guiActionKernel

/**
 * 增强的目标解析（缓存优先）
 * 解析顺序：绝对坐标 → 坐标缓存 → 截图+OCR
 */
async function resolveTargetWithCache(
  target: TargetSpec,
  ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null },
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

function hasErrorV2(r: { x: number; y: number; fromCache: boolean; source?: string } | { error: string }): r is { error: string } {
  return "error" in r;
}

// ── 核心：本地视觉闭环执行引擎 ──────────────────────────────────

async function executeStep(
  step: PlanStep,
  ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null },
): Promise<{ status: "ok" | "failed"; detail?: any }> {
  switch (step.action) {
    case "click":
    case "doubleClick":
    case "moveTo": {
      const pos = await resolveTarget(step.target, ocrCache);
      if (hasError(pos)) return { status: "failed", detail: pos.error };
      await executeNativeGuiAction(step.action, { x: pos.x, y: pos.y }, {
        button: step.action === "click" ? (step.button ?? "left") : undefined,
      });
      // 屏幕变化操作后清除 OCR 缓存
      if (step.action !== "moveTo" && ocrCache.capture) {
        await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null;
      }
      return { status: "ok", detail: { x: pos.x, y: pos.y } };
    }

    case "type": {
      let target: { x: number; y: number } | undefined;
      if (step.target) {
        const pos = await resolveTarget(step.target, ocrCache);
        if (hasError(pos)) return { status: "failed", detail: pos.error };
        target = pos;
      }
      await executeNativeGuiAction("type", target, {
        text: step.text,
        typeClickDelayMs: 100,
      });
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      return { status: "ok", detail: { textLen: step.text.length } };
    }

    case "pressKey":
    case "pressCombo":
    case "scroll": {
      await executeNativeGuiAction(step.action, undefined, {
        key: step.action === "pressKey" ? step.key : undefined,
        keys: step.action === "pressCombo" ? step.keys : undefined,
        direction: step.action === "scroll" ? step.direction : undefined,
        clicks: step.action === "scroll" ? (step.clicks ?? 3) : undefined,
      });
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      return step.action === "scroll"
        ? { status: "ok" }
        : { status: "ok", detail: step.action === "pressKey" ? { key: step.key } : { keys: step.keys } };
    }

    case "wait": {
      await sleep(step.ms);
      return { status: "ok" };
    }

    case "waitForText": {
      const timeout = step.timeoutMs ?? 10_000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
        ocrCache.capture = await captureScreen();
        ocrCache.results = await ocrScreen(ocrCache.capture);
        const found = findTextInOcrResults(ocrCache.results, step.text, { fuzzy: true });
        if (found) return { status: "ok", detail: { text: step.text, foundAt: { x: found.x, y: found.y } } };
        await sleep(500);
      }
      return { status: "failed", detail: `等待文字 "${step.text}" 超时 (${timeout}ms)` };
    }

    case "assertText": {
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      ocrCache.capture = await captureScreen();
      ocrCache.results = await ocrScreen(ocrCache.capture);
      const found = findTextInOcrResults(ocrCache.results, step.text, { fuzzy: true });
      const present = step.present !== false;
      if (present && !found) return { status: "failed", detail: `断言失败: 未找到 "${step.text}"` };
      if (!present && found) return { status: "failed", detail: `断言失败: 不应出现 "${step.text}"` };
      return { status: "ok" };
    }

    case "screenshot": {
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      ocrCache.capture = await captureScreen();
      ocrCache.results = null;
      return { status: "ok", detail: { filePath: ocrCache.capture.filePath } };
    }

    default:
      return { status: "failed", detail: `未知动作: ${(step as any).action}` };
  }
}

// ── 工具处理函数 ─────────────────────────────────────────────────

/**
 * device.gui.runPlan — 批量执行 GUI 动作计划（核心工具）
 *
 * 云端一次性下发完整计划，本地闭环执行，大幅降低延迟。
 * input.plan: PlanStep[]
 * input.stopOnError: boolean（默认 true）
 * input.screenshotOnError: boolean（默认 true，失败时截图上传作为证据）
 */
async function execRunPlan(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const plan: PlanStep[] = Array.isArray(ctx.input.plan) ? ctx.input.plan : [];
  if (!plan.length) return { status: "failed", errorCategory: "input_invalid", outputDigest: { reason: "空的动作计划" } };

  const stopOnError = ctx.input.stopOnError !== false;
  const screenshotOnError = ctx.input.screenshotOnError !== false;
  /** 启用坐标缓存快速通道（默认开启） */
  const enableCoordCache = ctx.input.enableCoordCache !== false;
  /** 启用批量 OCR 优化（默认开启） */
  const enableBatchOcr = ctx.input.enableBatchOcr !== false;
  const maxSteps = Math.min(plan.length, 100); // 安全上限

  const stepResults: StepResult[] = [];
  const ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null } = { capture: null, results: null };
  const coordCache = getOcrCacheService();

  let allOk = true;
  let cacheHits = 0;
  let cacheMisses = 0;

  // 批量 OCR 预解析—连续文字目标步骤一次性 OCR
  if (enableBatchOcr) {
    await batchPreResolveTargets(plan, maxSteps, ocrCache, coordCache);
  }

  try {
    for (let i = 0; i < maxSteps; i++) {
      const t0 = Date.now();
      const currentStep = plan[i];

      // 使用缓存解析引擎
      const result = enableCoordCache
        ? await executeStepWithCache(currentStep, ocrCache, coordCache)
        : await executeStep(currentStep, ocrCache);
      const durationMs = Date.now() - t0;

      // 跟踪缓存命中率
      if (result.detail?.fromCache) cacheHits++;
      else if ("target" in currentStep && isTargetText((currentStep as any).target)) cacheMisses++;

      stepResults.push({
        step: i,
        action: currentStep.action,
        status: result.status,
        detail: result.detail,
        durationMs,
      });

      if (result.status === "failed") {
        allOk = false;
        if (stopOnError) {
          // 失败时截图上传证据
          if (screenshotOnError) {
            try {
              const errCapture = await captureScreen();
              const buf = await import("node:fs/promises").then((f) => f.readFile(errCapture.filePath));
              const base64 = buf.toString("base64");
              await apiPostJson({
                apiBase: ctx.cfg.apiBase,
                path: "/device-agent/evidence/upload",
                token: ctx.cfg.deviceToken,
                body: {
                  deviceExecutionId: ctx.execution.deviceExecutionId,
                  contentBase64: base64,
                  contentType: "image/png",
                  format: "png",
                  label: `gui_error_step_${i}`,
                },
              });
              await cleanupCapture(errCapture);
            } catch { /* 证据上传失败不影响主流程 */ }
          }
          break;
        }
      }

      // 屏幕变化操作后失效缓存
      if (enableCoordCache && SCREEN_CHANGING_ACTIONS.has(currentStep.action)) {
        coordCache.invalidateAll();
      }

      // 步骤间延迟，给 UI 渲染留出时间
      if (i < maxSteps - 1 && currentStep.action !== "wait") {
        await sleep(INTER_STEP_DELAY_MS);
      }
    }
  } finally {
    if (ocrCache.capture) await cleanupCapture(ocrCache.capture);
  }

  const completedSteps = stepResults.length;
  const failedSteps = stepResults.filter((s) => s.status === "failed").length;
  const totalDurationMs = stepResults.reduce((s, r) => s + r.durationMs, 0);

  return {
    status: allOk ? "succeeded" : "failed",
    errorCategory: allOk ? undefined : "gui_step_failed",
    outputDigest: {
      totalSteps: plan.length,
      completedSteps,
      failedSteps,
      totalDurationMs,
      steps: stepResults,
      // 缓存效率统计
      fastPath: {
        cacheHits,
        cacheMisses,
        cacheHitRate: (cacheHits + cacheMisses) > 0 ? cacheHits / (cacheHits + cacheMisses) : 0,
        batchOcrEnabled: enableBatchOcr,
      },
    },
  };
}

/**
 * 带缓存的步骤执行引擎
 * 对文字目标优先查缓存，命中时跳过截图+OCR
 */
async function executeStepWithCache(
  step: PlanStep,
  ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null },
  coordCache: OcrCacheService,
): Promise<{ status: "ok" | "failed"; detail?: any }> {
  switch (step.action) {
    case "click":
    case "doubleClick":
    case "moveTo": {
      const pos = await resolveTargetWithCache(step.target, ocrCache, coordCache);
      if (hasErrorV2(pos)) return { status: "failed", detail: pos.error };
      await executeNativeGuiAction(step.action, { x: pos.x, y: pos.y }, {
        button: step.action === "click" ? (step.button ?? "left") : undefined,
      });
      if (step.action !== "moveTo" && ocrCache.capture) {
        await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null;
      }
      return { status: "ok", detail: { x: pos.x, y: pos.y, fromCache: pos.fromCache } };
    }
    case "type": {
      let target: { x: number; y: number; fromCache: boolean } | undefined;
      if (step.target) {
        const pos = await resolveTargetWithCache(step.target, ocrCache, coordCache);
        if (hasErrorV2(pos)) return { status: "failed", detail: pos.error };
        target = pos;
      }
      await executeNativeGuiAction("type", target, {
        text: step.text,
        typeClickDelayMs: 100,
      });
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      return { status: "ok", detail: { textLen: step.text.length } };
    }
    default:
      // 非目标类动作回退到原始引擎
      return executeStep(step, ocrCache);
  }
}

/**
 * 批量预解析—扫描连续的文字目标步骤，一次 OCR 解析所有目标
 * 场景：列表逐行点击、表单多字段填写等
 */
async function batchPreResolveTargets(
  plan: PlanStep[],
  maxSteps: number,
  ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null },
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

/**
 * device.gui.findAndClick — 截图 + 本地 OCR 找到文字 + 点击
 * 单步快捷操作，等价于 runPlan([{ action: "click", target: { text } }])
 */
async function execFindAndClick(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const text = String(ctx.input.text ?? "");
  if (!text) return { status: "failed", errorCategory: "input_invalid", outputDigest: { reason: "缺少 text 参数" } };

  const capture = await captureScreen();
  try {
    const results = await ocrScreen(capture);
    const match = findTextInOcrResults(results, text, { fuzzy: true });
    if (!match) return { status: "failed", errorCategory: "element_not_found", outputDigest: { text, ocrCount: results.length } };
    await executeNativeGuiAction("click", { x: match.x, y: match.y }, { button: ctx.input.button ?? "left" });
    return { status: "succeeded", outputDigest: { text, x: match.x, y: match.y, confidence: match.confidence } };
  } finally {
    await cleanupCapture(capture);
  }
}

/**
 * device.gui.findAndType — 找到目标元素 + 点击 + 输入文字
 */
async function execFindAndType(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const target = String(ctx.input.target ?? "");
  const text = String(ctx.input.text ?? "");
  if (!text) return { status: "failed", errorCategory: "input_invalid", outputDigest: { reason: "缺少 text 参数" } };

  const capture = await captureScreen();
  try {
    if (target) {
      const results = await ocrScreen(capture);
      const match = findTextInOcrResults(results, target, { fuzzy: true });
      if (!match) return { status: "failed", errorCategory: "element_not_found", outputDigest: { target, ocrCount: results.length } };
      await executeNativeGuiAction("click", { x: match.x, y: match.y });
      await sleep(100);
    }
    await executeNativeGuiAction("type", undefined, { text });
    return { status: "succeeded", outputDigest: { target, textLen: text.length } };
  } finally {
    await cleanupCapture(capture);
  }
}

/**
 * device.gui.readScreen — 截图 + 本地 OCR 返回屏幕所有文字
 * 用于云端大模型"看一眼"当前屏幕内容，但 OCR 在本地完成、只回传文字摘要
 */
async function execReadScreen(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const capture = await captureScreen();
  try {
    const results = await ocrScreen(capture);
    // 只返回文字和位置，不传图片，带宽极低
    const texts = results.map((r) => ({
      text: r.text,
      x: r.bbox.x,
      y: r.bbox.y,
      w: r.bbox.w,
      h: r.bbox.h,
    }));
    return {
      status: "succeeded",
      outputDigest: {
        screenWidth: capture.width,
        screenHeight: capture.height,
        ocrItemCount: texts.length,
        items: texts.slice(0, 500), // 最多 500 个元素
      },
    };
  } finally {
    await cleanupCapture(capture);
  }
}

/**
 * device.gui.screenshot — 截图并上传（保留，用于云端需要看原图的场景）
 */
async function execScreenshot(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const capture = await captureScreen();
  try {
    const buf = await import("node:fs/promises").then((f) => f.readFile(capture.filePath));
    const base64 = buf.toString("base64");
    const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
      apiBase: ctx.cfg.apiBase,
      path: "/device-agent/evidence/upload",
      token: ctx.cfg.deviceToken,
      body: { deviceExecutionId: ctx.execution.deviceExecutionId, contentBase64: base64, contentType: "image/png", format: "png" },
    });
    if (up.status !== 200) return { status: "failed", errorCategory: "upstream_error", outputDigest: { status: up.status } };
    return { status: "succeeded", outputDigest: { ok: true, artifactId: up.json?.artifactId ?? null }, evidenceRefs: up.json?.evidenceRef ? [up.json.evidenceRef] : [] };
  } finally {
    await cleanupCapture(capture);
  }
}

// ── 工具路由表 ───────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.gui.runPlan":      execRunPlan,
  "device.gui.findAndClick": execFindAndClick,
  "device.gui.findAndType":  execFindAndType,
  "device.gui.readScreen":   execReadScreen,
  "device.gui.screenshot":   execScreenshot,
};

const guiSuccessSchema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
  },
  additionalProperties: true,
};

const GUI_CAPABILITIES: CapabilityDescriptor[] = [
  {
    toolRef: "device.gui.runPlan",
    riskLevel: "high",
    inputSchema: { type: "object", properties: { plan: { type: "array", items: { type: "object" } } }, required: ["plan"], additionalProperties: true },
    outputSchema: guiSuccessSchema,
    resourceRequirements: { memoryMb: 256, cpuPercent: 70 },
    concurrencyLimit: 1,
    version: "1.0.0",
    tags: ["gui", "plan"],
    description: "执行本地 GUI 动作计划",
  },
  {
    toolRef: "device.gui.findAndClick",
    riskLevel: "high",
    inputSchema: { type: "object", properties: { text: { type: "string" }, selector: { type: "string" } }, additionalProperties: true },
    outputSchema: guiSuccessSchema,
    resourceRequirements: { memoryMb: 192, cpuPercent: 70 },
    concurrencyLimit: 1,
    version: "1.0.0",
    tags: ["gui", "vision"],
    description: "定位并点击 GUI 元素",
  },
  {
    toolRef: "device.gui.findAndType",
    riskLevel: "high",
    inputSchema: { type: "object", properties: { text: { type: "string" }, value: { type: "string" } }, required: ["value"], additionalProperties: true },
    outputSchema: guiSuccessSchema,
    resourceRequirements: { memoryMb: 192, cpuPercent: 70 },
    concurrencyLimit: 1,
    version: "1.0.0",
    tags: ["gui", "vision"],
    description: "定位并输入 GUI 文本",
  },
  {
    toolRef: "device.gui.readScreen",
    riskLevel: "medium",
    inputSchema: { type: "object", properties: { region: { type: "object" } }, additionalProperties: true },
    outputSchema: { type: "object", properties: { texts: { type: "array", items: { type: "string" } } }, additionalProperties: true },
    resourceRequirements: { memoryMb: 128, cpuPercent: 50 },
    concurrencyLimit: 2,
    version: "1.0.0",
    tags: ["gui", "vision"],
    description: "读取当前屏幕文本内容",
  },
  {
    toolRef: "device.gui.screenshot",
    riskLevel: "medium",
    inputSchema: { type: "object", properties: { annotate: { type: "boolean" } }, additionalProperties: true },
    outputSchema: { type: "object", properties: { artifactId: { type: "string" } }, additionalProperties: true },
    resourceRequirements: { memoryMb: 160, cpuPercent: 40 },
    concurrencyLimit: 2,
    version: "1.0.0",
    tags: ["gui", "evidence"],
    description: "采集 GUI 截图证据",
  },
];

// ── 导出插件 ────────────────────────────────────────────────────

const guiAutomationPlugin: DeviceToolPlugin = {
  name: "gui-automation",
  version: "1.0.0",
  toolPrefixes: ["device.gui"],
  capabilities: GUI_CAPABILITIES,
  resourceLimits: {
    maxMemoryMb: 384,
    maxCpuPercent: 85,
    maxConcurrency: 1,
    maxExecutionTimeMs: 180000,
  },
  toolNames: Object.keys(TOOL_HANDLERS),

  async execute(ctx) {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) {
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "gui-automation" } };
    }
    return handler(ctx);
  },
};

export default guiAutomationPlugin;
