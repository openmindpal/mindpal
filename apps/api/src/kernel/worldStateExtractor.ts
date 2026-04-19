/**
 * World State Extractor — 从工具执行结果提取结构化世界状态
 *
 * 每个 StepObservation 完成后调用，将工具输出增量提取到 WorldState：
 * - 实体识别（新建/修改了什么实体）
 * - 关系提取（实体间产生了什么关系）
 * - 事实更新（环境中发生了什么变化）
 *
 * 提取策略：
 * - 规则提取（无需 LLM）：从 tool_output 结构化数据中直接提取
 * - LLM 辅助提取（可选）：对非结构化输出调用 LLM 提取实体/关系/事实
 * - GoalGraph 条件评估：根据 WorldState 更新 GoalCondition.satisfied
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  WorldState, WorldEntity, WorldRelation, WorldFact,
  GoalGraph, GoalCondition, SuccessCriterion,
} from "@openslin/shared";
import {
  createWorldState, upsertEntity, addRelation, upsertFact,
} from "@openslin/shared";
import type { StepObservation } from "./agentLoop";
import { invokeModelChat, type LlmSubject } from "../lib/llm";

/* ================================================================== */
/*  规则提取器 — 从结构化工具输出直接提取                                  */
/* ================================================================== */

/**
 * 从 StepObservation 的结构化输出中提取实体、关系、事实
 * 这是零 LLM 调用的规则提取，基于 output 字段的结构推断
 */
export function extractFromObservation(
  obs: StepObservation,
  currentState: WorldState,
): WorldState {
  const now = new Date().toISOString();
  let state = { ...currentState };

  // 从 output 和 outputDigest 中提取
  const output = obs.output ?? obs.outputDigest ?? {};
  const toolRef = obs.toolRef;

  // 通用事实：步骤执行结果
  state = upsertFact(state, {
    factId: crypto.randomUUID(),
    category: "observation",
    key: `step:${obs.seq}:result`,
    statement: `Step ${obs.seq} (${toolRef}) ${obs.status}${obs.errorCategory ? ` with error: ${obs.errorCategory}` : ""}`,
    value: { status: obs.status, toolRef, errorCategory: obs.errorCategory },
    sourceStepSeq: obs.seq,
    sourceToolRef: toolRef,
    confidence: 1.0,
    valid: true,
    recordedAt: now,
  });

  if (obs.status !== "succeeded") {
    // 失败步骤只记录事实，不提取实体
    return state;
  }

  // 按工具类型做规则提取
  const toolName = toolRef.split("@")[0] ?? toolRef;

  // entity.create / entity.update — 实体操作
  if (toolName.startsWith("entity.")) {
    state = extractEntityToolOutput(state, obs, output, now);
  }

  // memory.write / memory.read — 记忆操作
  if (toolName.startsWith("memory.")) {
    state = extractMemoryToolOutput(state, obs, output, now);
  }

  // knowledge.search — 知识库搜索
  if (toolName.startsWith("knowledge.")) {
    state = extractKnowledgeToolOutput(state, obs, output, now);
  }

  // 通用提取：如果输出包含常见结构化字段
  state = extractGenericOutput(state, obs, output, now);

  // 更新元数据（version 已由 upsertFact/upsertEntity 自动递增，此处仅更新序号和时间戳）
  state = {
    ...state,
    afterIteration: Math.max(state.afterIteration, obs.seq),
    afterStepSeq: Math.max(state.afterStepSeq, obs.seq),
    updatedAt: now,
  };

  return state;
}

/** 从实体工具输出中提取 */
function extractEntityToolOutput(
  state: WorldState,
  obs: StepObservation,
  output: Record<string, unknown>,
  now: string,
): WorldState {
  const toolName = (obs.toolRef.split("@")[0] ?? "").toLowerCase();
  const entityData = output as Record<string, unknown>;

  // 尝试提取实体 ID 和名称
  const entityId = String(
    entityData.entityId ?? entityData.entity_id ?? entityData.id ?? entityData.recordId ?? crypto.randomUUID(),
  );
  const entityName = String(
    entityData.entityName ?? entityData.entity_name ?? entityData.name ?? entityData.title ?? `entity:${entityId.slice(0, 8)}`,
  );

  const action = toolName.includes("create") ? "created"
    : toolName.includes("update") ? "modified"
    : toolName.includes("delete") ? "deleted"
    : "observed";

  const entity: WorldEntity = {
    entityId,
    name: entityName,
    category: "resource",
    properties: extractSafeProperties(entityData),
    state: action,
    sourceStepSeq: obs.seq,
    sourceToolRef: obs.toolRef,
    confidence: 1.0,
    discoveredAt: now,
    updatedAt: now,
  };

  state = upsertEntity(state, entity);

  // 事实
  state = upsertFact(state, {
    factId: crypto.randomUUID(),
    category: "observation",
    key: `entity:${entityId}:${action}`,
    statement: `Entity "${entityName}" was ${action}`,
    value: { entityId, action },
    relatedEntityIds: [entityId],
    sourceStepSeq: obs.seq,
    sourceToolRef: obs.toolRef,
    confidence: 1.0,
    valid: true,
    recordedAt: now,
  });

  return state;
}

