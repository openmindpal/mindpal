/**
 * World State Extractor — Facade + 生命周期管理
 *
 * 本文件为 WorldState 子系统的统一入口（Facade 模式）。
 * 具体实现拆分到：
 * - worldStateRules.ts     — 规则提取（无 LLM）
 * - worldStateLlm.ts       — LLM 增强提取
 * - worldStateGoalEval.ts  — 目标条件评估
 *
 * 本文件保留生命周期管理函数：
 * - buildWorldStateFromObservations — 初始化 + 批量处理
 * - updateWorldState — 增量更新统一入口
 * - extractWorldState — 观察阶段全量上下文提取
 */
import crypto from "node:crypto";
import type {
  WorldState, WorldFact, WorldStateEntry,
  GoalGraph,
} from "@mindpal/shared";
import {
  createWorldState, upsertEntity, addRelation, upsertFact,
  mergeWorldStates,
} from "@mindpal/shared";
import type { StepObservation } from "./loopTypes";

/* ── 子模块导入 ── */
import { extractFromObservation, pruneWorldState, WORLD_STATE_LIMITS } from "./worldStateRules";
import { evaluateGoalConditions } from "./worldStateGoalEval";

/* ── 重新导出子模块公开 API（保持外部 import 路径不变） ── */
export { extractFromObservation } from "./worldStateRules";
export { llmExtractWorldState, type LlmExtractParams } from "./worldStateLlm";
export { evaluateGoalConditions } from "./worldStateGoalEval";

/* ================================================================== */
/*  buildWorldStateFromObservations — 初始化 + 批量处理                    */
/* ================================================================== */

/**
 * 初始化 WorldState 并批量处理已有 observations
 */
export function buildWorldStateFromObservations(
  runId: string,
  observations: StepObservation[],
  existingState?: WorldState,
): WorldState {
  let state = existingState ?? createWorldState(runId);
  for (const obs of observations) {
    // 跳过已处理的 observation（checkpoint 恢复时避免重复处理）
    if (obs.seq <= state.afterStepSeq) continue;
    state = extractFromObservation(obs, state);
  }
  return state;
}

/* ================================================================== */
/*  updateWorldState — 世界状态增量更新统一入口                             */
/* ================================================================== */

/**
 * updateWorldState — 世界状态增量更新统一入口
 *
 * 将分散的 extractFromObservation + evaluateGoalConditions 调用收敛为单一入口。
 * 纯调用点收敛，底层函数不变。
 */
export function updateWorldState(
  obs: StepObservation | StepObservation[],
  worldState: WorldState | null,
  goalGraph: GoalGraph | null,
): { worldState: WorldState | null; goalGraph: GoalGraph | null } {
  if (!worldState) return { worldState, goalGraph };
  const obsList = Array.isArray(obs) ? obs : [obs];
  for (const o of obsList) {
    worldState = extractFromObservation(o, worldState);
  }
  if (goalGraph) goalGraph = evaluateGoalConditions(goalGraph, worldState);
  return { worldState, goalGraph };
}

/* ================================================================== */
/*  extractWorldState — 观察阶段全量上下文提取                              */
/* ================================================================== */

/**
 * 观察阶段全量提取：从当前会话上下文（消息历史、工具执行结果、记忆查询结果）中
 * 提取实体和关系，构建 WorldState 快照。
 *
 * 与 buildWorldStateFromObservations 的区别：
 * - 额外解析 memoryContext、knowledgeContext、userGoal
 * - 批量提取而非逐条
 * - 为后续 Think/Decide/Verify 阶段提供更完整的环境快照
 */
