/**
 * Collab Orchestrator — 执行策略
 *
 * 三种调度策略：顺序（sequential）、并行（parallel）、流水线（pipeline）。
 * 由主入口 runCollabOrchestrator 按 CollabPlan.strategy 选择调用。
 */
import { runAgentLoop } from "./agentLoop";
import type { CollabAgentRole, AgentState, CollabOrchestratorParams } from "./collabTypes";
import { readCollabEnvelopes, buildEnvelopeContext, writeCollabEnvelope } from "./collabEnvelope";
import { StructuredLogger, collabConfig } from "@mindpal/shared";

const logger = new StructuredLogger({ module: "collabStrategies" });

// ── 结果注入校验 ────────────────────────────────────────────────

/** Envelope 结果最大字节数（governance > env > default 三级配置） */
function getMaxEnvelopeSize(): number {
  return collabConfig("COLLAB_MAX_ENVELOPE_SIZE");
}

function validateEnvelope(envelope: unknown): { valid: boolean; reason?: string } {
  if (!envelope || typeof envelope !== "object") return { valid: false, reason: "envelope_null_or_invalid" };
  const e = envelope as Record<string, unknown>;
  if (!e.agentId || typeof e.agentId !== "string") return { valid: false, reason: "missing_agentId" };
  if (e.result === undefined) return { valid: false, reason: "missing_result" };
  const size = JSON.stringify(e.result).length;
  if (size > getMaxEnvelopeSize()) return { valid: false, reason: `result_too_large(${size}>${getMaxEnvelopeSize()})` };
  return { valid: true };
}

// ── 顺序执行 ─────────────────────────────────────────────────────

/** 顺序执行：Agent 1 完成后 Agent 2 开始，失败Agent输出用空结果替代继续下一个 */
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

    try {
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
    } catch (agentErr: unknown) {
      // Agent级failover：失败Agent的输出用空结果替代，继续下一个Agent
      const errMsg = agentErr instanceof Error ? agentErr.message : String(agentErr);
      params.app.log.warn({
        agentId: state.agentId, role: state.role, err: errMsg,
      }, "[CollabOrchestrator] 顺序Agent执行失败，用空结果替代继续");
      state.status = "failed";
      state.result = {
        ok: false,
        endReason: "error",
        message: `Agent执行异常: ${errMsg}`,
        iterations: 0,
        succeededSteps: 0,
        failedSteps: 0,
        observations: [],
        lastDecision: null,
      };
    }

    // 将结果写入 collab_envelopes 供下游 Agent 结构化查询
    const seqResult = state.result!;
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
      result: seqResult,
      runId: state.runId,
    });

    params.app.log.info({
      agentId: state.agentId,
      status: state.status,
      endReason: seqResult.endReason,
    }, "[CollabOrchestrator] Agent 执行完成");
  }
}

// ── 并行执行 ─────────────────────────────────────────────────────

/** 并行执行：所有 Agent 同时启动，收集成功Agent的结果，忽略失败Agent */
export async function executeParallel(
  states: AgentState[],
  params: CollabOrchestratorParams,
  maxIterations: number,
): Promise<void> {
  params.app.log.info({ agentCount: states.length }, "[CollabOrchestrator] 开始并行执行");

  const promises = states.map(async (state) => {
    state.status = "running";
    params.app.log.info(
      { agentId: state.agentId, role: state.role, runId: state.runId },
      "[CollabOrchestrator] 并行 Agent 开始执行",
    );
    try {
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
    } catch (agentErr: unknown) {
      // Agent级failover：收集成功Agent的结果，忽略失败Agent
      const errMsg = agentErr instanceof Error ? agentErr.message : String(agentErr);
      params.app.log.warn({
        agentId: state.agentId, role: state.role, err: errMsg,
      }, "[CollabOrchestrator] 并行Agent执行失败，忽略该Agent继续");
      state.status = "failed";
      state.result = {
        ok: false,
        endReason: "error",
        message: `Agent执行异常: ${errMsg}`,
        iterations: 0,
        succeededSteps: 0,
        failedSteps: 0,
        observations: [],
        lastDecision: null,
      };
    }
    const parResult = state.result!;
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
      result: parResult,
      runId: state.runId,
    });
  });

  await Promise.all(promises);
}

// ── 流水线执行 ───────────────────────────────────────────────────

/**
 * 依赖图无环检测（DFS 拓扑排序预验证）
 * 返回环路径（如 ["A","B","C","A"]），无环返回 null
 */
function detectCycleInDependencyGraph(
  agents: CollabAgentRole[],
): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycle: string[] = [];

  function dfs(agentId: string): boolean {
    if (inStack.has(agentId)) {
      cycle.push(agentId);
      return true;
    }
    if (visited.has(agentId)) return false;

    visited.add(agentId);
    inStack.add(agentId);

    const agent = agents.find((a) => a.agentId === agentId);
    for (const dep of agent?.dependencies ?? []) {
      if (dfs(dep)) {
        cycle.push(agentId);
        return true;
      }
    }

    inStack.delete(agentId);
    return false;
  }

  for (const agent of agents) {
    if (!visited.has(agent.agentId)) {
      if (dfs(agent.agentId)) return cycle.reverse();
    }
  }
  return null;
}

