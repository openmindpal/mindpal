/**
 * Unified Planning Kernel.
 *
 * Extracts the common "discover tools → build prompt → invoke LLM → parse suggestions → validate"
 * pipeline that was previously duplicated across:
 *   - agent-runtime/routes.ts  (POST /tasks/:taskId/agent-runs)
 *   - collab-runtime/routes.ts (POST /tasks/:taskId/collab-runs)
 *   - orchestrator/orchestrateChatTurn() (discover + catalog section)
 *
 * Each runtime still owns its own request parsing, job/run creation, and response shaping.
 * This kernel provides composable phases:
 *   Phase 1 — discoverEnabledTools() (re-exported from orchestrator for convenience)
 *   Phase 2 — buildPlannerPrompt()
 *   Phase 3 — invokePlannerLlm()
 *   Phase 4 — parsePlanSuggestions()
 *   Full    — runPlanningPipeline()  (all-in-one convenience)
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { isToolAllowedForPolicy } from "@mindpal/shared";
import { assessToolExecutionRisk } from "./approvalRuleEngine";
import { invokeModelChat, parseToolCallsFromOutput, type LlmSubject } from "../lib/llm";
import { discoverEnabledTools, type EnabledTool } from "../modules/agentContext";
import { getToolDefinition, getToolVersionByRef, type ToolDefinition } from "../modules/tools/toolRepo";
import { resolveEffectiveToolRef } from "../modules/tools/resolve";
import { isToolEnabled } from "../modules/governance/toolGovernanceRepo";
import { routeByIntent, type RouteResult } from "../modules/skills/skillRouter";

/* Re-export for convenience so callers only need one import. */
export { discoverEnabledTools, type EnabledTool };

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export interface PlanStep {
  stepId: string;
  actorRole: string;
  kind: "tool";
  toolRef: string;
  inputDraft: Record<string, unknown>;
  dependsOn: string[];
  approvalRequired: boolean;
}

export type PlanFailureCategory =
  | "model_error"
  | "parse_error"
  | "no_tools"
  | "no_enabled_suggestion"
  | "empty";

export interface PlanningResult {
  ok: boolean;
  planSteps: PlanStep[];
  /** Non-null when ok === false. */
  failureCategory: PlanFailureCategory | null;
  /** Raw model output text (for diagnostics). */
  modelOutputText: string;
  /** Number of raw tool_call blocks parsed from model output. */
  rawSuggestionCount: number;
  /** Number of suggestions that matched enabled tools. */
  filteredSuggestionCount: number;
  /** Tool catalog string used in the prompt. */
  toolCatalog: string;
  /** All enabled tools discovered. */
  enabledTools: EnabledTool[];
  /** Semantic routing result (if applicable). */
  semanticRoute?: RouteResult;
  /** P0-6: Tool calls that were dropped due to validation failure. */
  droppedToolCalls?: DroppedToolCall[];
}

/* ================================================================== */
/*  Phase 2 — Build Planner Prompt                                      */
/* ================================================================== */

export interface BuildPromptParams {
  /** Tool catalog string from discoverEnabledTools(). */
  toolCatalog: string;
  /** Optional: role prefix for the system prompt ("agent" / "collaborative agent"). */
  plannerRole?: string;
  /** Optional: recalled memory context containing existing entity records and their IDs. */
  memoryContext?: string;
  /** Optional: recent task history context. */
  taskContext?: string;
  /** Optional: knowledge base retrieval results. */
  knowledgeContext?: string;
}

/**
 * Build a planner system prompt from a tool catalog.
 * Keeps prompt construction in one place so all runtimes emit the same format.
 */
export function buildPlannerPrompt(params: BuildPromptParams): string {
  const role = params.plannerRole ?? "agent";
  // P2-4: a/an 冠词判断基于发音而非首字母
  const vowelSounds = /^[aeiou]/i;
  const article = vowelSounds.test(role) ? "an" : "a";
  if (!params.toolCatalog) {
    return `You are ${article} ${role} planner. No tools are currently available.`;
  }
  const memorySection = params.memoryContext ? `\n\n## Recalled Memory\n${params.memoryContext}` : "";
  const taskSection = params.taskContext ? `\n\n## Recent Tasks\n${params.taskContext}` : "";
  const knowledgeSection = params.knowledgeContext ? `\n\n## Relevant Knowledge\n${params.knowledgeContext}` : "";
  return `You are ${article} ${role} planner. Given the user message and available tools, suggest which tools to invoke.

## Available Tools
${params.toolCatalog}${memorySection}${taskSection}${knowledgeSection}

Output tool suggestions in this format:
\`\`\`tool_call
[{"toolRef":"<toolRef>","inputDraft":{<key>:<value>}}]
\`\`\`
Only suggest tools from the list above.`;
}

