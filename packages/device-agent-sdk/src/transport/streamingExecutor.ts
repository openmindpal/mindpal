/**
 * Streaming Executor — 流式控制本地闭环执行器
 *
 * [SDK迁移] 从 apps/device-agent/src/streamingExecutor.ts 迁入
 *
 * 应用层依赖解耦：
 * - ./plugins/localVision → VisionProvider 注入接口 (setVisionProvider)
 * - ./plugins/guiTypes → 类型定义内联到本文件
 * - ./plugins/perceptionRouter → 已移除（原文件中导入但未使用）
 * - ./deviceAgentEnv → 配置参数通过 StreamingExecutorConfig 传入
 *
 * SDK 内部导入调整：
 * - @mindpal/device-agent-sdk → ../kernel/...
 */

import { executeNativeGuiAction, SCREEN_CHANGING_ACTIONS } from "../kernel/guiActionKernel";
import { logAuditEvent, uploadArtifact } from "../kernel/audit";
import { registerCapabilities } from "../kernel/capabilityRegistry";
import type { CapabilityDescriptor } from "../kernel/types";
import { getOcrCacheService } from "../kernel/ocrCacheService";

// ── 内联 GUI 类型定义（原 plugins/guiTypes.ts）────────────────────

/** 目标定位方式：文字 / 绝对坐标 / 相对坐标 */
export type TargetSpec =
  | { text: string; index?: number; fuzzy?: boolean }
  | { x: number; y: number }
  | { xPercent: number; yPercent: number };

/** 云端下发的感知方式选择策略 */
export type PerceptionStrategy = 'playwright' | 'ocr' | 'auto';

/** 通用 GUI 动作步骤 */
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

export type StreamingStep = GuiActionStep;
export type StreamingTargetSpec = TargetSpec;

export function isTargetCoord(t: TargetSpec): t is { x: number; y: number } {
  return "x" in t && "y" in t;
}

export function isTargetPercent(t: TargetSpec): t is { xPercent: number; yPercent: number } {
  return "xPercent" in t && "yPercent" in t;
}

export function isTargetText(t: TargetSpec): t is { text: string; index?: number; fuzzy?: boolean } {
  return "text" in t;
}

// ── VisionProvider 注入接口（解耦 plugins/localVision）────────────

/** 屏幕截图数据 */
export interface ScreenCapture {
  filePath: string;
  width: number;
  height: number;
}

/** OCR 匹配结果 */
export interface OcrMatch {
  x: number;
  y: number;
  text?: string;
  confidence?: number;
}

/** 视觉感知提供者接口 — 应用层需注入 */
export interface VisionProvider {
  captureScreen(): Promise<ScreenCapture>;
  cleanupCapture(capture: ScreenCapture): Promise<void>;
  ocrScreen(capture: ScreenCapture): Promise<OcrMatch[]>;
  findTextInOcrResults(results: OcrMatch[], text: string, options?: { fuzzy?: boolean }): OcrMatch | null;
}

let _visionProvider: VisionProvider | null = null;

/**
 * 注入视觉感知提供者（应用层在使用 streamingExecutor 前必须调用）
 */
export function setVisionProvider(provider: VisionProvider): void {
  _visionProvider = provider;
}

function getVisionProvider(): VisionProvider {
  if (!_visionProvider) {
    throw new Error('[StreamingExecutor] VisionProvider 未注入，请先调用 setVisionProvider()');
  }
  return _visionProvider;
}

// ── 类型（streaming 专属类型）────────────────────────────────────

/** 执行器状态 */
export type StreamingState = "idle" | "running" | "paused" | "stopped" | "error";

/** 单步结果 */
export interface StreamingStepResult {
  stepIndex: number;
  action: string;
  status: "ok" | "failed" | "skipped";
  detail?: unknown;
  durationMs: number;
}

/** 实时状态事件（通过回调推送给 WS 层） */
export type StreamingEvent =
  | { type: "state_change"; state: StreamingState; reason?: string }
  | { type: "step_start"; stepIndex: number; action: string; queueSize: number }
  | { type: "step_complete"; result: StreamingStepResult }
  | { type: "step_failed"; result: StreamingStepResult }
  | { type: "session_end"; totalSteps: number; succeeded: number; failed: number; totalDurationMs: number }
  | { type: "backpressure"; queueSize: number; paused: boolean };

/** 事件回调 */
export type StreamingEventHandler = (event: StreamingEvent) => void;