/** 流水线执行：每个 Agent 处理后传给下一个，支持依赖关系 */
export async function executePipeline(
  states: AgentState[],
  agents: CollabAgentRole[],
  params: CollabOrchestratorParams,
  maxIterations: number,
): Promise<void> {
  params.app.log.info({ agentCount: states.length }, "[CollabOrchestrator] 开始流水线执行");

  // ── 新增：依赖图无环检测（在执行前预验证） ──
  const cycle = detectCycleInDependencyGraph(agents);
  if (cycle) {
    const cycleStr = cycle.join(" → ");
    params.app.log.error({ cycle: cycleStr }, "[CollabOrchestrator] 检测到循环依赖");
    for (const state of states) {
      state.status = "failed";
      state.result = {
        ok: false,
        endReason: "cycle_detected",
        message: `流水线存在循环依赖: ${cycleStr}`,
        iterations: 0,
      } as any;
    }
    return;
  }

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
      const remainingIds = Array.from(remaining);

      // 死锁恢复：检查未满足的依赖是否为 optional
      const optionalRecoverable: string[] = [];
      for (const id of remainingIds) {
        const agent = agents.find(a => a.agentId === id);
        const optDeps = new Set(agent?.optionalDependencies ?? []);
        const unresolved = (agent?.dependencies ?? []).filter(d => !completed.has(d));
        if (unresolved.every(d => optDeps.has(d))) {
          // 所有未满足依赖均为 optional，可跳过继续执行
          for (const d of unresolved) {
            const dState = states.find(x => x.agentId === d);
            if (dState && dState.status === "pending") {
              dState.status = "failed";
              dState.result = {
                ok: false,
                endReason: "error",
                message: `optional dependency skipped during deadlock recovery`,
                iterations: 0,
                succeededSteps: 0,
                failedSteps: 0,
                observations: [],
                lastDecision: null,
              };
            }
            completed.add(d);
            remaining.delete(d);
          }
          optionalRecoverable.push(id);
        }
      }

      if (optionalRecoverable.length > 0) {
        params.app.log.info(
          { recovered: optionalRecoverable },
          "[CollabOrchestrator] 死锁恢复：跳过 optional 依赖后继续",
        );
        // 恢复成功，继续循环
        continue;
      }

      // 真正的死锁：不可恢复
      const deadlockInfo = {
        remainingAgents: remainingIds,
        unresolvedDeps: remainingIds.map((id) => {
          const agent = agents.find((a) => a.agentId === id);
          return {
            agentId: id,
            waitingFor: (agent?.dependencies ?? []).filter((d) => !completed.has(d)),
          };
        }),
      };
      params.app.log.error(deadlockInfo, "[CollabOrchestrator] 流水线死锁：有剩余 Agent 但无可执行者");

      // 标记所有剩余 Agent 为失败，附带死锁原因
      for (const id of remaining) {
        const s = states.find((x) => x.agentId === id);
        if (s) {
          s.status = "failed";
          s.result = {
            ok: false,
            endReason: "pipeline_deadlock",
            message: `流水线死锁：等待未完成的依赖 ${JSON.stringify(deadlockInfo.unresolvedDeps.find((d) => d.agentId === id)?.waitingFor)}`,
            iterations: 0,
            metadata: { deadlock_info: deadlockInfo },
          } as any;
        }
      }
      break;
    }

    // 并行执行所有就绪的 Agent
    const promises = ready.map(async (state) => {
      state.status = "running";

      // 注入依赖 Agent 的结构化结果（包含已完成的和已失败但被绕过的）
      const agent = agents.find((a) => a.agentId === state.agentId);
      const envelopes = await readCollabEnvelopes({ pool: params.pool, collabRunId: params.collabRunId, toRole: state.role });

      // 结果注入校验：校验每个 envelope 的合法性
      for (const env of envelopes) {
        const validation = validateEnvelope({ agentId: env.fromRole, result: env.payloadDigest });
        if (!validation.valid) {
          logger.warn("envelope validation failed, using empty result", { agentId: env.fromRole, reason: validation.reason });
          env.payloadDigest = { ok: false, message: "", totalSteps: 0, totalIterations: 0, observations: [] };
        }
      }

      const structuredContext = buildEnvelopeContext(envelopes);
      const depResults = (agent?.dependencies ?? [])
        .map((depId) => {
          const depState = states.find((s) => s.agentId === depId);
          if (!depState || !depState.result) return null;
          // 校验依赖 Agent 结果
          const depValidation = validateEnvelope({ agentId: depId, result: depState.result });
          if (!depValidation.valid) {
            logger.warn("envelope validation failed, using empty result", { agentId: depId, reason: depValidation.reason });
            return null;
          }
          return depState.status === "done" ? `[${depState.role}]: ${depState.result.message}` : null;
        })
        .filter((s): s is string => !!s)
        .join("\n");
      const enhancedGoal = depResults
        ? `${state.goal}\n\n## Input from Dependent Agents\n${depResults}${structuredContext}`
        : structuredContext
          ? `${state.goal}${structuredContext}`
          : state.goal;

      try {
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
      } catch (agentErr: unknown) {
        // Agent级failover：中间节点失败时标记为failed并绕过（让completed也包含它以解除下游依赖）
        const errMsg = agentErr instanceof Error ? agentErr.message : String(agentErr);
        params.app.log.warn({
          agentId: state.agentId, role: state.role, err: errMsg,
        }, "[CollabOrchestrator] 流水线Agent执行失败，尝试绕过继续");
        state.status = "failed";
        state.result = {
          ok: false,
          endReason: "error",
          message: `Agent执行异常: ${errMsg}`,
          iterations: 0,
          succeededSteps: 0,
          failedSteps: 0,
          observations: [],
          lastDecision: null,
        };
      }

      // 将结果写入 collab_envelopes 供下游 Agent 查询
      const pipResult = state.result!;
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
        result: pipResult,
        runId: state.runId,
      });

      // 无论成功失败都标记为completed以解除下游依赖阻塞
      completed.add(state.agentId);
      remaining.delete(state.agentId);
    });

    await Promise.all(promises);
  }
}
