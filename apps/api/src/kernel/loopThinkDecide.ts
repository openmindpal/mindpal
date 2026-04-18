/**
 * Agent Loop — Think + Decide 阶段
 *
 * 包含 LLM 决策 prompt 构建、输出解析、执行约束辅助函数。
 */
import type { AgentDecision, AgentDecisionAction, ExecutionConstraints, StepObservation } from "./loopTypes";
import type { EnabledTool } from "../modules/agentContext";
import { compressStepHistory, renderCompressedSteps, renderRecentSteps } from "./loopObservation";
import { StructuredLogger } from "@openslin/shared";

const logger = new StructuredLogger({ module: "loopThinkDecide" });

/* ================================================================== */
/*  Constraint helpers                                                   */
/* ================================================================== */

export function normalizeExecutionConstraints(v: ExecutionConstraints | undefined): ExecutionConstraints | undefined {
  if (!v) return undefined;
  const allowedTools = Array.isArray(v.allowedTools)
    ? Array.from(new Set(v.allowedTools.map((x) => String(x).trim()).filter(Boolean)))
    : undefined;
  const allowWrites = typeof v.allowWrites === "boolean" ? v.allowWrites : undefined;
  if ((!allowedTools || allowedTools.length === 0) && allowWrites === undefined) return undefined;
  return { ...(allowedTools?.length ? { allowedTools } : {}), ...(allowWrites !== undefined ? { allowWrites } : {}) };
}

export function formatToolCatalog(tools: EnabledTool[], locale: string): string {
  return tools.map((tool) => {
    const displayName = typeof tool.def.displayName === "string"
      ? tool.def.displayName
      : String((tool.def.displayName as any)?.[locale] ?? (tool.def.displayName as any)?.["zh-CN"] ?? tool.name);
    const description = typeof tool.def.description === "string"
      ? tool.def.description
      : String((tool.def.description as any)?.[locale] ?? (tool.def.description as any)?.["zh-CN"] ?? "");
    return `- ${tool.toolRef} (${displayName}) [${tool.def.scope}/${tool.def.riskLevel}]${description ? ` - ${description}` : ""}`;
  }).join("\n");
}

export function isToolAllowedByConstraints(resolved: {
  toolRef: string;
  toolName: string;
  scope: "read" | "write";
}, constraints?: ExecutionConstraints): { ok: true } | { ok: false; reason: string } {
  if (!constraints) return { ok: true };
  if (constraints.allowWrites === false && resolved.scope === "write") {
    return { ok: false, reason: `write_blocked:${resolved.toolRef}` };
  }
  const allowed = constraints.allowedTools;
  if (allowed?.length) {
    const match = allowed.includes(resolved.toolRef) || allowed.includes(resolved.toolName);
    if (!match) return { ok: false, reason: `tool_not_allowed:${resolved.toolRef}` };
  }
  return { ok: true };
}

export function filterToolDiscoveryByConstraints(
  toolDiscovery: { catalog: string; tools: EnabledTool[] },
  locale: string,
  constraints?: ExecutionConstraints,
): { catalog: string; tools: EnabledTool[] } {
  if (!constraints) return toolDiscovery;
  const tools = toolDiscovery.tools.filter((tool) => {
    const allowed = isToolAllowedByConstraints(
      { toolRef: tool.toolRef, toolName: tool.name, scope: tool.def.scope as "read" | "write" },
      constraints,
    );
    return allowed.ok;
  });
  return { tools, catalog: formatToolCatalog(tools, locale) };
}

/* ================================================================== */
/*  Think — 构建 LLM 决策 prompt                                       */
/* ================================================================== */