/* ================================================================== */
/*  Phase 3 — Invoke Planner LLM                                       */
/* ================================================================== */

export interface InvokePlannerParams {
  app: FastifyInstance;
  subject: LlmSubject;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  /** Purpose tag for model gateway (e.g. "agent-runtime.plan"). */
  purpose: string;
  systemPrompt: string;
  userMessage: string;
  /** Optional extra headers (e.g. budget headers for collab-runtime). */
  headers?: Record<string, string>;
}

export interface PlannerLlmResult {
  modelOutputText: string;
  modelError: boolean;
}

/**
 * Invoke the model gateway for planning.
 * Returns modelOutputText (empty on failure) and a flag indicating model error.
 */
export async function invokePlannerLlm(params: InvokePlannerParams): Promise<PlannerLlmResult> {
  try {
    const modelOut = await invokeModelChat({
      app: params.app,
      subject: params.subject,
      locale: params.locale,
      authorization: params.authorization,
      traceId: params.traceId,
      purpose: params.purpose,
      headers: params.headers,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userMessage },
      ],
    });
    return {
      modelOutputText: typeof modelOut?.outputText === "string" ? modelOut.outputText : "",
      modelError: false,
    };
  } catch {
    return { modelOutputText: "", modelError: true };
  }
}

/* ================================================================== */
/*  Phase 4 — Parse & Validate Plan Suggestions                        */
/* ================================================================== */

export interface ParseSuggestionsParams {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  modelOutputText: string;
  enabledTools: EnabledTool[];
  /** Max steps to pick from suggestions. Undefined means no platform default cap. */
  maxSteps?: number;
  /** Default actorRole for each plan step. */
  actorRole?: string;
  /** Optional: trace ID for audit logging of dropped tool_calls. */
  traceId?: string | null;
}

/** P0-6: Dropped tool_call record for audit purposes. */
export interface DroppedToolCall {
  toolRef: string;
  reason: "not_enabled" | "not_released" | "not_found" | "invalid_format";
  inputDraft?: Record<string, unknown>;
}

/**
 * Parse tool_call blocks from model output, filter by enabled tools,
 * then validate each by resolving toolRef, checking version/enabled status,
 * and reading the tool definition.
 *
 * Returns an array of validated PlanStep objects.
 */
