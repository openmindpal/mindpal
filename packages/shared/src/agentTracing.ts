/**
 * AgentTracing — Agent Loop 细粒度追踪工具
 * 在 Agent Loop 的每个 phase 插入 OpenTelemetry span
 * 支持迭代级追踪和自适应采样
 *
 * 设计原则：
 * - 依赖注入式（不直接 import OTel，由调用方传入 tracer/meter）
 * - OTel 未启用时所有操作为 no-op，零开销
 * - 不影响 Agent Loop 主流程（span 操作失败静默处理）
 */

/* ─── Span 属性定义 ─────────────────────────────────── */

/** Agent Loop span 标准属性 */
export interface AgentSpanAttrs {
  "agent.run_id": string;
  "agent.tenant_id": string;
  "agent.space_id"?: string;
  "agent.iteration": number;
  "agent.phase": string;
  "agent.tool_count"?: number;
  "agent.tool_names"?: string;
  "agent.decision"?: string;
  "agent.latency_ms"?: number;
  "agent.error"?: string;
}

/* ─── Tracer 接口（依赖注入） ──────────────────────── */

/** 最小化 OTel Span 接口，供依赖注入 */
export interface TracingSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
  recordException?(error: Error): void;
}

/** 最小化 OTel Tracer 接口 */
export interface TracingTracer {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): TracingSpan;
}

/** No-op span（OTel 未启用时使用） */
const NOOP_SPAN: TracingSpan = {
  setAttribute: () => {},
  setStatus: () => {},
  end: () => {},
  recordException: () => {},
};

/** No-op tracer */
const NOOP_TRACER: TracingTracer = {
  startSpan: () => NOOP_SPAN,
};

/* ─── Agent Tracing 上下文 ────────────────────────── */

/** Agent Loop 追踪上下文，贯穿整个循环生命周期 */
export interface AgentTracingContext {
  /** 顶层 Loop span */
  loopSpan: TracingSpan;
  /** 当前迭代 span（由 startIteration 创建） */
  iterationSpan: TracingSpan | null;
  /** 当前 Phase span（由 startPhase 创建） */
  phaseSpan: TracingSpan | null;
  /** Tracer 实例 */
  tracer: TracingTracer;
  /** 基础属性 */
  baseAttrs: { runId: string; tenantId: string; spaceId?: string };
}

/* ─── 核心函数 ─────────────────────────────────────── */

/**
 * 创建 Agent Loop 追踪上下文
 * 启动顶层 agent.loop span
 */
export function startAgentTracing(
  tracer: TracingTracer | null | undefined,
  attrs: { runId: string; tenantId: string; spaceId?: string },
): AgentTracingContext {
  const t = tracer ?? NOOP_TRACER;
  const loopSpan = t.startSpan("agent.loop", {
    attributes: {
      "agent.run_id": attrs.runId,
      "agent.tenant_id": attrs.tenantId,
      ...(attrs.spaceId ? { "agent.space_id": attrs.spaceId } : {}),
    },
  });
  return { loopSpan, iterationSpan: null, phaseSpan: null, tracer: t, baseAttrs: attrs };
}

/**
 * 开始新的迭代 span
 * 自动关闭上一轮迭代和 phase span
 */
export function startIteration(ctx: AgentTracingContext, iteration: number): void {
  // 关闭上一轮迭代 span
  ctx.iterationSpan?.end();
  ctx.phaseSpan?.end();
  ctx.phaseSpan = null;

  ctx.iterationSpan = ctx.tracer.startSpan(`agent.iteration.${iteration}`, {
    attributes: {
      ...spreadBaseAttrs(ctx),
      "agent.iteration": iteration,
    },
  });
}

/**
 * 开始 Phase span（observe/think/decide/act）
 * 自动关闭上一个 phase span
 */
export function startPhase(ctx: AgentTracingContext, phase: string, iteration: number): void {
  ctx.phaseSpan?.end();
  ctx.phaseSpan = ctx.tracer.startSpan(`agent.phase.${phase}`, {
    attributes: {
      ...spreadBaseAttrs(ctx),
      "agent.iteration": iteration,
      "agent.phase": phase,
    },
  });
}

/**
 * 结束当前 Phase span，可附加额外属性
 */
export function endPhase(ctx: AgentTracingContext, attrs?: Partial<AgentSpanAttrs>): void {
  if (ctx.phaseSpan && attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) ctx.phaseSpan.setAttribute(k, v as string | number);
    }
  }
  ctx.phaseSpan?.end();
  ctx.phaseSpan = null;
}

/**
 * 记录工具调用 span（嵌套在 act phase 内）
 * 自动记录延迟和错误信息
 */
export function traceToolCall(
  ctx: AgentTracingContext,
  toolName: string,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  const span = ctx.tracer.startSpan(`agent.tool.${toolName}`, {
    attributes: { ...spreadBaseAttrs(ctx), "agent.phase": "act" },
  });
  const start = Date.now();
  return fn()
    .then((result) => {
      span.setAttribute("agent.latency_ms", Date.now() - start);
      span.setStatus({ code: 1 }); // OK
      span.end();
      return result;
    })
    .catch((err) => {
      span.setAttribute("agent.latency_ms", Date.now() - start);
      span.setAttribute("agent.error", String(err?.message ?? err));
      span.setStatus({ code: 2, message: String(err?.message ?? err) }); // ERROR
      span.recordException?.(err instanceof Error ? err : new Error(String(err)));
      span.end();
      throw err;
    });
}

/**
 * 结束 Agent Loop 追踪
 * 记录汇总信息并关闭所有 span
 */
export function endAgentTracing(
  ctx: AgentTracingContext,
  summary: {
    totalIterations: number;
    totalLatencyMs: number;
    toolCallCount: number;
    status: "completed" | "failed" | "timeout";
    error?: string;
  },
): void {
  ctx.phaseSpan?.end();
  ctx.iterationSpan?.end();

  ctx.loopSpan.setAttribute("agent.iteration", summary.totalIterations);
  ctx.loopSpan.setAttribute("agent.latency_ms", summary.totalLatencyMs);
  ctx.loopSpan.setAttribute("agent.tool_count", summary.toolCallCount);
  if (summary.error) ctx.loopSpan.setAttribute("agent.error", summary.error);
  ctx.loopSpan.setStatus({
    code: summary.status === "completed" ? 1 : 2,
    message: summary.status === "completed" ? undefined : summary.error,
  });
  ctx.loopSpan.end();
}

/** 展开基础属性为 Record */
function spreadBaseAttrs(ctx: AgentTracingContext): Record<string, string> {
  const a: Record<string, string> = {
    "agent.run_id": ctx.baseAttrs.runId,
    "agent.tenant_id": ctx.baseAttrs.tenantId,
  };
  if (ctx.baseAttrs.spaceId) a["agent.space_id"] = ctx.baseAttrs.spaceId;
  return a;
}
