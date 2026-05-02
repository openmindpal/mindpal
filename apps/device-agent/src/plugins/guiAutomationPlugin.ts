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
import type { CapabilityDescriptor } from "@mindpal/device-agent-sdk";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "@mindpal/device-agent-sdk";
import { apiPostJson } from "@mindpal/device-agent-sdk";
import { type PlanStep, type TargetSpec, isTargetText } from "./guiTypes";
import {
  captureScreen,
  cleanupCapture,
  ocrScreen,
  findTextInOcrResults,
  type OcrMatch,
  type ScreenCapture,
} from "./localVision";
import { executeNativeGuiAction, SCREEN_CHANGING_ACTIONS } from "@mindpal/device-agent-sdk";
import {
  resolveTarget,
  resolveTargetWithCache,
  hasError,
  hasErrorV2,
  batchPreResolveTargets,
  type OcrCacheState,
} from "./guiTargetResolver";
import { captureAndUploadEvidence, screenshotAndUpload } from "./guiEvidenceCollector";

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

import { resolveDeviceAgentEnv } from "../deviceAgentEnv";
import { getOcrCacheService, type OcrCacheService } from "@mindpal/device-agent-sdk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── GUI 步骤间延迟（毫秒），给 UI 渲染留出时间 ───────────────────
const INTER_STEP_DELAY_MS = resolveDeviceAgentEnv().guiStepDelayMs;

// ── 核心：本地视觉闭环执行引擎 ──────────────────────────────────

async function executeStep(
  step: PlanStep,
  ocrCache: OcrCacheState,
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

async function execRunPlan(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const plan: PlanStep[] = Array.isArray(ctx.input.plan) ? ctx.input.plan : [];
  if (!plan.length) return { status: "failed", errorCategory: "input_invalid", outputDigest: { reason: "空的动作计划" } };

  const stopOnError = ctx.input.stopOnError !== false;
  const screenshotOnError = ctx.input.screenshotOnError !== false;
  const enableCoordCache = ctx.input.enableCoordCache !== false;
  const enableBatchOcr = ctx.input.enableBatchOcr !== false;
  const maxSteps = Math.min(plan.length, 100);

  const stepResults: StepResult[] = [];
  const ocrCache: OcrCacheState = { capture: null, results: null };
  const coordCache = getOcrCacheService();

  let allOk = true;
  let cacheHits = 0;
  let cacheMisses = 0;

  if (enableBatchOcr) {
    await batchPreResolveTargets(plan, maxSteps, ocrCache, coordCache);
  }

  try {
    for (let i = 0; i < maxSteps; i++) {
      const t0 = Date.now();
      const currentStep = plan[i];

      const result = enableCoordCache
        ? await executeStepWithCache(currentStep, ocrCache, coordCache)
        : await executeStep(currentStep, ocrCache);
      const durationMs = Date.now() - t0;

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
          if (screenshotOnError) {
            await captureAndUploadEvidence(
              { apiBase: ctx.cfg.apiBase, deviceToken: ctx.cfg.deviceToken, deviceExecutionId: ctx.execution.deviceExecutionId },
              `gui_error_step_${i}`,
            );
          }
          break;
        }
      }

      if (enableCoordCache && SCREEN_CHANGING_ACTIONS.has(currentStep.action)) {
        coordCache.invalidateAll();
      }

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
 */
async function executeStepWithCache(
  step: PlanStep,
  ocrCache: OcrCacheState,
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
      return executeStep(step, ocrCache);
  }
}

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

async function execReadScreen(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const capture = await captureScreen();
  try {
    const results = await ocrScreen(capture);
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
        items: texts.slice(0, 500),
      },
    };
  } finally {
    await cleanupCapture(capture);
  }
}

async function execScreenshot(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const result = await screenshotAndUpload({
    apiBase: ctx.cfg.apiBase,
    deviceToken: ctx.cfg.deviceToken,
    deviceExecutionId: ctx.execution.deviceExecutionId,
  });
  if (result.status !== 200) return { status: "failed", errorCategory: "upstream_error", outputDigest: { status: result.status } };
  return { status: "succeeded", outputDigest: { ok: true, artifactId: result.artifactId ?? null }, evidenceRefs: result.evidenceRef ? [result.evidenceRef] : [] };
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
