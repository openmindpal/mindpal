/**
 * P2-10: 离线同步冲突解决策略引擎
 *
 * 实现多端编辑同一实体时的冲突检测与自动合并策略：
 * 1. LWW (Last-Write-Wins) — 标量字段，记录冲突轨迹
 * 2. Set Merge — 集合字段 (tags/labels)，幂等合并 add/remove
 * 3. Field-Level Merge — 非冲突字段自动合并，仅冲突字段需要策略
 * 4. CRDT Counter — 计数器类型字段，使用增量合并
 *
 * 冲突策略可按 entity/field 配置，支持可插拔。
 */

// ── 类型定义 ──────────────────────────────────────────────

/** 冲突解决策略类型 */
export type ConflictStrategy =
  | "lww"                  // Last-Write-Wins (默认)
  | "server_wins"          // 服务端优先
  | "client_wins"          // 客户端优先
  | "field_level_merge"    // 字段级合并
  | "set_union"            // 集合并集
  | "set_lww"              // 集合 LWW (整体替换)
  | "counter_add"          // 计数器累加
  | "manual"               // 手动解决
  ;

/** 字段级冲突策略配置 */
export interface FieldConflictPolicy {
  /** 默认策略 */
  defaultStrategy: ConflictStrategy;
  /** 按字段名覆盖策略 */
  fieldOverrides?: Record<string, ConflictStrategy>;
  /** 集合类型字段列表（自动用 set_union 策略） */
  setFields?: string[];
  /** 计数器字段列表（自动用 counter_add 策略） */
  counterFields?: string[];
  /** 需要手动解决的字段（永远产生冲突） */
  manualFields?: string[];
}

/** 实体冲突策略配置 */
export interface EntityConflictConfig {
  [entityName: string]: FieldConflictPolicy;
}

/** 冲突检测结果 — 单个字段 */
export interface FieldConflict {
  fieldPath: string;
  strategy: ConflictStrategy;
  /** 基础版本值 */
  baseValue: any;
  /** 服务端当前值 */
  serverValue: any;
  /** 客户端提交值 */
  clientValue: any;
  /** 解决后的值 */
  resolvedValue: any;
  /** 是否自动解决 */
  autoResolved: boolean;
  /** 冲突轨迹 */
  trail: ConflictTrail;
}

/** 冲突轨迹 — 记录谁覆盖了谁 */
export interface ConflictTrail {
  winner: "server" | "client" | "merged" | "manual";
  timestamp: string;
  serverMeta?: { clientId?: string; deviceId?: string; updatedAt?: string };
  clientMeta?: { clientId?: string; deviceId?: string; updatedAt?: string };
  reasoning: string;
}

/** 合并结果 */
export interface MergeResult {
  /** 合并后的完整 patch（可直接应用） */
  mergedPatch: Record<string, any>;
  /** 自动解决的字段 */
  autoResolved: FieldConflict[];
  /** 需要手动解决的字段 */
  manualRequired: FieldConflict[];
  /** 无冲突的字段（直接接受客户端变更） */
  noConflict: string[];
  /** 合并策略摘要 */
  strategySummary: Record<ConflictStrategy, number>;
  /** 是否完全自动解决 */
  fullyAutoResolved: boolean;
}

// ── 默认策略配置 ──────────────────────────────────────────

/** 默认冲突策略（全局 fallback） */
export const DEFAULT_CONFLICT_POLICY: FieldConflictPolicy = {
  defaultStrategy: "lww",
  setFields: ["tags", "labels", "categories", "permissions", "members"],
  counterFields: ["viewCount", "likeCount", "commentCount"],
  manualFields: [],
};

// ── 冲突检测 ──────────────────────────────────────────────

/**
 * 检测两个 patch 之间的字段级冲突
 *
 * @param baseRecord - 客户端基于的版本快照
 * @param serverRecord - 服务端当前最新记录
 * @param clientPatch - 客户端提交的变更 patch
 * @param policy - 冲突解决策略配置
 */