export async function parsePlanSuggestions(params: ParseSuggestionsParams): Promise<{
  planSteps: PlanStep[];
  rawSuggestionCount: number;
  filteredSuggestionCount: number;
  parseErrorCount: number;
  failureCategory: PlanFailureCategory | null;
  /** P0-6: Tool calls that were dropped due to validation failure. */
  droppedToolCalls: DroppedToolCall[];
}> {
  const { pool, tenantId, spaceId, modelOutputText, enabledTools, maxSteps, traceId } = params;
  const actorRole = params.actorRole ?? "executor";

  const parsed = parseToolCallsFromOutput(modelOutputText);
  const enabledToolRefSet = new Set(enabledTools.map((t) => t.toolRef));
  
  // P0-6: 强制校验 - 静默丢弃未启用的工具调用并记录
  const droppedToolCalls: DroppedToolCall[] = [];
  const suggestions: Array<{ toolRef: string; inputDraft: Record<string, unknown> }> = [];
  
  for (const tc of parsed.toolCalls) {
    if (enabledToolRefSet.has(tc.toolRef) || isToolAllowedForPolicy(enabledToolRefSet, tc.toolRef)) {
      suggestions.push(tc);
    } else {
      droppedToolCalls.push({ toolRef: tc.toolRef, reason: "not_enabled", inputDraft: tc.inputDraft });
    }
  }
  
  const picked = typeof maxSteps === "number" ? suggestions.slice(0, Math.max(0, maxSteps)) : suggestions;

  let failureCategory: PlanFailureCategory | null = null;
  if (parsed.parseErrorCount > 0 && !picked.length) {
    failureCategory = "parse_error";
  }

  const planSteps: PlanStep[] = [];
  for (const s of picked) {
    const rawToolRef = typeof s?.toolRef === "string" ? String(s.toolRef) : "";
    if (!rawToolRef) continue;
    const at = rawToolRef.lastIndexOf("@");
    const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
    const effToolRef =
      at > 0
        ? rawToolRef
        : await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: toolName });
    if (!effToolRef) continue;

    const ver = await getToolVersionByRef(pool, tenantId, effToolRef);
    if (!ver || String(ver.status) !== "released") {
      droppedToolCalls.push({ toolRef: rawToolRef, reason: ver ? "not_released" : "not_found", inputDraft: s.inputDraft });
      continue;
    }

    const enabled = await isToolEnabled({ pool, tenantId, spaceId, toolRef: effToolRef });
    if (!enabled) {
      droppedToolCalls.push({ toolRef: effToolRef, reason: "not_enabled", inputDraft: s.inputDraft });
      continue;
    }

    const def = await getToolDefinition(pool, tenantId, toolName);
    const approvalRequired = (await assessToolExecutionRisk({
      pool, tenantId, toolRef: effToolRef,
      inputDraft: s?.inputDraft && typeof s.inputDraft === "object" && !Array.isArray(s.inputDraft) ? (s.inputDraft as Record<string, unknown>) : {},
      toolDefinition: def ? { riskLevel: def.riskLevel as any, approvalRequired: def.approvalRequired, scope: def.scope ?? undefined } : undefined,
    })).approvalRequired;
    const inputDraft =
      s?.inputDraft && typeof s.inputDraft === "object" && !Array.isArray(s.inputDraft)
        ? (s.inputDraft as Record<string, unknown>)
        : {};

    planSteps.push({
      stepId: crypto.randomUUID(),
      actorRole,
      kind: "tool",
      toolRef: effToolRef,
      inputDraft,
      dependsOn: [],
      approvalRequired,
    });
  }

  // P0-6: 审计日志 - 记录被丢弃的工具调用（用于调试和安全分析）
  if (droppedToolCalls.length > 0 && traceId) {
    // Note: 实际日志记录由调用方处理，这里仅返回数据
  }

  return {
    planSteps,
    rawSuggestionCount: parsed.toolCalls.length,
    filteredSuggestionCount: suggestions.length,
    parseErrorCount: parsed.parseErrorCount,
    failureCategory,
    droppedToolCalls,
  };
}

/* ================================================================== */
/*  Full Pipeline — convenience all-in-one                              */
/* ================================================================== */

export interface RunPlanningParams {
  app: FastifyInstance;
  pool: Pool;
  subject: LlmSubject;
  spaceId: string;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  /** User message to plan for. */
  userMessage: string;
  /** Max steps to produce. Undefined means no platform default cap. */
  maxSteps?: number;
  /** Purpose tag for model gateway. */
  purpose?: string;
  /** Planner role label (default "agent"). */
  plannerRole?: string;
  /** Default actor role for plan steps (default "executor"). */
  actorRole?: string;
  /** Extra headers passed to model gateway (e.g. budget). */
  headers?: Record<string, string>;
  /** Optional: recalled memory context (existing entity records with IDs). */
  memoryContext?: string;
  /** Optional: recent task history context. */
  taskContext?: string;
  /** Optional: knowledge base retrieval results. */
  knowledgeContext?: string;
}

/**
 * Run the full planning pipeline: discover → prompt → LLM → parse → validate.
 *
 * Returns a PlanningResult indicating success or categorized failure.
 */
