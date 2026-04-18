/**
 * Streaming Executor — 流式控制本地闭环执行器
 *
 * ============================================================
 * 三链路架构定位：
 *
 *   1️⃣  原子操作链路（desktopPlugin 子插件）
 *       └─ 单次 tool call → 单个操作
 *
 *   2️⃣  批量计划链路（guiAutomationPlugin.ts）
 *       └─ 一次性接收完整计划，本地闭环执行
 *
 *   3️⃣  流式推送链路（本文件 streamingExecutor）  ◀◀ YOU ARE HERE
 *       └─ WS 持续推送 step，实时入队执行
 *       └─ 每步开始/完成/失败均回调通知
 *       └─ 支持暂停/恢复/取消、背压控制
 *       └─ 每步 ~10-50ms（缓存命中）/ ~200ms（需 OCR）
 *
 * 调用边界：
 *   - 由 websocketClient 或上层控制器直接实例化，不走 taskExecutor
 *   - 与 guiAutomationPlugin 共享 localVision 底层原语，但不直接互调
 *   - 共享类型定义见 guiTypes.ts（StreamingStep / TargetSpec 等）
 * ============================================================
 *
 * 绕过 Task/Run 生命周期，直接运行 感知→决策→执行→验证 每步每秒级闭环。
 */

import {
  captureScreen,
  cleanupCapture,
  ocrScreen,
  findTextInOcrResults,
  clickMouse,
  doubleClick,
  typeText,
  pressKey,
  pressCombo,
  moveMouse,
  scroll,
  type OcrMatch,
  type ScreenCapture,
} from "./plugins/localVision";
import { logAuditEvent, uploadArtifact } from "./kernel/audit";
import { registerCapabilities } from "./kernel/capabilityRegistry";
import type { CapabilityDescriptor } from "./kernel/types";
import {
  type StreamingStep, type StreamingTargetSpec, type TargetSpec,
  isTargetCoord as isCoord, isTargetPercent as isPercent, isTargetText as isText,
} from "./plugins/guiTypes";

// ── 类型（共享类型从 guiTypes.ts 导入，以下为 streaming 专属类型）────

export type { StreamingStep, StreamingTargetSpec } from "./plugins/guiTypes";

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