export function detectAndResolveConflicts(params: {
  baseRecord: Record<string, any>;
  serverRecord: Record<string, any>;
  clientPatch: Record<string, any>;
  policy?: FieldConflictPolicy;
  clientMeta?: { clientId?: string; deviceId?: string; updatedAt?: string };
  serverMeta?: { clientId?: string; deviceId?: string; updatedAt?: string };
}): MergeResult {
  const policy = params.policy ?? DEFAULT_CONFLICT_POLICY;
  const { baseRecord, serverRecord, clientPatch } = params;
  const now = new Date().toISOString();

  const mergedPatch: Record<string, any> = {};
  const autoResolved: FieldConflict[] = [];
  const manualRequired: FieldConflict[] = [];
  const noConflict: string[] = [];
  const strategyCounts: Record<string, number> = {};

  for (const [field, clientValue] of Object.entries(clientPatch)) {
    const baseValue = baseRecord[field];
    const serverValue = serverRecord[field];

    // 服务端未变更此字段 → 无冲突，直接接受客户端
    if (deepEqual(baseValue, serverValue)) {
      mergedPatch[field] = clientValue;
      noConflict.push(field);
      continue;
    }

    // 客户端与服务端变更相同 → 无冲突（convergent）
    if (deepEqual(clientValue, serverValue)) {
      mergedPatch[field] = clientValue;
      noConflict.push(field);
      continue;
    }

    // 存在冲突，根据策略解决
    const strategy = resolveFieldStrategy(field, policy);
    strategyCounts[strategy] = (strategyCounts[strategy] ?? 0) + 1;

    const conflict = resolveFieldConflict({
      fieldPath: field,
      strategy,
      baseValue,
      serverValue,
      clientValue,
      clientMeta: params.clientMeta,
      serverMeta: params.serverMeta,
      now,
    });

    if (conflict.autoResolved) {
      autoResolved.push(conflict);
      mergedPatch[field] = conflict.resolvedValue;
    } else {
      manualRequired.push(conflict);
      // 手动解决的字段保持服务端值（安全默认）
      mergedPatch[field] = serverValue;
    }
  }

  return {
    mergedPatch,
    autoResolved,
    manualRequired,
    noConflict,
    strategySummary: strategyCounts as Record<ConflictStrategy, number>,
    fullyAutoResolved: manualRequired.length === 0,
  };
}

/** 确定字段应使用的冲突策略 */
function resolveFieldStrategy(field: string, policy: FieldConflictPolicy): ConflictStrategy {
  // 1. 精确覆盖
  if (policy.fieldOverrides?.[field]) return policy.fieldOverrides[field];
  // 2. 集合字段
  if (policy.setFields?.includes(field)) return "set_union";
  // 3. 计数器字段
  if (policy.counterFields?.includes(field)) return "counter_add";
  // 4. 手动字段
  if (policy.manualFields?.includes(field)) return "manual";
  // 5. 默认策略
  return policy.defaultStrategy;
}