export function extractWorldState(params: {
  runId: string;
  observations: StepObservation[];
  userGoal: string;
  memoryContext?: string;
  knowledgeContext?: string;
  existingState?: WorldState;
  /** 多源融合：额外的状态声明来源，与观察提取结果融合（不传时行为不变） */
  additionalSources?: WorldStateEntry[];
}): WorldState {
  const { runId, observations, userGoal, memoryContext, knowledgeContext, existingState, additionalSources } = params;
  const now = new Date().toISOString();

  // 基于已有状态增量构建，或全新创建
  let state = existingState ?? createWorldState(runId);

  // 1. 从 observations 中提取（复用现有规则提取器）
  for (const obs of observations) {
    if (obs.seq > state.afterStepSeq) {
      state = extractFromObservation(obs, state);
    }
  }

  // 2. 从用户目标中提取主体实体（actor）
  state = upsertEntity(state, {
    entityId: "actor:user",
    name: "User",
    category: "actor",
    properties: { goalSummary: userGoal.slice(0, 300) },
    state: "active",
    confidence: 1.0,
    discoveredAt: now,
    updatedAt: now,
  });
  state = upsertEntity(state, {
    entityId: "actor:agent",
    name: "Agent",
    category: "actor",
    properties: { stepsExecuted: observations.length },
    state: "active",
    confidence: 1.0,
    discoveredAt: now,
    updatedAt: now,
  });
  state = addRelation(state, {
    relationId: "rel:user-goal-agent",
    fromEntityId: "actor:user",
    toEntityId: "actor:agent",
    type: "communicates_with",
    description: "User delegates goal to Agent",
    confidence: 1.0,
    establishedAt: now,
  });

  // 3. 从 memoryContext 提取已知事实
  if (memoryContext) {
    const memoryFacts = extractFactsFromText(memoryContext, "user_stated", now);
    for (const fact of memoryFacts) {
      state = upsertFact(state, fact);
    }
  }

  // 4. 从 knowledgeContext 提取参考事实
  if (knowledgeContext) {
    const kFacts = extractFactsFromText(knowledgeContext, "observation", now);
    for (const fact of kFacts) {
      state = upsertFact(state, fact);
    }
  }

  // 5. 多源融合：将观察提取的事实转为 WorldStateEntry，与 additionalSources 融合
  //    功能目标：支持多个来源的状态声明融合，检测并解决矛盾
  if (additionalSources && additionalSources.length > 0) {
    // 将当前 state 中的有效事实转换为 WorldStateEntry 格式
    const observationEntries: WorldStateEntry[] = state.facts
      .filter(f => f.valid)
      .map(f => ({
        key: f.key,
        value: f.value ?? f.statement,
        source: 'observation' as const,
        confidence: f.confidence,
        timestamp: Date.parse(f.recordedAt) || Date.now(),
      }));

    const { merged, conflicts } = mergeWorldStates(observationEntries, additionalSources);

    // 将融合后的结果写回 state 事实
    for (const [key, entry] of Object.entries(merged) as [string, WorldStateEntry][]) {
      state = upsertFact(state, {
        factId: crypto.randomUUID(),
        category: entry.source === 'user_input' ? 'user_stated'
          : entry.source === 'inference' ? 'inference'
          : 'observation',
        key,
        statement: typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value),
        value: entry.value,
        confidence: entry.confidence,
        valid: true,
        recordedAt: now,
      });
    }

    // 将未解决的冲突记录为事实，供下游决策者感知
    for (const conflict of conflicts.filter((c: { resolved: boolean }) => !c.resolved)) {
      state = upsertFact(state, {
        factId: crypto.randomUUID(),
        category: 'conflict',
        key: `conflict:${conflict.key}`,
        statement: `Conflict detected on "${conflict.key}": ${conflict.entries.length} sources disagree`,
        value: { conflictKey: conflict.key, sourceCount: conflict.entries.length },
        confidence: 1.0,
        valid: true,
        recordedAt: now,
      });
    }
  }

  state = { ...state, updatedAt: now };

  // 淘汰超限条目
  state = pruneWorldState(state, WORLD_STATE_LIMITS);

  return state;
}

/* ================================================================== */
/*  内部辅助函数                                                         */
/* ================================================================== */

/**
 * 从文本中提取结构化事实（按行拆分，每行作为独立事实）
 */
function extractFactsFromText(
  text: string,
  category: WorldFact["category"],
  now: string,
): WorldFact[] {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 10 && l.length < 500);
  const facts: WorldFact[] = [];
  for (const line of lines.slice(0, 10)) {
    facts.push({
      factId: crypto.randomUUID(),
      category,
      key: `ctx:${crypto.randomUUID().slice(0, 8)}`,
      statement: line,
      confidence: 0.7,
      valid: true,
      recordedAt: now,
    });
  }
  return facts;
}
