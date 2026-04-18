/**
 * Collab Orchestrator — 协作规划 + 单Agent回退
 *
 * 让 LLM 分析目标并制定协作计划（CollabPlan），
 * 若规划失败则回退到单 Agent 执行。
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { invokeModelChat, type LlmSubject } from "../lib/llm";
import { runAgentLoop } from "./agentLoop";
import type { WorkflowQueue } from "../modules/workflow/queue";
import { setCollabRunPrimaryRun, updateCollabRunStatus } from "../modules/agentRuntime/collabRepo";
import type { CollabAgentRole, CollabPlan, CollabOrchestratorParams, CollabResult } from "./collabTypes";
import { writeCollabEnvelope } from "./collabEnvelope";
import { queryRolePerformanceHistory } from "./collabValidation";

// ── 单Agent回退 ──────────────────────────────────────────────────

export async function runSingleAgentFallback(params: CollabOrchestratorParams): Promise<CollabResult> {
  const { pool, queue, subject, taskId, collabRunId, goal } = params;
  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO runs (run_id, job_id, tenant_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'running', now(), now())`,
    [runId, jobId, subject.tenantId],
  );

  await pool.query(
    `INSERT INTO jobs (job_id, tenant_id, job_type, run_id, input_digest, created_by_subject_id, trigger, status, created_at, updated_at)
     VALUES ($1, $2, 'collab.fallback_agent', $3, $4, $5, 'collab_orchestrator', 'running', now(), now())`,
    [jobId, subject.tenantId, runId, JSON.stringify({ collabRunId, taskId, strategy: "single_agent_fallback", goal }), subject.subjectId],
  );

  await setCollabRunPrimaryRun({ pool, tenantId: subject.tenantId, collabRunId, primaryRunId: runId });
  await updateCollabRunStatus({ pool, tenantId: subject.tenantId, collabRunId, status: "executing" });

  const result = await runAgentLoop({
    ...params,
    runId,
    jobId,
    goal,
    taskId,
  });

  await writeCollabEnvelope({
    pool,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    collabRunId,
    taskId,
    fromRole: "fallback",
    toRole: null,
    broadcast: true,
    kind: "agent.result",
    result,
    runId,
  });

  await updateCollabRunStatus({
    pool,
    tenantId: subject.tenantId,
    collabRunId,
    status: result.ok ? "completed" : "failed",
  });

  return {
    ok: result.ok,
    endReason: result.ok ? "all_done" : "partial_failure",
    agentResults: [
      {
        agentId: "fallback",
        role: "fallback",
        ok: result.ok,
        endReason: result.endReason,
        message: result.message ?? "",
      },
    ],
    message: result.ok
      ? "协作规划失败，已成功回退到单 Agent 执行"
      : `协作规划失败，单 Agent 回退执行未完成: ${result.message ?? result.endReason}`,
  };
}

// ── 协作规划 ─────────────────────────────────────────────────────

/**
 * 让 LLM 分析目标并制定协作计划。
 * LLM 决定需要哪些角色、各自的子目标和执行策略。
 */
export async function planCollaboration(params: {
  app: FastifyInstance;
  subject: LlmSubject & { spaceId: string };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  goal: string;
  toolCatalog: string;
}): Promise<CollabPlan | null> {
  // P1-4: 查询历史角色表现作为角色分配参考
  let roleHistoryHint = "";
  try {
    const pool = params.app.db;
    const roles = ["researcher", "writer", "reviewer", "coder", "planner", "analyst", "executor"];
    const histories: string[] = [];
    for (const role of roles) {
      const h = await queryRolePerformanceHistory({
        pool, tenantId: params.subject.tenantId, spaceId: params.subject.spaceId, role, limit: 5,
      });
      if (h.length > 0) {
        const avgScore = h.reduce((s: number, x: { overallScore: number }) => s + x.overallScore, 0) / h.length;
        histories.push(`${role}: avgScore=${avgScore.toFixed(2)} (${h.length} runs)`);
      }
    }
    if (histories.length > 0) {
      roleHistoryHint = "\n\n## Historical Role Performance\n" + histories.join("\n") + "\nConsider this when assigning roles.";
    }
  } catch { /* 查询失败不影响规划 */ }

  const systemPrompt = `You are the collaboration planner for an intelligent Agent OS.
Your job is to decompose a complex goal into sub-goals and assign them to specialized agents.

Respond with EXACTLY ONE JSON block:

\`\`\`collab_plan
{
  "strategy": "sequential" | "parallel" | "pipeline",
  "reasoning": "Why this strategy is optimal",
  "agents": [
    {
      "agentId": "agent_1",
      "role": "Brief role description",
      "goal": "Specific sub-goal for this agent",
      "dependencies": []
    }
  ]
}
\`\`\`

## Rules
- Use "parallel" when sub-tasks are independent
- Use "sequential" when each step depends on the previous
- Use "pipeline" when agents need to review/refine each other's work
- Keep the number of agents between 2-5
- Each agent's goal must be specific and verifiable
- dependencies[] lists agentIds whose output this agent needs`;

  const userPrompt = `## Goal to decompose
${params.goal}

## Available Tools
${params.toolCatalog}${roleHistoryHint}

Create the optimal collaboration plan.`;

  try {
    const result = await invokeModelChat({
      app: params.app,
      subject: params.subject,
      locale: params.locale,
      authorization: params.authorization,
      traceId: params.traceId,
      purpose: "collab.plan",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const output = result?.outputText ?? "";
    return parseCollabPlan(output);
  } catch (err: any) {
    params.app.log.error({ err }, "[CollabOrchestrator] 规划 LLM 调用失败");
    return null;
  }
}

/** 解析 LLM 输出为 CollabPlan */
function parseCollabPlan(output: string): CollabPlan | null {
  const blockMatch = output.match(/```collab_plan\s*\n?([\s\S]*?)```/);
  const jsonStr = blockMatch ? blockMatch[1].trim() : output.trim();
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const strategy = (["sequential", "parallel", "pipeline"] as const).includes(parsed.strategy)
      ? parsed.strategy
      : "sequential";

    const agents: CollabAgentRole[] = Array.isArray(parsed.agents)
      ? parsed.agents
          .filter((a: any) => a && typeof a === "object" && typeof a.goal === "string")
          .map((a: any) => ({
            agentId: String(a.agentId || `agent_${crypto.randomUUID().slice(0, 8)}`),
            role: String(a.role ?? "executor"),
            goal: String(a.goal),
            dependencies: Array.isArray(a.dependencies) ? a.dependencies.map(String) : [],
          }))
      : [];

    if (agents.length < 2) return null; // 少于 2 个 Agent 不需要协作

    return {
      agents,
      strategy,
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch {
    return null;
  }
}