/** 解决单个字段的冲突 */
function resolveFieldConflict(params: {
  fieldPath: string;
  strategy: ConflictStrategy;
  baseValue: any;
  serverValue: any;
  clientValue: any;
  clientMeta?: { clientId?: string; deviceId?: string; updatedAt?: string };
  serverMeta?: { clientId?: string; deviceId?: string; updatedAt?: string };
  now: string;
}): FieldConflict {
  const { fieldPath, strategy, baseValue, serverValue, clientValue, now } = params;
  const baseTrait = { fieldPath, strategy, baseValue, serverValue, clientValue };

  switch (strategy) {
    case "lww": {
      // 比较时间戳，后写者胜
      const clientTime = params.clientMeta?.updatedAt ? new Date(params.clientMeta.updatedAt).getTime() : 0;
      const serverTime = params.serverMeta?.updatedAt ? new Date(params.serverMeta.updatedAt).getTime() : 0;
      const clientWins = clientTime > serverTime;
      return {
        ...baseTrait,
        resolvedValue: clientWins ? clientValue : serverValue,
        autoResolved: true,
        trail: {
          winner: clientWins ? "client" : "server",
          timestamp: now,
          serverMeta: params.serverMeta,
          clientMeta: params.clientMeta,
          reasoning: `LWW: ${clientWins ? "客户端" : "服务端"}时间更新 (client=${clientTime}, server=${serverTime})`,
        },
      };
    }

    case "server_wins":
      return {
        ...baseTrait,
        resolvedValue: serverValue,
        autoResolved: true,
        trail: { winner: "server", timestamp: now, serverMeta: params.serverMeta, clientMeta: params.clientMeta, reasoning: "Server-Wins 策略" },
      };

    case "client_wins":
      return {
        ...baseTrait,
        resolvedValue: clientValue,
        autoResolved: true,
        trail: { winner: "client", timestamp: now, serverMeta: params.serverMeta, clientMeta: params.clientMeta, reasoning: "Client-Wins 策略" },
      };

    case "set_union": {
      // 集合并集合并
      const merged = mergeSetFields(baseValue, serverValue, clientValue);
      return {
        ...baseTrait,
        resolvedValue: merged,
        autoResolved: true,
        trail: { winner: "merged", timestamp: now, serverMeta: params.serverMeta, clientMeta: params.clientMeta, reasoning: `Set-Union: 合并后 ${Array.isArray(merged) ? merged.length : 0} 项` },
      };
    }

    case "set_lww": {
      const clientTime = params.clientMeta?.updatedAt ? new Date(params.clientMeta.updatedAt).getTime() : 0;
      const serverTime = params.serverMeta?.updatedAt ? new Date(params.serverMeta.updatedAt).getTime() : 0;
      const clientWins = clientTime > serverTime;
      return {
        ...baseTrait,
        resolvedValue: clientWins ? clientValue : serverValue,
        autoResolved: true,
        trail: { winner: clientWins ? "client" : "server", timestamp: now, serverMeta: params.serverMeta, clientMeta: params.clientMeta, reasoning: `Set-LWW: ${clientWins ? "客户端" : "服务端"}整体胜出` },
      };
    }

    case "counter_add": {
      // 计数器增量合并
      const merged = mergeCounter(baseValue, serverValue, clientValue);
      return {
        ...baseTrait,
        resolvedValue: merged,
        autoResolved: true,
        trail: { winner: "merged", timestamp: now, serverMeta: params.serverMeta, clientMeta: params.clientMeta, reasoning: `Counter-Add: base=${baseValue} → server=${serverValue}(+${Number(serverValue) - Number(baseValue)}), client=${clientValue}(+${Number(clientValue) - Number(baseValue)}) → merged=${merged}` },
      };
    }

    case "field_level_merge":
      // 对象类型字段递归合并
      if (isPlainObject(serverValue) && isPlainObject(clientValue)) {
        const merged = deepMerge(serverValue, clientValue, baseValue);
        return {
          ...baseTrait,
          resolvedValue: merged,
          autoResolved: true,
          trail: { winner: "merged", timestamp: now, serverMeta: params.serverMeta, clientMeta: params.clientMeta, reasoning: "Field-Level-Merge: 深度合并对象字段" },
        };
      }
      // 非对象退化为 LWW
      return resolveFieldConflict({ ...params, strategy: "lww" });

    case "manual":
      return {
        ...baseTrait,
        resolvedValue: serverValue, // 安全默认
        autoResolved: false,
        trail: { winner: "manual", timestamp: now, serverMeta: params.serverMeta, clientMeta: params.clientMeta, reasoning: "需要手动解决" },
      };

    default:
      return {
        ...baseTrait,
        resolvedValue: serverValue,
        autoResolved: true,
        trail: { winner: "server", timestamp: now, reasoning: `未知策略 "${strategy}"，默认服务端胜出` },
      };
  }
}

// ── 合并算法 ──────────────────────────────────────────────

/**
 * 集合字段合并 (add/remove 语义)
 * base=[A,B], server=[A,C] (removed B, added C), client=[A,B,D] (added D)
 * → result=[A,C,D] (server removed B preserved, both additions merged)
 */