const SCREEN_CHANGING_ACTIONS = new Set([
  "click", "doubleClick", "type", "pressKey", "pressCombo", "scroll",
]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── OCR 坐标缓存 ─────────────────────────────────────────────────

class CoordCache {
  private cache = new Map<string, { x: number; y: number; cachedAt: number }>();
  constructor(private ttlMs: number) {}

  get(key: string): { x: number; y: number } | null {
    const e = this.cache.get(key);
    if (!e) return null;
    if (Date.now() - e.cachedAt > this.ttlMs) { this.cache.delete(key); return null; }
    // P3-2: LRU touch — delete+re-set 将条目移到 Map 尾部，淘汰时优先移除最久未访问的
    this.cache.delete(key);
    this.cache.set(key, e);
    return { x: e.x, y: e.y };
  }

  set(key: string, coord: { x: number; y: number }): void {
    if (this.cache.size >= 200) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { ...coord, cachedAt: Date.now() });
  }

  invalidateAll(): void { this.cache.clear(); }
  get size(): number { return this.cache.size; }
}

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
  const interStepDelayMs = config?.interStepDelayMs ?? 50;
  const stepTimeoutMs = config?.stepTimeoutMs ?? 10_000;
  const ocrCacheTtlMs = config?.ocrCacheTtlMs ?? 2000;
  const maxQueueSize = config?.maxQueueSize ?? 200;
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
  const coordCache = new CoordCache(ocrCacheTtlMs);
  let ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null } = { capture: null, results: null };

  let doneResolve: (() => void) | null = null;
  // P3-1: 使用 let 以便 start() 重入时重建 promise
  let donePromise = new Promise<void>((r) => { doneResolve = r; });

  // 流式执行器全局 ID（用于审计关联）
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
    // 审计：记录流式执行 session 结束
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
      cleanupCapture(ocrCache.capture).catch(() => {});
      ocrCache.capture = null;
      ocrCache.results = null;
    }
  }

  // ── 目标解析（缓存优先） ──
  async function resolveTarget(target: StreamingTargetSpec): Promise<{ x: number; y: number; fromCache: boolean } | { error: string }> {
    if (isCoord(target)) return { x: target.x, y: target.y, fromCache: false };

    if (isPercent(target)) {
      if (!ocrCache.capture) {
        ocrCache.capture = await captureScreen();
        ocrCache.results = await ocrScreen(ocrCache.capture);
      }
      return {
        x: Math.round((target.xPercent / 100) * ocrCache.capture.width),
        y: Math.round((target.yPercent / 100) * ocrCache.capture.height),
        fromCache: false,
      };
    }

    if (isText(target)) {
      // 缓存优先
      const cached = coordCache.get(target.text);
      if (cached) { cacheHits++; return { ...cached, fromCache: true }; }
      cacheMisses++;

      if (!ocrCache.capture) {
        ocrCache.capture = await captureScreen();
        ocrCache.results = await ocrScreen(ocrCache.capture);
      }
      const match = findTextInOcrResults(ocrCache.results!, target.text, { fuzzy: target.fuzzy });
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

    // 审计：记录步骤开始
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

      // 审计：记录步骤结果
      logAuditEvent({
        eventType: isFail ? "tool.execute.failed" : "tool.execute.success",
        toolRef: `device.gui.streaming.${step.action}`,
        toolName: `streaming.${step.action}`,
        executionId: stepExecId,
        status: isFail ? "failed" : "success",
        durationMs: dur,
        extra: { stepIndex: idx, parentSession: sessionExecutionId },
      }).catch(() => {});

      // screenshot 步骤自动上传 artifact 作为 evidence
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

      // 屏幕变化操作后清除 OCR 缓存快照
      if (SCREEN_CHANGING_ACTIONS.has(step.action)) {
        cleanupOcr();
        coordCache.invalidateAll();
      }

      return result;
    } catch (err: any) {
      const dur = Date.now() - t0;
      failedCount++;

      // 审计：记录步骤异常
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
    switch (step.action) {
      case "click": {
        const pos = await resolveTarget(step.target);
        if (hasError(pos)) return { status: "failed", detail: pos.error };
        await clickMouse(pos.x, pos.y, step.button ?? "left");
        return { status: "ok", detail: { x: pos.x, y: pos.y, fromCache: pos.fromCache } };
      }
      case "doubleClick": {
        const pos = await resolveTarget(step.target);
        if (hasError(pos)) return { status: "failed", detail: pos.error };
        await doubleClick(pos.x, pos.y);
        return { status: "ok", detail: { x: pos.x, y: pos.y, fromCache: pos.fromCache } };
      }
      case "type": {
        if (step.target) {
          const pos = await resolveTarget(step.target);
          if (hasError(pos)) return { status: "failed", detail: pos.error };
          await clickMouse(pos.x, pos.y);
          await sleep(50);
        }
        await typeText(step.text);
        return { status: "ok", detail: { textLen: step.text.length } };
      }
      case "pressKey": {
        await pressKey(step.key);
        return { status: "ok", detail: { key: step.key } };
      }
      case "pressCombo": {
        await pressCombo(step.keys);
        return { status: "ok", detail: { keys: step.keys } };
      }
      case "scroll": {
        await scroll(step.direction, step.clicks ?? 3);
        return { status: "ok", detail: { direction: step.direction, clicks: step.clicks ?? 3 } };
      }
      case "moveTo": {
        const pos = await resolveTarget(step.target);
        if (hasError(pos)) return { status: "failed", detail: pos.error };
        await moveMouse(pos.x, pos.y);
        return { status: "ok", detail: { x: pos.x, y: pos.y, fromCache: pos.fromCache } };
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
          ocrCache.capture = await captureScreen();
          ocrCache.results = await ocrScreen(ocrCache.capture);
          const match = findTextInOcrResults(ocrCache.results!, step.text, { fuzzy: true });
          if (match) return { status: "ok", detail: { text: step.text, x: match.x, y: match.y } };
          await sleep(200);
        }
        return { status: "failed", detail: { error: `等待文字 "${step.text}" 超时 (${timeout}ms)` } };
      }
      case "assertText": {
        cleanupOcr();
        ocrCache.capture = await captureScreen();
        ocrCache.results = await ocrScreen(ocrCache.capture);
        const match = findTextInOcrResults(ocrCache.results!, step.text, { fuzzy: true });
        const present = step.present !== false;
        if (present && !match) return { status: "failed", detail: { error: `断言失败: 文字 "${step.text}" 不存在` } };
        if (!present && match) return { status: "failed", detail: { error: `断言失败: 文字 "${step.text}" 不应存在` } };
        return { status: "ok", detail: { text: step.text, present } };
      }
      case "screenshot": {
        cleanupOcr();
        ocrCache.capture = await captureScreen();
        return { status: "ok", detail: { filePath: ocrCache.capture.filePath, width: ocrCache.capture.width, height: ocrCache.capture.height } };
      }
      default:
        return { status: "failed", detail: { error: `未知动作: ${(step as any).action}` } };
    }
  }

  /** 读取当前状态（避免 TS 类型收窄干扰外部异步状态变更） */
  function currentState(): StreamingState { return state; }

  // ── 主执行循环 ──
  async function runLoop(): Promise<void> {
    while (currentState() === "running" || currentState() === "paused") {
      // 暂停检查
      while (currentState() === "paused") {
        await sleep(50);
      }
      if (currentState() !== "running") break;

      // 取下一步
      const step = queue.shift();
      if (!step) {
        // 队列空了
        if (inputDone) {
          // 输入端已标记完成，整个流结束
          setState("stopped", "all_steps_completed");
          return;
        }
        // 等待更多步骤
        await sleep(10);
        continue;
      }

      // 执行单步（带超时保护）
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

      // 步骤间延迟
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
      // P3-1: 重建 donePromise，避免重入时返回已 resolved 的旧 promise
      donePromise = new Promise<void>((r) => { doneResolve = r; });
      startedAt = Date.now();
      stepCounter = 0;
      succeededCount = 0;
      failedCount = 0;
      cacheHits = 0;
      cacheMisses = 0;
      inputDone = false;
      // 审计：记录流式执行 session 开始
      logAuditEvent({
        eventType: "session.start",
        executionId: sessionExecutionId,
        extra: { type: "streaming", config: { interStepDelayMs, stepTimeoutMs, ocrCacheTtlMs, maxQueueSize, stopOnError } },
      }).catch(() => {});
      setState("running");
      runLoop().catch((err) => {
        setState("error", String(err?.message ?? "loop_error"));
      });
    },

    appendSteps(steps) {
      for (const s of steps) queue.push(s);
      // 背压检查
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

// ── 能力注册：将 streaming 执行器正式注册到内核能力注册表 ────────

/** 流式执行器声明的能力列表 */
export const STREAMING_CAPABILITIES: CapabilityDescriptor[] = [
  {
    toolRef: "device.gui.streaming.click",
    riskLevel: "medium",
    description: "流式鼠标点击",
    tags: ["gui", "streaming", "input"],
  },
  {
    toolRef: "device.gui.streaming.doubleClick",
    riskLevel: "medium",
    description: "流式鼠标双击",
    tags: ["gui", "streaming", "input"],
  },
  {
    toolRef: "device.gui.streaming.type",
    riskLevel: "medium",
    description: "流式键盘输入",
    tags: ["gui", "streaming", "input"],
  },
  {
    toolRef: "device.gui.streaming.pressKey",
    riskLevel: "low",
    description: "流式按键",
    tags: ["gui", "streaming", "input"],
  },
  {
    toolRef: "device.gui.streaming.pressCombo",
    riskLevel: "medium",
    description: "流式组合键",
    tags: ["gui", "streaming", "input"],
  },
  {
    toolRef: "device.gui.streaming.scroll",
    riskLevel: "low",
    description: "流式滚动",
    tags: ["gui", "streaming", "input"],
  },
  {
    toolRef: "device.gui.streaming.moveTo",
    riskLevel: "low",
    description: "流式鼠标移动",
    tags: ["gui", "streaming", "input"],
  },
  {
    toolRef: "device.gui.streaming.screenshot",
    riskLevel: "medium",
    description: "流式截屏",
    tags: ["gui", "streaming", "perception"],
  },
  {
    toolRef: "device.gui.streaming.waitForText",
    riskLevel: "low",
    description: "流式等待文字出现",
    tags: ["gui", "streaming", "perception"],
  },
  {
    toolRef: "device.gui.streaming.assertText",
    riskLevel: "low",
    description: "流式断言文字存在",
    tags: ["gui", "streaming", "perception"],
  },
  {
    toolRef: "device.gui.streaming.session",
    riskLevel: "high",
    description: "流式执行会话（包含多步连续操作）",
    tags: ["gui", "streaming", "session"],
  },
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