/** 从记忆工具输出中提取 */
function extractMemoryToolOutput(
  state: WorldState,
  obs: StepObservation,
  output: Record<string, unknown>,
  now: string,
): WorldState {
  const toolName = (obs.toolRef.split("@")[0] ?? "").toLowerCase();

  if (toolName.includes("write")) {
    const memoryId = String(output.memoryId ?? output.memory_id ?? output.id ?? "");
    if (memoryId) {
      state = upsertEntity(state, {
        entityId: `memory:${memoryId}`,
        name: String(output.title ?? `memory:${memoryId.slice(0, 8)}`),
        category: "artifact",
        properties: { type: output.type, scope: output.scope },
        state: "created",
        sourceStepSeq: obs.seq,
        sourceToolRef: obs.toolRef,
        confidence: 1.0,
        discoveredAt: now,
        updatedAt: now,
      });
    }
  }

  if (toolName.includes("read") || toolName.includes("search")) {
    // 记忆查询结果作为事实
    const entries = Array.isArray(output.entries) ? output.entries
      : Array.isArray(output.results) ? output.results
      : [];
    for (const entry of entries.slice(0, 5)) {
      const e = entry as Record<string, unknown>;
      state = upsertFact(state, {
        factId: crypto.randomUUID(),
        category: "observation",
        key: `memory:recalled:${e.id ?? crypto.randomUUID()}`,
        statement: `Recalled memory: ${String(e.title ?? e.content_text ?? "").slice(0, 200)}`,
        value: { memoryId: e.id, type: e.type },
        sourceStepSeq: obs.seq,
        sourceToolRef: obs.toolRef,
        confidence: typeof e.confidence === "number" ? (e.confidence as number) : 0.8,
        valid: true,
        recordedAt: now,
      });
    }
  }

  return state;
}

/** 从知识库工具输出中提取 */
function extractKnowledgeToolOutput(
  state: WorldState,
  obs: StepObservation,
  output: Record<string, unknown>,
  now: string,
): WorldState {
  const results = Array.isArray(output.results) ? output.results
    : Array.isArray(output.chunks) ? output.chunks
    : [];

  for (const result of results.slice(0, 5)) {
    const r = result as Record<string, unknown>;
    state = upsertFact(state, {
      factId: crypto.randomUUID(),
      category: "observation",
      key: `knowledge:${r.chunkId ?? r.id ?? crypto.randomUUID()}`,
      statement: `Knowledge found: ${String(r.snippet ?? r.text ?? "").slice(0, 200)}`,
      value: { documentId: r.documentId, chunkId: r.chunkId, score: r.score },
      sourceStepSeq: obs.seq,
      sourceToolRef: obs.toolRef,
      confidence: typeof r.score === "number" ? Math.min(1, r.score as number) : 0.7,
      valid: true,
      recordedAt: now,
    });
  }

  return state;
}

/** 通用结构化输出提取 */
function extractGenericOutput(
  state: WorldState,
  obs: StepObservation,
  output: Record<string, unknown>,
  now: string,
): WorldState {
  // 如果输出包含 status / success 字段
  if (typeof output.success === "boolean") {
    state = upsertFact(state, {
      factId: crypto.randomUUID(),
      category: "observation",
      key: `tool:${obs.toolRef}:seq${obs.seq}:success`,
      statement: `Tool ${obs.toolRef} ${output.success ? "succeeded" : "failed"}${output.message ? `: ${String(output.message).slice(0, 200)}` : ""}`,
      value: { success: output.success, message: output.message },
      sourceStepSeq: obs.seq,
      sourceToolRef: obs.toolRef,
      confidence: 1.0,
      valid: true,
      recordedAt: now,
    });
  }

  // 如果输出包含 data / result 字段，作为实体捕获
  const dataPayload = output.data ?? output.result;
  if (dataPayload && typeof dataPayload === "object" && !Array.isArray(dataPayload)) {
    const dp = dataPayload as Record<string, unknown>;
    const id = String(dp.id ?? dp.entityId ?? dp.recordId ?? `result:${obs.seq}`);
    state = upsertEntity(state, {
      entityId: id,
      name: String(dp.name ?? dp.title ?? `result:${obs.toolRef}:${obs.seq}`),
      category: "artifact",
      properties: extractSafeProperties(dp),
      state: "observed",
      sourceStepSeq: obs.seq,
      sourceToolRef: obs.toolRef,
      confidence: 0.8,
      discoveredAt: now,
      updatedAt: now,
    });
  }

  return state;
}

