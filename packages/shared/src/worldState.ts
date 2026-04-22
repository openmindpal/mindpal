/**
 * WorldState — 结构化环境/世界状态表示
 *
 * 从 Agent Loop 的线性 observations 列表提取结构化环境信息，
 * 供 LLM 决策、Verifier 校验、GoalGraph 条件评估使用。
 *
 * 设计原则：
 * - 实体 + 关系 + 事实 三层模型
 * - 每次工具执行后增量更新（而非全量重建）
 * - 可序列化/持久化，支持 checkpoint 恢复
 * - Verifier 使用 WorldState 对比 GoalGraph.successCriteria
 */

/* ================================================================== */
/*  实体 (Entity)                                                       */
/* ================================================================== */

/** 实体类别 */
export type EntityCategory =
  | "resource"        // 资源（文件、数据库记录、API 端点等）
  | "actor"           // 行为者（用户、Agent、外部系统）
  | "artifact"        // 产出物（生成的文件、报告、代码等）
  | "configuration"   // 配置项
  | "external"        // 外部系统/服务状态
  | "custom";         // 自定义

/** 世界中的一个实体 */
export interface WorldEntity {
  /** 实体唯一 ID */
  entityId: string;
  /** 实体名称 */
  name: string;
  /** 实体类别 */
  category: EntityCategory;
  /** 实体当前属性（键值对） */
  properties: Record<string, unknown>;
  /** 实体状态标签（如 "created", "modified", "deleted", "active"） */
  state: string;
  /** 来源（哪个 step 产生/更新了此实体） */
  sourceStepSeq?: number;
  /** 来源工具 */
  sourceToolRef?: string;
  /** 置信度（0-1，LLM 提取的可信程度） */
  confidence: number;
  /** 首次发现时间 */
  discoveredAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/* ================================================================== */
/*  关系 (Relationship)                                                 */
/* ================================================================== */

/** 实体间关系类型 */
export type RelationType =
  | "created_by"       // A 由 B 创建
  | "depends_on"       // A 依赖 B
  | "contains"         // A 包含 B
  | "modifies"         // A 修改了 B
  | "references"       // A 引用 B
  | "consumes"         // A 消费 B
  | "produces"         // A 产出 B
  | "communicates_with" // A 与 B 通信
  | "custom";          // 自定义

/** 实体间关系 */
export interface WorldRelation {
  /** 关系唯一 ID */
  relationId: string;
  /** 源实体 ID */
  fromEntityId: string;
  /** 目标实体 ID */
  toEntityId: string;
  /** 关系类型 */
  type: RelationType;
  /** 关系描述（自然语言） */
  description?: string;
  /** 关系属性 */
  properties?: Record<string, unknown>;
  /** 来源 step */
  sourceStepSeq?: number;
  /** 置信度 */
  confidence: number;
  /** 建立时间 */
  establishedAt: string;
}

/* ================================================================== */
/*  事实 (Fact)                                                         */
/* ================================================================== */

/** 事实类别 */
export type FactCategory =
  | "observation"      // 直接观察到的事实
  | "inference"        // 推理得出的事实
  | "assumption"       // 假设（需要验证）
  | "constraint"       // 约束条件
  | "user_stated"      // 用户明确陈述的事实
  | "system";          // 系统环境事实

/** 环境事实 */
export interface WorldFact {
  /** 事实唯一 ID */
  factId: string;
  /** 事实类别 */
  category: FactCategory;
  /** 事实键（用于去重和更新） */
  key: string;
  /** 事实内容（自然语言描述） */
  statement: string;
  /** 事实值（可选的结构化值） */
  value?: unknown;
  /** 关联的实体 ID 列表 */
  relatedEntityIds?: string[];
  /** 来源 step */
  sourceStepSeq?: number;
  /** 来源工具 */
  sourceToolRef?: string;
  /** 置信度 */
  confidence: number;
  /** 是否仍然有效（后续事实可能推翻它） */
  valid: boolean;
  /** 失效原因 */
  invalidatedBy?: string;
  /** 记录时间 */
  recordedAt: string;
  /** 最后验证时间 */
  lastVerifiedAt?: string;
}

/* ================================================================== */
/*  WorldState 主结构                                                   */
/* ================================================================== */

/** 世界状态 — 某一时刻的完整环境快照 */
export interface WorldState {
  /** 状态快照 ID */
  stateId: string;
  /** 关联的 run_id */
  runId: string;
  /** 实体表（entityId → Entity） */
  entities: Record<string, WorldEntity>;
  /** 关系列表 */
  relations: WorldRelation[];
  /** 事实列表 */
  facts: WorldFact[];
  /** 对应的迭代编号（哪次迭代之后的快照） */
  afterIteration: number;
  /** 对应的最新 step seq */
  afterStepSeq: number;
  /** 快照版本（每次更新递增） */
  version: number;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/* ================================================================== */
/*  工具函数                                                            */
/* ================================================================== */

/**
 * 创建空的 WorldState
 */
export function createWorldState(runId: string, stateId?: string): WorldState {
  const now = new Date().toISOString();
  return {
    stateId: stateId ?? crypto.randomUUID(),
    runId,
    entities: {},
    relations: [],
    facts: [],
    afterIteration: 0,
    afterStepSeq: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 向 WorldState 添加或更新一个实体（按 entityId 去重）
 */
export function upsertEntity(state: WorldState, entity: WorldEntity): WorldState {
  return {
    ...state,
    entities: { ...state.entities, [entity.entityId]: entity },
    version: state.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 向 WorldState 添加一个关系
 */
export function addRelation(state: WorldState, relation: WorldRelation): WorldState {
  // 避免重复关系
  const exists = state.relations.some(
    (r) =>
      r.fromEntityId === relation.fromEntityId &&
      r.toEntityId === relation.toEntityId &&
      r.type === relation.type,
  );
  if (exists) return state;
  return {
    ...state,
    relations: [...state.relations, relation],
    version: state.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 向 WorldState 添加或更新一个事实（按 key 去重，新事实覆盖旧事实）
 */
export function upsertFact(state: WorldState, fact: WorldFact): WorldState {
  const existingIdx = state.facts.findIndex((f) => f.key === fact.key);
  let newFacts: WorldFact[];
  if (existingIdx >= 0) {
    // 旧事实标记为失效，新事实替换
    newFacts = [...state.facts];
    newFacts[existingIdx] = {
      ...newFacts[existingIdx],
      valid: false,
      invalidatedBy: fact.factId,
    };
    newFacts.push(fact);
  } else {
    newFacts = [...state.facts, fact];
  }
  return {
    ...state,
    facts: newFacts,
    version: state.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 批量添加/更新多个实体（按 entityId 去重）
 * 功能目标：观察阶段一次性注入从会话上下文提取的多个实体，减少逐条 upsert 开销
 */
export function batchUpsertEntities(state: WorldState, entities: WorldEntity[]): WorldState {
  if (entities.length === 0) return state;
  const merged = { ...state.entities };
  for (const entity of entities) {
    merged[entity.entityId] = entity;
  }
  return {
    ...state,
    entities: merged,
    version: state.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 批量添加多个关系（自动去重：相同 from+to+type 不重复插入）
 * 功能目标：观察阶段一次性注入从会话上下文提取的多条关系
 */
export function batchAddRelations(state: WorldState, relations: WorldRelation[]): WorldState {
  if (relations.length === 0) return state;
  const existingSet = new Set(
    state.relations.map((r) => `${r.fromEntityId}|${r.toEntityId}|${r.type}`),
  );
  const newRelations: WorldRelation[] = [];
  for (const rel of relations) {
    const key = `${rel.fromEntityId}|${rel.toEntityId}|${rel.type}`;
    if (!existingSet.has(key)) {
      existingSet.add(key);
      newRelations.push(rel);
    }
  }
  if (newRelations.length === 0) return state;
  return {
    ...state,
    relations: [...state.relations, ...newRelations],
    version: state.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 获取所有仍然有效的事实
 */
export function getValidFacts(state: WorldState): WorldFact[] {
  return state.facts.filter((f) => f.valid);
}

/**
 * 获取与特定实体相关的所有关系
 */
export function getEntityRelations(state: WorldState, entityId: string): WorldRelation[] {
  return state.relations.filter(
    (r) => r.fromEntityId === entityId || r.toEntityId === entityId,
  );
}

/**
 * 获取特定类别的实体
 */
export function getEntitiesByCategory(state: WorldState, category: EntityCategory): WorldEntity[] {
  return Object.values(state.entities).filter((e) => e.category === category);
}

/**
 * 将 WorldState 序列化为 LLM 可读的文本摘要
 */
export function worldStateToPromptText(state: WorldState, maxLength = 2000): string {
  const parts: string[] = [];

  // 实体摘要
  const entities = Object.values(state.entities);
  if (entities.length > 0) {
    parts.push("## Known Entities");
    for (const e of entities.slice(0, 20)) {
      const props = Object.entries(e.properties)
        .slice(0, 5)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      parts.push(`- [${e.category}] ${e.name} (${e.state})${props ? `: ${props}` : ""}`);
    }
    if (entities.length > 20) {
      parts.push(`  ... and ${entities.length - 20} more entities`);
    }
  }

  // 关系摘要
  if (state.relations.length > 0) {
    parts.push("\n## Known Relations");
    for (const r of state.relations.slice(0, 15)) {
      const from = state.entities[r.fromEntityId]?.name ?? r.fromEntityId;
      const to = state.entities[r.toEntityId]?.name ?? r.toEntityId;
      parts.push(`- ${from} --[${r.type}]--> ${to}`);
    }
    if (state.relations.length > 15) {
      parts.push(`  ... and ${state.relations.length - 15} more relations`);
    }
  }

  // 有效事实摘要
  const validFacts = getValidFacts(state);
  if (validFacts.length > 0) {
    parts.push("\n## Known Facts");
    for (const f of validFacts.slice(0, 20)) {
      parts.push(`- [${f.category}] ${f.statement}${f.confidence < 0.8 ? ` (confidence: ${f.confidence})` : ""}`);
    }
    if (validFacts.length > 20) {
      parts.push(`  ... and ${validFacts.length - 20} more facts`);
    }
  }

  const text = parts.join("\n");
  if (text.length <= maxLength) return text;
  // 在换行符处截断，避免破坏 Markdown 行结构
  const truncIdx = text.lastIndexOf("\n", maxLength - 20);
  const safeIdx = truncIdx > 0 ? truncIdx : maxLength - 20;
  return text.slice(0, safeIdx) + "\n\n... (truncated)";
}

/* ================================================================== */
/*  多源融合与一致性检测                                                  */
/* ================================================================== */

/** 世界状态声明的来源类型 */
export type WorldStateSource =
  | 'observation'       // 直接观察（工具执行结果）
  | 'external_query'    // 外部查询（API/数据库查询结果）
  | 'user_input'        // 用户明确输入
  | 'sensor'            // 传感器数据
  | 'inference';        // 推理得出

/**
 * 带来源标记的世界状态条目
 * 功能目标：为多源融合提供统一的状态声明单元，每个条目携带来源和置信度信息
 */
export interface WorldStateEntry {
  key: string;
  value: unknown;
  source: WorldStateSource;
  /** 0-1，状态声明的置信度 */
  confidence: number;
  timestamp: number;
  /** 与哪些其他 entry 的 source 冲突 */
  conflictsWith?: string[];
}

/**
 * 同一 key 下多个来源声明值不一致时产生的冲突记录
 */
export interface WorldStateConflict {
  key: string;
  /** 同一 key 的多个冲突声明 */
  entries: WorldStateEntry[];
  resolved: boolean;
  /** 解决后选择的值 */
  resolution?: WorldStateEntry;
}

/**
 * 检测多个 WorldStateEntry 中同一 key 的值冲突。
 *
 * 功能目标：在多源状态融合时，识别同一 key 下不同来源给出了不同值的矛盾，
 * 为后续的冲突解决（取最高置信度）提供依据。
 *
 * 纯函数，不涉及 IO。
 */
export function detectWorldStateConflicts(
  entries: WorldStateEntry[],
): WorldStateConflict[] {
  const byKey = new Map<string, WorldStateEntry[]>();
  for (const e of entries) {
    const list = byKey.get(e.key);
    if (list) {
      list.push(e);
    } else {
      byKey.set(e.key, [e]);
    }
  }

  const conflicts: WorldStateConflict[] = [];
  for (const [key, list] of byKey) {
    if (list.length <= 1) continue;
    // 检查值是否一致
    const values = list.map(e => JSON.stringify(e.value));
    const unique = new Set(values);
    if (unique.size > 1) {
      conflicts.push({ key, entries: list, resolved: false });
    }
  }
  return conflicts;
}

/**
 * 融合多个来源的 WorldStateEntry 列表，产出合并后的状态 + 冲突报告。
 *
 * 功能目标：支持将 observation、external_query、user_input 等多个来源的状态声明
 * 合并为统一视图，自动检测矛盾并以置信度最高者为准解决冲突。
 *
 * 纯函数，不涉及 IO。
 */
export function mergeWorldStates(
  ...states: WorldStateEntry[][]
): { merged: Record<string, WorldStateEntry>; conflicts: WorldStateConflict[] } {
  const all = states.flat();
  const conflicts = detectWorldStateConflicts(all);

  // 非冲突 entry 直接合并（同 key 保留 confidence 最高的）
  const merged: Record<string, WorldStateEntry> = {};
  const conflictKeys = new Set(conflicts.map(c => c.key));

  for (const e of all) {
    if (conflictKeys.has(e.key)) continue;
    if (!merged[e.key] || e.confidence > merged[e.key].confidence) {
      merged[e.key] = e;
    }
  }

  // 冲突 entry 保留 confidence 最高的（但标记冲突来源）
  for (const conflict of conflicts) {
    const best = conflict.entries.reduce((a, b) => a.confidence >= b.confidence ? a : b);
    merged[conflict.key] = {
      ...best,
      conflictsWith: conflict.entries
        .filter(e => e !== best)
        .map(e => e.source),
    };
    conflict.resolved = true;
    conflict.resolution = merged[conflict.key];
  }

  return { merged, conflicts };
}
