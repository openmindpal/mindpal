/**
 * World State Rules — 规则提取器（无 LLM 调用）
 *
 * 从 StepObservation 的结构化工具输出中直接提取实体、关系、事实。
 * 零 LLM 调用的规则提取，基于 output 字段的结构推断。
 */
import crypto from "node:crypto";
import type {
  WorldState, WorldEntity, WorldRelation, WorldFact,
  WorldStateEntry, RelationType, WorldStateLimits,
} from "@mindpal/shared";
import {
  upsertEntity, addRelation, upsertFact,
  findEntityByName, findFactByKey,
} from "@mindpal/shared";
import type { StepObservation } from "./loopTypes";

/* ================================================================== */
/*  WorldState 大小限制配置                                              */
/* ================================================================== */

export const WORLD_STATE_LIMITS: WorldStateLimits = {
  maxEntities: parseInt(process.env.WORLD_STATE_MAX_ENTITIES || "200", 10) || 200,
  maxFacts: parseInt(process.env.WORLD_STATE_MAX_FACTS || "500", 10) || 500,
  maxRelations: parseInt(process.env.WORLD_STATE_MAX_RELATIONS || "300", 10) || 300,
};

/* ================================================================== */
/*  通用规则：根据工具动作推断 agent→entity 关系类型                         */
/* ================================================================== */

const actionToRelation: Record<string, RelationType> = {
  create: 'produces',
  update: 'modifies',
  delete: 'modifies',
  read: 'references',
  get: 'references',
  list: 'references',
  search: 'references',
};

/** 从 toolRef 中解析动作部分（如 entity.create@1.0 → create） */
function parseActionFromToolRef(toolRef: string): string | undefined {
  const toolName = (toolRef.split('@')[0] ?? '').toLowerCase();
  const parts = toolName.split('.');
  return parts.length >= 2 ? parts[parts.length - 1] : undefined;
}

/** 为 agent→entity 自动添加一条关系 */
function addAgentRelation(
  state: WorldState,
  obs: StepObservation,
  targetEntityId: string,
  now: string,
): WorldState {
  const action = parseActionFromToolRef(obs.toolRef);
  const relType: RelationType = (action && actionToRelation[action]) || 'references';
  const agentEntity = findEntityByName(state, 'Agent');
  if (!agentEntity) return state;
  return addRelation(state, {
    relationId: crypto.randomUUID(),
    fromEntityId: agentEntity.entityId,
    toEntityId: targetEntityId,
    type: relType,
    description: `Agent ${action ?? 'accessed'} entity via ${obs.toolRef}`,
    sourceStepSeq: obs.seq,
    confidence: 1.0,
    establishedAt: now,
  });
}

/* ================================================================== */
/*  跨步骤观察矛盾检测                                                   */
/* ================================================================== */

/** 观察矛盾报告 */
interface ConflictReport {
  entityId: string;
  existingState: string;
  newState: string;
  description: string;
}

/** 矛盾状态对定义 */
const stateContradictions: Record<string, string[]> = {
  created: ['deleted', 'not_found'],
  deleted: ['created', 'exists'],
  exists: ['not_found', 'deleted'],
  not_found: ['exists', 'created'],
};

/**
 * 检测新提取的实体与现有 WorldState 中同名实体的状态矛盾。
 * 纯函数，不修改任何状态。
 */
function detectObservationConflicts(
  newEntities: WorldEntity[],
  existingState: WorldState,
): ConflictReport[] {
  const conflicts: ConflictReport[] = [];
  for (const newEntity of newEntities) {
    const existing = findEntityByName(existingState, newEntity.name);
    if (!existing) continue;

    if (existing.state && newEntity.state && existing.state !== newEntity.state) {
      if (stateContradictions[existing.state]?.includes(newEntity.state)) {
        conflicts.push({
          entityId: existing.entityId,
          existingState: existing.state,
          newState: newEntity.state,
          description: `Entity "${newEntity.name}" state conflict: was "${existing.state}", now "${newEntity.state}"`,
        });
      }
    }
  }
  return conflicts;
}

/* ================================================================== */
/*  WorldState 淘汰：按时间戳淘汰最旧条目                                   */
/* ================================================================== */

/**
 * 淘汰 WorldState 中超限的最旧条目。
 * entities 按 updatedAt 排序淘汰最旧，但保留 pinnedEntityIds 中的实体不淘汰。
 * facts 按 recordedAt 排序淘汰最旧。
 * relations 淘汰引用已删除实体的关系，超限时按 establishedAt 淘汰最旧。
 */