/** 安全地提取属性（限制深度和大小） */
function extractSafeProperties(data: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(data)) {
    if (count >= 20) break; // 最多 20 个属性
    if (key === "input" || key === "payload" || key === "raw") continue; // 跳过大型原始字段
    if (typeof value === "string" && value.length > 500) {
      safe[key] = value.slice(0, 500) + "...";
    } else if (typeof value === "object" && value !== null) {
      safe[key] = JSON.stringify(value).slice(0, 200);
    } else {
      safe[key] = value;
    }
    count++;
  }
  return safe;
}

/* ================================================================== */
/*  LLM 辅助提取（可选增强）                                             */
/* ================================================================== */

export interface LlmExtractParams {
  app: FastifyInstance;
  subject: LlmSubject;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  observation: StepObservation;
  currentState: WorldState;
  defaultModelRef?: string;
}

/**
 * 使用 LLM 从非结构化工具输出中提取实体/关系/事实
 * 仅在 output 为非结构化文本或规则提取不充分时使用
 */
export async function llmExtractWorldState(params: LlmExtractParams): Promise<WorldState> {
  const { app, subject, locale, authorization, traceId, observation, defaultModelRef } = params;
  let state = params.currentState;
  const now = new Date().toISOString();

  // 环境变量开关
  if ((process.env.AGENT_LOOP_LLM_EXTRACT ?? "0") !== "1") {
    return state;
  }

  const outputText = JSON.stringify(observation.output ?? observation.outputDigest ?? {}).slice(0, 2000);

  try {
    const systemPrompt = `You are a World State extraction engine. Given a tool execution result, extract entities, relations, and facts.

Output EXACTLY ONE JSON block:
\`\`\`world_state_delta
{
  "entities": [{ "name": "...", "category": "resource|actor|artifact|configuration|external", "state": "created|modified|deleted|active", "properties": {} }],
  "relations": [{ "from": "entity_name", "to": "entity_name", "type": "created_by|depends_on|contains|modifies|references|produces|consumes", "description": "..." }],
  "facts": [{ "category": "observation|inference", "key": "unique_key", "statement": "..." }]
}
\`\`\`
Only extract what is clearly present in the output. Do not hallucinate.`;

    const userPrompt = `Tool: ${observation.toolRef}\nStatus: ${observation.status}\nOutput:\n${outputText}`;

    const result = await invokeModelChat({
      app, subject, locale, authorization, traceId,
      purpose: "agent.loop.extract",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      ...(defaultModelRef ? { constraints: { candidates: [defaultModelRef] } } : {}),
    });

    const blockMatch = (result.outputText ?? "").match(/```world_state_delta\s*\n?([\s\S]*?)```/);
    if (!blockMatch) return state;

    const parsed = JSON.parse(blockMatch[1].trim());

    // 提取实体
    if (Array.isArray(parsed.entities)) {
      for (const e of parsed.entities) {
        const entityId = crypto.randomUUID();
        state = upsertEntity(state, {
          entityId,
          name: String(e.name ?? ""),
          category: e.category ?? "custom",
          properties: e.properties ?? {},
          state: String(e.state ?? "observed"),
          sourceStepSeq: observation.seq,
          sourceToolRef: observation.toolRef,
          confidence: 0.7, // LLM 提取置信度较低
          discoveredAt: now,
          updatedAt: now,
        });
      }
    }

    // 提取关系
    if (Array.isArray(parsed.relations)) {
      for (const r of parsed.relations) {
        // 查找实体 ID（按名称匹配）
        const fromEntity = Object.values(state.entities).find((e) => e.name === r.from);
        const toEntity = Object.values(state.entities).find((e) => e.name === r.to);
        if (fromEntity && toEntity) {
          state = addRelation(state, {
            relationId: crypto.randomUUID(),
            fromEntityId: fromEntity.entityId,
            toEntityId: toEntity.entityId,
            type: r.type ?? "references",
            description: r.description,
            sourceStepSeq: observation.seq,
            confidence: 0.6,
            establishedAt: now,
          });
        }
      }
    }

    // 提取事实
    if (Array.isArray(parsed.facts)) {
      for (const f of parsed.facts) {
        state = upsertFact(state, {
          factId: crypto.randomUUID(),
          category: f.category ?? "inference",
          key: String(f.key ?? crypto.randomUUID()),
          statement: String(f.statement ?? ""),
          sourceStepSeq: observation.seq,
          sourceToolRef: observation.toolRef,
          confidence: 0.7,
          valid: true,
          recordedAt: now,
        });
      }
    }
  } catch (err: any) {
    app.log.debug({ err: err?.message, toolRef: observation.toolRef }, "[WorldStateExtractor] LLM 提取失败（降级到规则提取）");
  }

  return state;
}