/** 执行器配置 */
export interface StreamingExecutorConfig {
  /** 步骤间最小延迟（ms），给 UI 渲染留时间，默认 50 */
  interStepDelayMs?: number;
  /** 单步最大超时（ms），默认 10000 */
  stepTimeoutMs?: number;
  /** OCR 坐标缓存 TTL（ms），默认 2000 */
  ocrCacheTtlMs?: number;
  /** 队列积压上限，超过后触发背压事件，默认 200 */
  maxQueueSize?: number;
  /** 遇到错误时是否停止整个流，默认 false（跳过失败步继续） */
  stopOnError?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── StreamingExecutor ─────────────────────────────────────────────

/**
 * 流式执行器 — 毫秒级 感知→执行→验证 闭环
 *
 * 用法：
 * ```ts
 * const executor = createStreamingExecutor({ interStepDelayMs: 30 });
 * executor.onEvent((e) => ws.send(JSON.stringify(e)));
 * executor.start();
 * executor.appendSteps([...]);    // 持续从 WS 推送
 * executor.appendSteps([...]);
 * await executor.waitUntilDone(); // 或 executor.stop()
 * ```
 */
export interface StreamingExecutor {
  /** 当前状态 */
  readonly state: StreamingState;
  /** 当前队列中待执行步骤数 */
  readonly queueSize: number;
  /** 已完成步骤计数 */
  readonly completedSteps: number;
  /** 失败步骤计数 */
  readonly failedSteps: number;
  /** 注册事件回调 */
  onEvent(handler: StreamingEventHandler): void;
  /** 启动执行循环 */
  start(): void;
  /** 追加步骤到队列 */
  appendSteps(steps: StreamingStep[]): void;
  /** 标记输入完成（队列排空后自动结束） */
  markInputDone(): void;
  /** 暂停执行（当前步完成后暂停） */
  pause(): void;
  /** 恢复执行 */
  resume(): void;
  /** 停止并清空队列 */
  stop(): void;
  /** 等待执行结束（正常/停止/错误） */
  waitUntilDone(): Promise<void>;
  /** 获取摘要统计 */
  getSummary(): {
    state: StreamingState;
    totalSteps: number;
    succeeded: number;
    failed: number;
    queueSize: number;
    totalDurationMs: number;
    cacheHits: number;
    cacheMisses: number;
  };
}

export function createStreamingExecutor(config?: StreamingExecutorConfig): StreamingExecutor {
  const interStepDelayMs = config?.interStepDelayMs ?? 200;
  const stepTimeoutMs = config?.stepTimeoutMs ?? 10_000;
  const _ocrCacheTtlMs = config?.ocrCacheTtlMs ?? 2000;
  const maxQueueSize = config?.maxQueueSize ?? 50;
  const stopOnError = config?.stopOnError ?? false;

  let state: StreamingState = "idle";
  const queue: StreamingStep[] = [];
  let stepCounter = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let inputDone = false;
  let startedAt = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  const handlers: StreamingEventHandler[] = [];
  const coordCache = getOcrCacheService();
  let ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null } = { capture: null, results: null };

  let doneResolve: (() => void) | null = null;
  let donePromise = new Promise<void>((r) => { doneResolve = r; });