export function pruneWorldState(
  ws: WorldState,
  limits: WorldStateLimits,
  pinnedEntityIds?: Set<string>,
): WorldState {
  let entities = ws.entities;
  let facts = ws.facts;
  let relations = ws.relations;

  // 1. entities 淘汰（Record<string, WorldEntity>）
  const entityEntries = Object.entries(entities);
  if (entityEntries.length > limits.maxEntities) {
    const pinned = pinnedEntityIds ?? new Set<string>();
    // 分为 pinned 和 unpinned
    const pinnedEntries: [string, WorldEntity][] = [];
    const unpinnedEntries: [string, WorldEntity][] = [];
    for (const entry of entityEntries) {
      if (pinned.has(entry[0])) pinnedEntries.push(entry);
      else unpinnedEntries.push(entry);
    }
    // unpinned 按 updatedAt 降序（最新在前），保留最新的
    unpinnedEntries.sort((a, b) => (b[1].updatedAt || "").localeCompare(a[1].updatedAt || ""));
    const keepCount = Math.max(0, limits.maxEntities - pinnedEntries.length);
    const kept = [...pinnedEntries, ...unpinnedEntries.slice(0, keepCount)];
    entities = Object.fromEntries(kept);
  }

  // 2. facts 淘汰（按 recordedAt 排序，保留最新的 maxFacts 条）
  if (facts.length > limits.maxFacts) {
    const sorted = [...facts].sort((a, b) => (b.recordedAt || "").localeCompare(a.recordedAt || ""));
    facts = sorted.slice(0, limits.maxFacts);
  }

  // 3. relations 清理：先删除引用已不存在实体的关系
  const entityIdSet = new Set(Object.keys(entities));
  relations = relations.filter(
    (r) => entityIdSet.has(r.fromEntityId) && entityIdSet.has(r.toEntityId),
  );
  // 超限时按 establishedAt 淘汰最旧
  if (relations.length > limits.maxRelations) {
    const sorted = [...relations].sort((a, b) => (b.establishedAt || "").localeCompare(a.establishedAt || ""));
    relations = sorted.slice(0, limits.maxRelations);
  }

  // 4. 重建索引
  const _entityNameIdx: Record<string, string> = {};
  for (const [id, e] of Object.entries(entities)) {
    if (e.name) _entityNameIdx[e.name] = id;
  }
  const _factKeyIdx: Record<string, number> = {};
  for (let i = 0; i < facts.length; i++) {
    _factKeyIdx[facts[i].key] = i;
  }

  return { ...ws, entities, facts, relations, _entityNameIdx, _factKeyIdx };
}

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

  // 5.3 证据权重：按来源类别调整本步骤新增 facts 的 confidence
  state = {
    ...state,
    facts: state.facts.map(f => {
      if (f.sourceStepSeq !== obs.seq) return f;
      // 直接观测 → 0.9，推断 → 0.5，其他保留原值
      if (f.category === 'observation') return { ...f, confidence: Math.min(f.confidence, 0.9) };
      if (f.category === 'inference') return { ...f, confidence: Math.min(f.confidence, 0.5) };
      return f;
    }),
  };

  // 5.1 跨步骤观察矛盾检测
  const newEntities = Object.values(state.entities).filter(e => e.sourceStepSeq === obs.seq);
  const conflicts = detectObservationConflicts(newEntities, currentState);
  for (const conflict of conflicts) {
    console.warn(`[WorldStateExtractor] ${conflict.description}`);
    state = upsertFact(state, {
      factId: crypto.randomUUID(),
      category: 'conflict',
      key: `conflict:entity:${conflict.entityId}:step${obs.seq}`,
      statement: conflict.description,
      value: { entityId: conflict.entityId, existingState: conflict.existingState, newState: conflict.newState },
      sourceStepSeq: obs.seq,
      sourceToolRef: toolRef,
      confidence: 1.0,
      valid: true,
      recordedAt: now,
    });
  }

  // 更新元数据（version 已由 upsertFact/upsertEntity 自动递增，此处仅更新序号和时间戳）
  // 记忆置信度反馈已集成至上层调用方 agentLoop.ts finally 块：
  // 循环结束时调用 updateMemoryConfidenceFromFacts(pool, tenantId, spaceId, facts)
  // 根据本步骤提取的事实更新相关记忆的置信度（证实 +0.1 / 矛盾 -0.2）。
  // extractFromObservation 为纯函数（无 IO 依赖），因此 DB 操作由调用方负责。
  state = {
    ...state,
    afterIteration: Math.max(state.afterIteration, obs.seq),
    afterStepSeq: Math.max(state.afterStepSeq, obs.seq),
    updatedAt: now,
  };

  // 淘汰超限条目
  state = pruneWorldState(state, WORLD_STATE_LIMITS);

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

  // 自动添加 agent→entity 关系
  state = addAgentRelation(state, obs, entityId, now);

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
      const memEntityId = `memory:${memoryId}`;
      state = upsertEntity(state, {
        entityId: memEntityId,
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
      // 自动添加 agent→memory 关系
      state = addAgentRelation(state, obs, memEntityId, now);
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
    const knowledgeFactId = crypto.randomUUID();
    state = upsertFact(state, {
      factId: knowledgeFactId,
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

  // 自动添加 agent→knowledge 关系（以整体知识检索结果为目标）
  if (results.length > 0) {
    const knowledgeEntityId = `knowledge:search:${obs.seq}`;
    state = upsertEntity(state, {
      entityId: knowledgeEntityId,
      name: `KnowledgeSearch:${obs.seq}`,
      category: "artifact",
      properties: { resultCount: results.length },
      state: "observed",
      sourceStepSeq: obs.seq,
      sourceToolRef: obs.toolRef,
      confidence: 0.9,
      discoveredAt: now,
      updatedAt: now,
    });
    state = addAgentRelation(state, obs, knowledgeEntityId, now);
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