/* ================================================================== */
/*  GoalGraph 条件评估器                                                */
/* ================================================================== */

/**
 * 根据当前 WorldState 评估 GoalGraph 中所有子目标的条件
 * - 检查前置条件是否满足（解锁 pending 子目标）
 * - 检查后置条件是否满足（标记子目标完成候选）
 * - 更新成功标准的 met 状态
 */
export function evaluateGoalConditions(
  graph: GoalGraph,
  worldState: WorldState,
): GoalGraph {
  const now = new Date().toISOString();
  const updatedGraph = { ...graph, subGoals: [...graph.subGoals], updatedAt: now };

  for (let i = 0; i < updatedGraph.subGoals.length; i++) {
    const goal = { ...updatedGraph.subGoals[i] };

    // 评估前置条件
    goal.preconditions = goal.preconditions.map((pc) => ({
      ...pc,
      satisfied: evaluateCondition(pc, worldState),
      evaluatedAt: now,
    }));

    // 评估后置条件
    goal.postconditions = goal.postconditions.map((pc) => ({
      ...pc,
      satisfied: evaluateCondition(pc, worldState),
      evaluatedAt: now,
    }));

    // 评估成功标准
    goal.successCriteria = goal.successCriteria.map((sc) => ({
      ...sc,
      met: evaluateSuccessCriterion(sc, worldState),
    }));

    goal.updatedAt = now;
    updatedGraph.subGoals[i] = goal;
  }

  // 更新全局成功标准
  updatedGraph.globalSuccessCriteria = updatedGraph.globalSuccessCriteria.map((sc) => ({
    ...sc,
    met: evaluateSuccessCriterion(sc, worldState),
  }));

  return updatedGraph;
}

/** 评估单个条件 */
function evaluateCondition(condition: GoalCondition, state: WorldState): boolean {
  if (!condition.assertionType || !condition.assertionParams) {
    // 纯自然语言条件无法自动评估，保持原状
    return condition.satisfied ?? false;
  }

  const params = condition.assertionParams;

  switch (condition.assertionType) {
    case "entity_exists": {
      const entityName = String(params.entityName ?? "");
      return Object.values(state.entities).some(
        (e) => e.name === entityName && e.state !== "deleted",
      );
    }
    case "entity_state": {
      const entityName = String(params.entityName ?? "");
      const expectedState = String(params.state ?? "");
      return Object.values(state.entities).some(
        (e) => e.name === entityName && e.state === expectedState,
      );
    }
    case "fact_true": {
      const factKey = String(params.factKey ?? "");
      return state.facts.some((f) => f.key === factKey && f.valid);
    }
    case "output_contains": {
      const pattern = String(params.pattern ?? "");
      return state.facts.some(
        (f) => f.valid && f.statement.includes(pattern),
      );
    }
    default:
      return condition.satisfied ?? false;
  }
}

/** 评估成功标准（当前为基于 WorldState 事实的简单匹配） */
function evaluateSuccessCriterion(criterion: SuccessCriterion, state: WorldState): boolean {
  if (criterion.met) return true; // 已满足的不回退

  // 基于证据引用
  if (criterion.evidenceRef) {
    return state.facts.some((f) => f.factId === criterion.evidenceRef && f.valid);
  }

  // 自动匹配：检查是否有与 criterion.description 相关的成功事实
  // 这是一个简化的关键词匹配，完整评估由 Verifier LLM 执行
  const keywords = criterion.description.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
  if (keywords.length === 0) return false;

  const successFacts = state.facts.filter(
    (f) => f.valid && f.category === "observation" && f.statement.toLowerCase().includes("succeeded"),
  );

  return successFacts.some((f) => {
    const factLower = f.statement.toLowerCase();
    return keywords.some((kw: string) => factLower.includes(kw));
  });
}

/**
 * 初始化 WorldState 并批量处理已有 observations
 */
export function buildWorldStateFromObservations(
  runId: string,
  observations: StepObservation[],
): WorldState {
  let state = createWorldState(runId);
  for (const obs of observations) {
    state = extractFromObservation(obs, state);
  }
  return state;
}