export function buildThinkPrompt(params: {
  goal: string;
  toolCatalog: string;
  executionConstraints?: ExecutionConstraints;
  completedSteps: StepObservation[];
  lastObservation: StepObservation | null;
  userIntervention?: string;
  /** 跨 Run 记忆上下文（来自长期记忆检索） */
  memoryContext?: string;
  /** 最近任务历史（来自 task_states 召回） */
  taskHistory?: string;
  /** 知识库上下文（来自知识库主动召回） */
  knowledgeContext?: string;
  /** P2: 策略上下文（来自 procedural 级主动学习记忆） */
  strategyContext?: string;
  /** P2-触发器: 环境状态上下文（设备/模型/连接器状态摘要） */
  environmentContext?: string;
}): { systemPrompt: string; userPrompt: string } {
  const { goal, toolCatalog, executionConstraints, completedSteps, lastObservation, userIntervention, memoryContext, taskHistory, knowledgeContext, strategyContext, environmentContext } = params;

  const constraintLines: string[] = [];
  if (executionConstraints?.allowedTools?.length) {
    constraintLines.push(`- You may only call these tools: ${executionConstraints.allowedTools.join(", ")}`);
  }
  if (executionConstraints?.allowWrites === false) {
    constraintLines.push("- You must not call any write tool or perform side-effecting actions");
  }

  const systemPrompt = `You are the decision-making core of an intelligent Agent OS. Your role is to analyze the current state and decide the NEXT action to achieve the user's goal.

## Available Tools
${toolCatalog || "(No tools available)"}

${constraintLines.length ? `## Execution Constraints\n${constraintLines.join("\n")}\n` : ""}

## Decision Protocol
After analyzing the situation, respond with EXACTLY ONE JSON block:

\`\`\`agent_decision
{
  "action": "tool_call" | "parallel_tool_calls" | "replan" | "done" | "ask_user" | "abort",
  "reasoning": "Your step-by-step analysis of the current situation",
  "toolRef": "(only for tool_call) the tool to invoke",
  "inputDraft": { (only for tool_call) tool input parameters },
  "parallelCalls": [ (only for parallel_tool_calls) {"toolRef":"...","inputDraft":{...}}, ... ],
  "summary": "(only for done) summary of what was accomplished",
  "question": "(only for ask_user) what you need to know from the user",
  "abortReason": "(only for abort) why the goal cannot be achieved"
}
\`\`\`

## Decision Rules
- If the goal is achieved → "done"
- If the last step failed and you can try a different approach → "tool_call" with adjusted params
- If the last step failed with a non-recoverable error → "abort"
- If you need more information from the user → "ask_user"
- If the current plan is no longer suitable → "replan"
- If you can make progress toward the goal → "tool_call"
- If multiple INDEPENDENT tools can run simultaneously → "parallel_tool_calls" (only when no data dependencies between them)
- NEVER repeat a failed tool call with identical parameters
- ALWAYS explain your reasoning before deciding
- When the user's goal contains multiple parts or implies a sequence of outcomes, you MUST address each part before returning "done". After completing any step, re-examine the ORIGINAL goal — if there are unaddressed parts, continue with the next action. Only return "done" when every aspect of the user's intent has been fulfilled`;

  // Build the user prompt with full context
  let userPrompt = `## User's Goal\n${goal}\n`;

  if (completedSteps.length > 0) {
    const { compressed, recent, totalCount } = compressStepHistory(completedSteps);
    userPrompt += `\n## Completed Steps (${totalCount} total)\n`;
    if (compressed.length > 0) {
      userPrompt += renderCompressedSteps(compressed);
    }
    if (recent.length > 0) {
      userPrompt += renderRecentSteps(recent);
    }
  }

  if (lastObservation) {
    userPrompt += `\n## Last Step Result (most recent)\n`;
    userPrompt += `Tool: ${lastObservation.toolRef}\n`;
    userPrompt += `Status: ${lastObservation.status}\n`;
    if (lastObservation.errorCategory) {
      userPrompt += `Error: ${lastObservation.errorCategory}\n`;
    }
    // P0-FIX: 优先展示工具实际输出，LLM 需要看到的是 memory.read 的 evidence，而不是 latencyMs/egressCount 等无用元数据
    const lastOutputData = lastObservation.output ?? lastObservation.outputDigest;
    if (lastOutputData) {
      userPrompt += `Output: ${JSON.stringify(lastOutputData).slice(0, 800)}\n`;
    }
  }

  if (memoryContext) {
    userPrompt += `\n## Relevant Memory (from past interactions)\n${memoryContext}\n`;
  }
  if (knowledgeContext) {
    userPrompt += `
## Relevant Knowledge (from knowledge base)
${knowledgeContext}
Use this knowledge as reference when making decisions.
`;
  }
  if (strategyContext) {
    userPrompt += `
## Strategy Recommendations (self-learned from past executions)
The following strategies were automatically derived from analyzing past task executions. Apply them when relevant:
${strategyContext}
`;
  }

  if (taskHistory) {
    userPrompt += `
## Recent Task History
${taskHistory}
Use this history to avoid repeating past mistakes and leverage known solutions.
`;
  }

  if (environmentContext) {
    userPrompt += `
## Environment Status (live)
The following is the current state of your operating environment. Consider these constraints when making decisions:
${environmentContext}
`;
  }

  if (userIntervention) {
    userPrompt += `
## ⚠️ User Intervention (HIGHEST PRIORITY)
The user just said: "${userIntervention}"
You MUST address this message before continuing the original plan.
`;
  }

  userPrompt += `\nBased on the above, what is your next decision?`;

  return { systemPrompt, userPrompt };
}

