/**
 * Collab Orchestrator — 执行策略
 *
 * 三种调度策略：顺序（sequential）、并行（parallel）、流水线（pipeline）。
 * 由主入口 runCollabOrchestrator 按 CollabPlan.strategy 选择调用。
 */
import { runAgentLoop } from "./agentLoop";
import type { CollabAgentRole, AgentState, CollabOrchestratorParams } from "./collabTypes";
import { readCollabEnvelopes, buildEnvelopeContext, writeCollabEnvelope } from "./collabEnvelope";

// ── 顺序执行 ─────────────────────────────────────────────────────

/** 顺序执行：Agent 1 完成后 Agent 2 开始 */
export async function executeSequential(
  states: AgentState[],
  params: CollabOrchestratorParams,
  maxIterations: number,
): Promise<void> {
  for (const state of states) {
    if (params.signal?.aborted) break;

    state.status = "running";
    params.app.log.info({ agentId: state.agentId, role: state.role }, "[CollabOrchestrator] 开始顺序执行 Agent");

    // 构建增强目标（包含前面 Agent 的结构化结果）
    const envelopes = await readCollabEnvelopes({ pool: params.pool, collabRunId: params.collabRunId, toRole: state.role });
    const structuredContext = buildEnvelopeContext(envelopes);
    const prevResults = states
      .filter((s) => s.status === "done" && s.result)
      .map((s) => `[${s.role}]: ${s.result!.message}`)
      .join("\n");
    const enhancedGoal = prevResults
      ? `${state.goal}\n\n## Previous Agent Results\n${prevResults}${structuredContext}`
      : structuredContext
        ? `${state.goal}${structuredContext}`
        : state.goal;

    state.result = await runAgentLoop({
      app: params.app,
      pool: params.pool,
      queue: params.queue,
      subject: params.subject,
      locale: params.locale,
      authorization: params.authorization,
      traceId: params.traceId,
      goal: enhancedGoal,
      runId: state.runId,
      jobId: state.jobId,
      taskId: params.taskId,
      maxIterations,
      signal: params.signal,
    });

    state.status = state.result.ok ? "done" : "failed";

    // 将结果写入 collab_envelopes 供下游 Agent 结构化查询
    await writeCollabEnvelope({
      pool: params.pool,
      tenantId: params.subject.tenantId,
      spaceId: params.subject.spaceId,
      collabRunId: params.collabRunId,
      taskId: params.taskId,
      fromRole: state.role,
      toRole: null,
      broadcast: true,
      kind: "agent.result",
      result: state.result,
      runId: state.runId,
    });

    params.app.log.info({
      agentId: state.agentId,
      status: state.status,
      endReason: state.result.endReason,
    }, "[CollabOrchestrator] Agent 执行完成");
  }
}

// ── 并行执行 ─────────────────────────────────────────────────────

/** 并行执行：所有 Agent 同时启动 */
export async function executeParallel(
  states: AgentState[],
  params: CollabOrchestratorParams,
  maxIterations: number,
): Promise<void> {
  params.app.log.info({ agentCount: states.length }, "[CollabOrchestrator] 开始并行执行");

  const promises = states.map(async (state) => {
    state.status = "running";
    state.result = await runAgentLoop({
      app: params.app,
      pool: params.pool,
      queue: params.queue,
      subject: params.subject,
      locale: params.locale,
      authorization: params.authorization,
      traceId: params.traceId,
      goal: state.goal,
      runId: state.runId,
      jobId: state.jobId,
      taskId: params.taskId,
      maxIterations,
      signal: params.signal,
    });
    state.status = state.result.ok ? "done" : "failed";
    await writeCollabEnvelope({
      pool: params.pool,
      tenantId: params.subject.tenantId,
      spaceId: params.subject.spaceId,
      collabRunId: params.collabRunId,
      taskId: params.taskId,
      fromRole: state.role,
      toRole: null,
      broadcast: true,
      kind: "agent.result",
      result: state.result,
      runId: state.runId,
    });
  });

  await Promise.all(promises);
}

// ── 流水线执行 ───────────────────────────────────────────────────

/** 流水线执行：每个 Agent 处理后传给下一个，支持依赖关系 */
export async function executePipeline(
  states: AgentState[],
  agents: CollabAgentRole[],
  params: CollabOrchestratorParams,
  maxIterations: number,
): Promise<void> {
  params.app.log.info({ agentCount: states.length }, "[CollabOrchestrator] 开始流水线执行");

  // 按依赖关系排序（拓扑排序）
  const completed = new Set<string>();
  const remaining = new Set(states.map((s) => s.agentId));

  while (remaining.size > 0 && !params.signal?.aborted) {
    // 找到所有依赖已满足的 Agent
    const ready: AgentState[] = [];
    for (const state of states) {
      if (!remaining.has(state.agentId)) continue;
      const agent = agents.find((a) => a.agentId === state.agentId);
      const deps = agent?.dependencies ?? [];
      if (deps.every((d) => completed.has(d))) {
        ready.push(state);
      }
    }

    if (ready.length === 0) {
      // 死锁检测：有剩余 Agent 但没有可执行的
      params.app.log.error({ remaining: Array.from(remaining) }, "[CollabOrchestrator] 流水线死锁");
      for (const id of remaining) {
        const s = states.find((x) => x.agentId === id);
        if (s) s.status = "failed";
      }
      break;
    }

    // 并行执行所有就绪的 Agent
    const promises = ready.map(async (state) => {
      state.status = "running";

      // 注入依赖 Agent 的结构化结果
      const agent = agents.find((a) => a.agentId === state.agentId);
      const envelopes = await readCollabEnvelopes({ pool: params.pool, collabRunId: params.collabRunId, toRole: state.role });
      const structuredContext = buildEnvelopeContext(envelopes);
      const depResults = (agent?.dependencies ?? [])
        .map((depId) => states.find((s) => s.agentId === depId))
        .filter((s): s is AgentState => !!s && s.status === "done" && !!s.result)
        .map((s) => `[${s.role}]: ${s.result!.message}`)
        .join("\n");
      const enhancedGoal = depResults
        ? `${state.goal}\n\n## Input from Dependent Agents\n${depResults}${structuredContext}`
        : structuredContext
          ? `${state.goal}${structuredContext}`
          : state.goal;

      state.result = await runAgentLoop({
        app: params.app,
        pool: params.pool,
        queue: params.queue,
        subject: params.subject,
        locale: params.locale,
        authorization: params.authorization,
        traceId: params.traceId,
        goal: enhancedGoal,
        runId: state.runId,
        jobId: state.jobId,
        taskId: params.taskId,
        maxIterations,
        signal: params.signal,
      });

      state.status = state.result.ok ? "done" : "failed";

      // 将结果写入 collab_envelopes 供下游 Agent 查询
      await writeCollabEnvelope({
        pool: params.pool,
        tenantId: params.subject.tenantId,
        spaceId: params.subject.spaceId,
        collabRunId: params.collabRunId,
        taskId: params.taskId,
        fromRole: state.role,
        toRole: null,
        broadcast: true,
        kind: "agent.result",
        result: state.result,
        runId: state.runId,
      });

      completed.add(state.agentId);
      remaining.delete(state.agentId);
    });

    await Promise.all(promises);
  }
}