function mergeSetFields(base: any, server: any, client: any): any[] {
  const baseSet = new Set(toArray(base));
  const serverSet = new Set(toArray(server));
  const clientSet = new Set(toArray(client));

  // 计算增量
  const serverAdded = new Set([...serverSet].filter((x) => !baseSet.has(x)));
  const serverRemoved = new Set([...baseSet].filter((x) => !serverSet.has(x)));
  const clientAdded = new Set([...clientSet].filter((x) => !baseSet.has(x)));
  const clientRemoved = new Set([...baseSet].filter((x) => !clientSet.has(x)));

  // 从 base 开始合并
  const result = new Set(baseSet);

  // 应用 server 变更
  for (const item of serverAdded) result.add(item);
  for (const item of serverRemoved) result.delete(item);

  // 应用 client 变更
  for (const item of clientAdded) result.add(item);
  for (const item of clientRemoved) result.delete(item);

  return [...result];
}

/**
 * 计数器增量合并
 * base=10, server=15 (+5), client=13 (+3) → merged = 10 + 5 + 3 = 18
 */
function mergeCounter(base: any, server: any, client: any): number {
  const b = Number(base) || 0;
  const s = Number(server) || 0;
  const c = Number(client) || 0;
  const serverDelta = s - b;
  const clientDelta = c - b;
  return b + serverDelta + clientDelta;
}

/**
 * 深度对象合并（非冲突字段直接取双方，冲突字段取 client）
 */
function deepMerge(server: Record<string, any>, client: Record<string, any>, base?: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...server };
  for (const [key, clientVal] of Object.entries(client)) {
    const serverVal = server[key];
    const baseVal = base?.[key];

    // 服务端未变更此字段 → 用客户端值
    if (deepEqual(baseVal, serverVal)) {
      result[key] = clientVal;
      continue;
    }
    // 客户端未变更此字段 → 保持服务端值
    if (deepEqual(baseVal, clientVal)) {
      continue;
    }
    // 双方都变更了 → 递归合并或取客户端
    if (isPlainObject(serverVal) && isPlainObject(clientVal)) {
      result[key] = deepMerge(serverVal, clientVal, isPlainObject(baseVal) ? baseVal : undefined);
    } else {
      result[key] = clientVal; // 叶子节点退化为 client-wins
    }
  }
  return result;
}

// ── 工具函数 ──────────────────────────────────────────────

function toArray(val: any): any[] {
  if (Array.isArray(val)) return val;
  if (val === null || val === undefined) return [];
  return [val];
}

function isPlainObject(val: any): val is Record<string, any> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => deepEqual(a[k], b[k]));
}

// ── 策略配置注册 ──────────────────────────────────────────

const entityConfigRegistry = new Map<string, FieldConflictPolicy>();

/** 注册实体的冲突策略配置 */
export function registerEntityConflictPolicy(entityName: string, policy: FieldConflictPolicy) {
  entityConfigRegistry.set(entityName, policy);
}

/** 获取实体的冲突策略配置 */
export function getEntityConflictPolicy(entityName: string): FieldConflictPolicy {
  return entityConfigRegistry.get(entityName) ?? DEFAULT_CONFLICT_POLICY;
}

/** 批量注册实体配置 */
export function registerEntityConflictConfigs(configs: EntityConflictConfig) {
  for (const [entity, policy] of Object.entries(configs)) {
    registerEntityConflictPolicy(entity, policy);
  }
}

// ── 预置策略配置 ──────────────────────────────────────────

// 注册常见实体的冲突策略
registerEntityConflictConfigs({
  // 通用记录 — LWW + 集合字段自动合并
  "record": {
    defaultStrategy: "lww",
    setFields: ["tags", "labels", "categories"],
    counterFields: ["viewCount"],
  },
  // 配置项 — 服务端优先
  "config": {
    defaultStrategy: "server_wins",
    manualFields: ["criticalSetting"],
  },
  // 文档 — 字段级合并
  "document": {
    defaultStrategy: "field_level_merge",
    setFields: ["tags", "collaborators"],
    manualFields: ["title"], // 标题冲突需手动解决
  },
  // 工作流任务 — 客户端优先（离线操作场景）
  "task": {
    defaultStrategy: "client_wins",
    fieldOverrides: {
      "status": "server_wins",   // 状态以服务端为准
      "assignee": "server_wins", // 指派以服务端为准
    },
    setFields: ["tags", "watchers"],
  },
});