/* ================================================================== */
/*  Decide — 解析 LLM 输出为结构化决策                                   */
/* ================================================================== */

export function parseAgentDecision(modelOutput: string): AgentDecision {
  // 尝试解析 ```agent_decision ... ``` 块
  const blockMatch = modelOutput.match(/```agent_decision\s*\n?([\s\S]*?)```/);
  const jsonStr = blockMatch ? blockMatch[1].trim() : modelOutput.trim();

  // 尝试提取 JSON
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return buildDecisionFromParsed(parsed);
    } catch {
      // JSON 解析失败，尝试修复常见问题
    }
  }

  // P0-FIX: 增强容错——如果 blockMatch 失败，直接从原始输出中查找 JSON
  if (!blockMatch) {
    const rawJsonMatch = modelOutput.match(/\{[\s\S]*\}/);
    if (rawJsonMatch) {
      try {
        const parsed = JSON.parse(rawJsonMatch[0]);
        if (parsed.action) return buildDecisionFromParsed(parsed);
      } catch {
        // 8.2 FIX: 不再尝试修复截断的 JSON（补全右花括号可能产生非法字段值，
        // 导致 tool_call 调用无效工具或错误参数），直接落入 abort 安全路径
        logger.warn(`JSON 解析失败，跳过截断修复，走 abort 路径: ${rawJsonMatch[0].slice(0, 200)}`);
      }
    }
  }

  // 兆底：无法解析时降级为 replan，而非直接 abort——
  // 给 Agent 一次重新规划的机会，避免因 LLM 输出截断导致任务直接终止
  logger.warn(`无法解析 LLM 决策输出，降级为 replan: ${modelOutput.slice(0, 300)}`);
  return {
    action: "replan",
    reasoning: "LLM decision output was unparseable; falling back to replan instead of abort",
    abortReason: `unparseable_output: ${modelOutput.slice(0, 200)}`,
  };
}

function buildDecisionFromParsed(parsed: any): AgentDecision {
  const action = (["tool_call", "parallel_tool_calls", "replan", "done", "ask_user", "abort"] as const).includes(parsed.action)
    ? parsed.action
    : "abort";

  // 解析 parallelCalls
  let parallelCalls: AgentDecision["parallelCalls"] | undefined;
  if (action === "parallel_tool_calls" && Array.isArray(parsed.parallelCalls)) {
    parallelCalls = parsed.parallelCalls
      .filter((c: any) => c && typeof c === "object" && typeof c.toolRef === "string")
      .map((c: any) => ({
        toolRef: String(c.toolRef),
        inputDraft: c.inputDraft && typeof c.inputDraft === "object" ? c.inputDraft : {},
      }));
    if (parallelCalls && !parallelCalls.length) parallelCalls = undefined;
  }

  return {
    action,
    reasoning: String(parsed.reasoning ?? ""),
    toolRef: typeof parsed.toolRef === "string" ? parsed.toolRef : undefined,
    inputDraft: parsed.inputDraft && typeof parsed.inputDraft === "object" ? parsed.inputDraft : undefined,
    parallelCalls,
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    question: typeof parsed.question === "string" ? parsed.question : undefined,
    abortReason: typeof parsed.abortReason === "string" ? parsed.abortReason : undefined,
  };
}