  const sessionExecutionId = `streaming_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  function emit(event: StreamingEvent): void {
    for (const h of handlers) { try { h(event); } catch { /* handler error */ } }
  }

  function setState(next: StreamingState, reason?: string): void {
    if (state === next) return;
    state = next;
    emit({ type: "state_change", state: next, reason });
    if (next === "stopped" || next === "error") {
      finishSession();
    }
  }

  function finishSession(): void {
    cleanupOcr();
    const totalDurationMs = startedAt > 0 ? Date.now() - startedAt : 0;
    logAuditEvent({
      eventType: "tool.execute.success",
      toolRef: "device.gui.streaming.session",
      toolName: "streaming.session",
      executionId: sessionExecutionId,
      status: failedCount > 0 ? "failed" : "success",
      durationMs: totalDurationMs,
      extra: { totalSteps: stepCounter, succeeded: succeededCount, failed: failedCount },
    }).catch(() => {});
    emit({
      type: "session_end",
      totalSteps: stepCounter,
      succeeded: succeededCount,
      failed: failedCount,
      totalDurationMs,
    });
    doneResolve?.();
  }

  function cleanupOcr(): void {
    if (ocrCache.capture) {
      const vision = _visionProvider;
      if (vision) {
        vision.cleanupCapture(ocrCache.capture).catch(() => {});
      }
      ocrCache.capture = null;
      ocrCache.results = null;
    }
  }

  // ── 目标解析（缓存优先） ──
  async function resolveTarget(
    target: StreamingTargetSpec,
    _perceptionStrategy: PerceptionStrategy = 'auto',
  ): Promise<{ x: number; y: number; fromCache: boolean } | { error: string }> {
    const vision = getVisionProvider();

    if (isTargetCoord(target)) return { x: target.x, y: target.y, fromCache: false };

    if (isTargetPercent(target)) {
      if (!ocrCache.capture) {
        ocrCache.capture = await vision.captureScreen();
        ocrCache.results = await vision.ocrScreen(ocrCache.capture);
      }
      return {
        x: Math.round((target.xPercent / 100) * ocrCache.capture.width),
        y: Math.round((target.yPercent / 100) * ocrCache.capture.height),
        fromCache: false,
      };
    }

    if (isTargetText(target)) {
      const cached = coordCache.get(target.text);
      if (cached) { cacheHits++; return { ...cached, fromCache: true }; }
      cacheMisses++;

      if (!ocrCache.capture) {
        ocrCache.capture = await vision.captureScreen();
        ocrCache.results = await vision.ocrScreen(ocrCache.capture);
      }
      const match = vision.findTextInOcrResults(ocrCache.results!, target.text, { fuzzy: target.fuzzy });
      if (!match) return { error: `未找到文字: "${target.text}"` };
      coordCache.set(target.text, { x: match.x, y: match.y });
      return { x: match.x, y: match.y, fromCache: false };
    }

    return { error: "无效的目标定位方式" };
  }

  function hasError(r: { x: number; y: number; fromCache: boolean } | { error: string }): r is { error: string } {
    return "error" in r;
  }

  // ── 执行单步 ──
  async function executeOneStep(step: StreamingStep): Promise<StreamingStepResult> {
    const idx = stepCounter++;
    const t0 = Date.now();
    const stepExecId = `${sessionExecutionId}_step_${idx}`;

    emit({ type: "step_start", stepIndex: idx, action: step.action, queueSize: queue.length });

    logAuditEvent({
      eventType: "tool.execute.start",
      toolRef: `device.gui.streaming.${step.action}`,
      toolName: `streaming.${step.action}`,
      executionId: stepExecId,
      extra: { stepIndex: idx, queueSize: queue.length, parentSession: sessionExecutionId },
    }).catch(() => {});

    try {
      const detail = await runStepAction(step);
      const dur = Date.now() - t0;
      const isFail = detail?.status === "failed";

      const result: StreamingStepResult = {
        stepIndex: idx,
        action: step.action,
        status: isFail ? "failed" : "ok",
        detail: detail?.detail,
        durationMs: dur,
      };

      logAuditEvent({
        eventType: isFail ? "tool.execute.failed" : "tool.execute.success",
        toolRef: `device.gui.streaming.${step.action}`,
        toolName: `streaming.${step.action}`,
        executionId: stepExecId,
        status: isFail ? "failed" : "success",
        durationMs: dur,
        extra: { stepIndex: idx, parentSession: sessionExecutionId },
      }).catch(() => {});

      if (step.action === "screenshot" && !isFail && detail?.detail) {
        const d = detail.detail as any;
        if (d.filePath) {
          import("node:fs").then((fs) => {
            fs.promises.readFile(d.filePath).then((buf) => {
              uploadArtifact({ executionId: stepExecId, data: buf, mimeType: "image/png", metadata: { filename: `screenshot_step_${idx}.png` } }).catch(() => {});
            }).catch(() => {});
          }).catch(() => {});
        }
      }

      if (isFail) { failedCount++; emit({ type: "step_failed", result }); }
      else { succeededCount++; emit({ type: "step_complete", result }); }

      if (SCREEN_CHANGING_ACTIONS.has(step.action)) {
        cleanupOcr();
        coordCache.invalidateAll();
      }

      return result;
    } catch (err: any) {
      const dur = Date.now() - t0;
      failedCount++;

      logAuditEvent({
        eventType: "tool.execute.failed",
        toolRef: `device.gui.streaming.${step.action}`,
        toolName: `streaming.${step.action}`,
        executionId: stepExecId,
        status: "failed",
        errorCategory: "step_exception",
        durationMs: dur,
        extra: { stepIndex: idx, error: String(err?.message ?? "unknown").slice(0, 200), parentSession: sessionExecutionId },
      }).catch(() => {});

      const result: StreamingStepResult = {
        stepIndex: idx,
        action: step.action,
        status: "failed",
        detail: { error: String(err?.message ?? "unknown") },
        durationMs: dur,
      };
      emit({ type: "step_failed", result });
      return result;
    }
  }

  async function runStepAction(step: StreamingStep): Promise<{ status: "ok" | "failed"; detail?: unknown }> {
    const vision = getVisionProvider();

    switch (step.action) {
      case "click":
      case "doubleClick":
      case "moveTo": {
        const pos = await resolveTarget(step.target, step.perceptionStrategy);
        if (hasError(pos)) return { status: "failed", detail: pos.error };
        const result = await executeNativeGuiAction(step.action, { x: pos.x, y: pos.y }, {
          button: step.action === "click" ? (step.button ?? "left") : undefined,
        });
        return { status: "ok", detail: { ...result.detail, fromCache: pos.fromCache } };
      }
      case "type": {
        let targetCoord: { x: number; y: number; fromCache: boolean } | undefined;
        if (step.target) {
          const pos = await resolveTarget(step.target, step.perceptionStrategy);
          if (hasError(pos)) return { status: "failed", detail: pos.error };
          targetCoord = pos;
        }
        const result = await executeNativeGuiAction("type", targetCoord, {
          text: step.text,
          typeClickDelayMs: 50,
        });
        return { status: "ok", detail: { ...result.detail, fromCache: targetCoord?.fromCache } };
      }
      case "pressKey":
      case "pressCombo":
      case "scroll": {
        const result = await executeNativeGuiAction(step.action, undefined, {
          key: step.action === "pressKey" ? step.key : undefined,
          keys: step.action === "pressCombo" ? step.keys : undefined,
          direction: step.action === "scroll" ? step.direction : undefined,
          clicks: step.action === "scroll" ? (step.clicks ?? 3) : undefined,
        });
        return { status: "ok", detail: result.detail };
      }
      case "wait": {
        await sleep(step.ms);
        return { status: "ok", detail: { ms: step.ms } };
      }
      case "waitForText": {
        const timeout = step.timeoutMs ?? 5000;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          cleanupOcr();
          ocrCache.capture = await vision.captureScreen();
          ocrCache.results = await vision.ocrScreen(ocrCache.capture);
          const match = vision.findTextInOcrResults(ocrCache.results!, step.text, { fuzzy: true });
          if (match) return { status: "ok", detail: { text: step.text, x: match.x, y: match.y } };
          await sleep(200);
        }
        return { status: "failed", detail: { error: `等待文字 "${step.text}" 超时 (${timeout}ms)` } };
      }
      case "assertText": {
        cleanupOcr();
        ocrCache.capture = await vision.captureScreen();
        ocrCache.results = await vision.ocrScreen(ocrCache.capture);
        const match = vision.findTextInOcrResults(ocrCache.results!, step.text, { fuzzy: true });
        const present = step.present !== false;
        if (present && !match) return { status: "failed", detail: { error: `断言失败: 文字 "${step.text}" 不存在` } };
        if (!present && match) return { status: "failed", detail: { error: `断言失败: 文字 "${step.text}" 不应存在` } };
        return { status: "ok", detail: { text: step.text, present } };
      }
      case "screenshot": {
        cleanupOcr();
        ocrCache.capture = await vision.captureScreen();
        return { status: "ok", detail: { filePath: ocrCache.capture.filePath, width: ocrCache.capture.width, height: ocrCache.capture.height } };
      }
      default:
        return { status: "failed", detail: { error: `未知动作: ${(step as any).action}` } };
    }
  }

  function currentState(): StreamingState { return state; }

  // ── 主执行循环 ──
  async function runLoop(): Promise<void> {
    while (currentState() === "running" || currentState() === "paused") {
      while (currentState() === "paused") {
        await sleep(50);
      }
      if (currentState() !== "running") break;

      const step = queue.shift();
      if (!step) {
        if (inputDone) {
          setState("stopped", "all_steps_completed");
          return;
        }
        await sleep(10);
        continue;
      }

      const result = await Promise.race([
        executeOneStep(step),
        sleep(stepTimeoutMs).then((): StreamingStepResult => ({
          stepIndex: stepCounter,
          action: step.action,
          status: "failed",
          detail: { error: `步骤执行超时 (${stepTimeoutMs}ms)` },
          durationMs: stepTimeoutMs,
        })),
      ]);

      if (result.status === "failed" && stopOnError) {
        setState("error", `step_${result.stepIndex}_failed`);
        return;
      }

      if (step.action !== "wait" && queue.length > 0) {
        await sleep(interStepDelayMs);
      }
    }
  }

  // ── 公共 API ──
  const executor: StreamingExecutor = {
    get state() { return state; },
    get queueSize() { return queue.length; },
    get completedSteps() { return succeededCount; },
    get failedSteps() { return failedCount; },

    onEvent(handler) { handlers.push(handler); },

    start() {
      if (state === "running" || state === "paused") return;
      donePromise = new Promise<void>((r) => { doneResolve = r; });
      startedAt = Date.now();
      stepCounter = 0;
      succeededCount = 0;
      failedCount = 0;
      cacheHits = 0;
      cacheMisses = 0;
      inputDone = false;
      logAuditEvent({
        eventType: "session.start",
        executionId: sessionExecutionId,
        extra: { type: "streaming", config: { interStepDelayMs, stepTimeoutMs, ocrCacheTtlMs: _ocrCacheTtlMs, maxQueueSize, stopOnError } },
      }).catch(() => {});
      setState("running");
      runLoop().catch((err) => {
        setState("error", String(err?.message ?? "loop_error"));
      });
    },

    appendSteps(steps) {
      for (const s of steps) queue.push(s);
      if (queue.length > maxQueueSize) {
        emit({ type: "backpressure", queueSize: queue.length, paused: true });
      }
    },

    markInputDone() {
      inputDone = true;
    },

    pause() {
      if (state === "running") {
        setState("paused", "user_pause");
      }
    },

    resume() {
      if (state === "paused") {
        setState("running", "user_resume");
      }
    },

    stop() {
      queue.length = 0;
      inputDone = true;
      if (state === "running" || state === "paused") {
        setState("stopped", "user_stop");
      }
    },

    waitUntilDone() {
      return donePromise;
    },

    getSummary() {
      return {
        state,
        totalSteps: stepCounter,
        succeeded: succeededCount,
        failed: failedCount,
        queueSize: queue.length,
        totalDurationMs: startedAt > 0 ? Date.now() - startedAt : 0,
        cacheHits,
        cacheMisses,
      };
    },
  };

  return executor;
}

// ── 能力注册 ────────────────────────────────────────────────────

/** 流式执行器声明的能力列表 */
export const STREAMING_CAPABILITIES: CapabilityDescriptor[] = [
  { toolRef: "device.gui.streaming.click", riskLevel: "medium", description: "流式鼠标点击", tags: ["gui", "streaming", "input"] },
  { toolRef: "device.gui.streaming.doubleClick", riskLevel: "medium", description: "流式鼠标双击", tags: ["gui", "streaming", "input"] },
  { toolRef: "device.gui.streaming.type", riskLevel: "medium", description: "流式键盘输入", tags: ["gui", "streaming", "input"] },
  { toolRef: "device.gui.streaming.pressKey", riskLevel: "low", description: "流式按键", tags: ["gui", "streaming", "input"] },
  { toolRef: "device.gui.streaming.pressCombo", riskLevel: "medium", description: "流式组合键", tags: ["gui", "streaming", "input"] },
  { toolRef: "device.gui.streaming.scroll", riskLevel: "low", description: "流式滚动", tags: ["gui", "streaming", "input"] },
  { toolRef: "device.gui.streaming.moveTo", riskLevel: "low", description: "流式鼠标移动", tags: ["gui", "streaming", "input"] },
  { toolRef: "device.gui.streaming.screenshot", riskLevel: "medium", description: "流式截屏", tags: ["gui", "streaming", "perception"] },
  { toolRef: "device.gui.streaming.waitForText", riskLevel: "low", description: "流式等待文字出现", tags: ["gui", "streaming", "perception"] },
  { toolRef: "device.gui.streaming.assertText", riskLevel: "low", description: "流式断言文字存在", tags: ["gui", "streaming", "perception"] },
  { toolRef: "device.gui.streaming.session", riskLevel: "high", description: "流式执行会话（包含多步连续操作）", tags: ["gui", "streaming", "session"] },
];

/**
 * 将流式执行器能力注册到内核 capabilityRegistry。
 * 应在流式执行器开始使用前调用。
 */
export function registerStreamingCapabilities(): void {
  try {
    registerCapabilities(STREAMING_CAPABILITIES);
  } catch {
    // 重复注册时忽略（幂等）
  }
}