export async function runPlanningPipeline(params: RunPlanningParams): Promise<PlanningResult> {
  const {
    app, pool, subject, spaceId, locale, authorization, traceId,
    userMessage, maxSteps, actorRole,
  } = params;
  const purpose = params.purpose ?? "agent-runtime.plan";
  const plannerRole = params.plannerRole ?? "agent";
  const pipelineStartMs = Date.now();

  // Phase 1: discover enabled tools
  const toolDiscovery = await discoverEnabledTools({ pool, tenantId: subject.tenantId, spaceId, locale });

  // Phase 1.5: Semantic pre-routing (optional enhancement)
  let semanticRoute: RouteResult | undefined;
  try {
    semanticRoute = await routeByIntent({ pool, tenantId: subject.tenantId, intent: userMessage });
  } catch {
    // Semantic routing is optional, continue without it
  }

  // If semantic routing found a high-confidence match, prioritize it in the prompt
  let enhancedCatalog = toolDiscovery.catalog;
  if (semanticRoute?.resolved && semanticRoute.bestMatch) {
    const priorityNote = `\n\n[Priority Match] Based on semantic analysis, "${semanticRoute.bestMatch.skillName}" is highly recommended (${Math.round(semanticRoute.confidence * 100)}% match).`;
    enhancedCatalog = toolDiscovery.catalog + priorityNote;
  } else if (semanticRoute?.ambiguous && semanticRoute.candidates.length > 1) {
    const ambiguityNote = `\n\n[Ambiguity] Multiple similar tools detected: ${semanticRoute.candidates.map(c => c.skillName).join(", ")}. Please choose the most appropriate one.`;
    enhancedCatalog = toolDiscovery.catalog + ambiguityNote;
  }

  // Phase 2: build planner prompt (use enhanced catalog with semantic hints)
  const systemPrompt = buildPlannerPrompt({ toolCatalog: enhancedCatalog, plannerRole, memoryContext: params.memoryContext, taskContext: params.taskContext, knowledgeContext: params.knowledgeContext });

  // Phase 3: invoke LLM
  const llmResult = await invokePlannerLlm({
    app, subject, locale, authorization, traceId,
    purpose, systemPrompt, userMessage,
    headers: params.headers,
  });

  let failureCategory: PlanFailureCategory | null = null;
  if (llmResult.modelError) {
    failureCategory = "model_error";
  }

  // Phase 4: parse & validate suggestions (P0-6: 强制校验并记录丢弃)
  const parseResult = await parsePlanSuggestions({
    pool, tenantId: subject.tenantId, spaceId,
    modelOutputText: llmResult.modelOutputText,
    enabledTools: toolDiscovery.tools,
    maxSteps,
    actorRole,
    traceId,
  });

  // P0-6: 审计日志 - 记录被丢弃的工具调用
  if (parseResult.droppedToolCalls.length > 0) {
    app.log.warn({ 
      traceId, 
      droppedCount: parseResult.droppedToolCalls.length,
      dropped: parseResult.droppedToolCalls.map(d => ({ toolRef: d.toolRef, reason: d.reason })),
    }, "[P0-6] tool_call 强制校验: 工具调用被静默丢弃");
  }

  // Determine failure category if no steps produced
  if (!parseResult.planSteps.length) {
    if (!failureCategory) {
      failureCategory =
        parseResult.failureCategory ??
        (!toolDiscovery.tools.length
          ? "no_tools"
          : parseResult.rawSuggestionCount > 0 && parseResult.filteredSuggestionCount === 0
            ? "no_enabled_suggestion"
            : "empty");
    }
    // P0-2: 规划流水线失败指标
    app.metrics.observePlanningPipeline({
      result: (failureCategory ?? "empty") as "ok" | "error" | "no_tools" | "no_enabled_suggestion" | "empty",
      latencyMs: Date.now() - pipelineStartMs,
      stepCount: 0,
      droppedCount: parseResult.droppedToolCalls.length,
      semanticRouteUsed: !!semanticRoute?.resolved,
    });
    return {
      ok: false,
      planSteps: [],
      failureCategory,
      modelOutputText: llmResult.modelOutputText,
      rawSuggestionCount: parseResult.rawSuggestionCount,
      filteredSuggestionCount: parseResult.filteredSuggestionCount,
      toolCatalog: toolDiscovery.catalog,
      enabledTools: toolDiscovery.tools,
      semanticRoute,
      droppedToolCalls: parseResult.droppedToolCalls,
    };
  }

  // P0-2: 规划流水线成功指标
  app.metrics.observePlanningPipeline({
    result: "ok",
    latencyMs: Date.now() - pipelineStartMs,
    stepCount: parseResult.planSteps.length,
    droppedCount: parseResult.droppedToolCalls.length,
    semanticRouteUsed: !!semanticRoute?.resolved,
  });

  return {
    ok: true,
    planSteps: parseResult.planSteps,
    failureCategory: null,
    modelOutputText: llmResult.modelOutputText,
    rawSuggestionCount: parseResult.rawSuggestionCount,
    filteredSuggestionCount: parseResult.filteredSuggestionCount,
    toolCatalog: toolDiscovery.catalog,
    enabledTools: toolDiscovery.tools,
    semanticRoute,
    droppedToolCalls: parseResult.droppedToolCalls,
  };
}
