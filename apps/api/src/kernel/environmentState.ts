/**
 * Unified Environment State Abstraction
 *
 * P2-7.3: 将设备状态、外部服务状态、用户在线状态等统一为可查询的环境快照，
 * 供 Agent Loop 和 Verifier 使用。
 *
 * EnvironmentState 是 Agent 感知外部世界的统一接口，解决当前分散在
 * 各模块（设备、连接器、模型、用户）的状态查询碎片化问题。
 */
import type { Pool } from "pg";

// ── 核心类型 ────────────────────────────────────────────────

export type EntityStatus = "online" | "offline" | "degraded" | "unknown" | "error";

/** 环境中的可观察实体 */
export interface EnvironmentEntity {
  /** 实体类型（device / connector / model / user / service） */
  kind: string;
  /** 实体唯一标识 */
  id: string;
  /** 显示名称 */
  displayName?: string;
  /** 当前状态 */
  status: EntityStatus;
  /** 状态变更时间 */
  statusUpdatedAt: string | null;
  /** 实体属性（类型特定） */
  attributes: Record<string, unknown>;
  /** 最近可达性检测时间 */
  lastSeenAt: string | null;
}

/** 环境约束（影响 Agent 决策的外部条件） */
export interface EnvironmentConstraint {
  /** 约束类型 */
  kind: string;
  /** 约束描述 */
  description: string;
  /** 严重级别 */
  severity: "info" | "warning" | "critical";
  /** 约束来源 */
  source: string;
  /** 检测时间 */
  detectedAt: string;
}

/** 完整环境快照 */
export interface EnvironmentState {
  /** 快照生成时间 */
  snapshotAt: string;
  /** 租户 */
  tenantId: string;
  /** 空间（可选） */
  spaceId: string | null;
  /** 可观察实体列表 */
  entities: EnvironmentEntity[];
  /** 当前活跃约束 */
  constraints: EnvironmentConstraint[];
  /** 摘要统计 */
  summary: {
    totalEntities: number;
    onlineEntities: number;
    degradedEntities: number;
    offlineEntities: number;
    activeConstraints: number;
    criticalConstraints: number;
  };
}

// ── 环境快照构建 ────────────────────────────────────────────

/**
 * 构建完整的环境状态快照。
 * 聚合设备状态、连接器状态、模型状态、用户在线状态。
 */
export async function buildEnvironmentState(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
  /** 要包含的实体类型（默认全部） */
  includeKinds?: string[];
}): Promise<EnvironmentState> {
  const { pool, tenantId, spaceId } = params;
  const includeKinds = new Set(params.includeKinds ?? ["device", "connector", "model", "service"]);
  const entities: EnvironmentEntity[] = [];
  const constraints: EnvironmentConstraint[] = [];

  // 1. 设备状态
  if (includeKinds.has("device")) {
    try {
      const devices = await pool.query<{
        device_id: string; display_name: string; status: string;
        last_seen_at: string | null; capabilities: any;
      }>(
        `SELECT device_id, COALESCE(display_name, device_id) AS display_name, status, last_seen_at, capabilities
         FROM device_registrations WHERE tenant_id = $1 ${spaceId ? "AND space_id = $2" : ""}
         ORDER BY last_seen_at DESC NULLS LAST LIMIT 100`,
        spaceId ? [tenantId, spaceId] : [tenantId],
      );
      for (const d of devices.rows) {
        entities.push({
          kind: "device",
          id: d.device_id,
          displayName: d.display_name,
          status: mapDeviceStatus(d.status, d.last_seen_at),
          statusUpdatedAt: d.last_seen_at,
          attributes: { capabilities: d.capabilities },
          lastSeenAt: d.last_seen_at,
        });
      }
    } catch { /* device_registrations 表可能不存在 */ }
  }

  // 2. 连接器状态
  if (includeKinds.has("connector")) {
    try {
      const connectors = await pool.query<{
        id: string; name: string; status: string; type_name: string; updated_at: string;
      }>(
        `SELECT id, name, status, type_name, updated_at FROM connector_instances
         WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 50`,
        [tenantId],
      );
      for (const c of connectors.rows) {
        entities.push({
          kind: "connector",
          id: c.id,
          displayName: c.name,
          status: mapConnectorStatus(c.status),
          statusUpdatedAt: c.updated_at,
          attributes: { typeName: c.type_name },
          lastSeenAt: c.updated_at,
        });
      }
    } catch { /* connector_instances 表可能不存在 */ }
  }

  // 3. 模型状态
  if (includeKinds.has("model")) {
    try {
      const models = await pool.query<{
        model_ref: string; provider: string; status: string;
        degradation_score: number; updated_at: string;
      }>(
        `SELECT model_ref, provider, status, COALESCE(degradation_score, 0) AS degradation_score, updated_at
         FROM model_catalog WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 50`,
        [tenantId],
      );
      for (const m of models.rows) {
        const status: EntityStatus = m.status === "active" && m.degradation_score < 0.5
          ? "online"
          : m.status === "active" ? "degraded"
          : m.status === "disabled" ? "offline"
          : "error";
        entities.push({
          kind: "model",
          id: m.model_ref,
          displayName: `${m.provider}/${m.model_ref}`,
          status,
          statusUpdatedAt: m.updated_at,
          attributes: { provider: m.provider, degradationScore: m.degradation_score },
          lastSeenAt: m.updated_at,
        });
        if (m.degradation_score >= 0.7) {
          constraints.push({
            kind: "model_degradation",
            description: `Model ${m.model_ref} degradation score: ${m.degradation_score}`,
            severity: m.degradation_score >= 0.9 ? "critical" : "warning",
            source: "model_catalog",
            detectedAt: m.updated_at,
          });
        }
      }
    } catch { /* model_catalog 表可能不存在 */ }
  }

  // 4. 汇总
  const onlineCount = entities.filter(e => e.status === "online").length;
  const degradedCount = entities.filter(e => e.status === "degraded").length;
  const offlineCount = entities.filter(e => e.status === "offline" || e.status === "error").length;
  const criticalCount = constraints.filter(c => c.severity === "critical").length;

  return {
    snapshotAt: new Date().toISOString(),
    tenantId,
    spaceId: spaceId ?? null,
    entities,
    constraints,
    summary: {
      totalEntities: entities.length,
      onlineEntities: onlineCount,
      degradedEntities: degradedCount,
      offlineEntities: offlineCount,
      activeConstraints: constraints.length,
      criticalConstraints: criticalCount,
    },
  };
}

// ── 状态映射工具 ────────────────────────────────────────────

function mapDeviceStatus(dbStatus: string, lastSeenAt: string | null): EntityStatus {
  if (dbStatus === "online") {
    // 超过 5 分钟未见则标记为 degraded
    if (lastSeenAt) {
      const age = Date.now() - new Date(lastSeenAt).getTime();
      if (age > 300_000) return "degraded";
    }
    return "online";
  }
  if (dbStatus === "offline" || dbStatus === "deregistered") return "offline";
  return "unknown";
}

function mapConnectorStatus(dbStatus: string): EntityStatus {
  switch (dbStatus) {
    case "active":
    case "enabled":
      return "online";
    case "disabled":
    case "paused":
      return "offline";
    case "error":
    case "failed":
      return "error";
    default:
      return "unknown";
  }
}

// ── 简化查询接口 ────────────────────────────────────────────

/**
 * 快速查询指定类型实体的在线状态（供 Agent Loop 使用）。
 */
export async function queryEntityStatus(params: {
  pool: Pool;
  tenantId: string;
  kind: string;
  entityId: string;
}): Promise<EnvironmentEntity | null> {
  const state = await buildEnvironmentState({
    pool: params.pool,
    tenantId: params.tenantId,
    includeKinds: [params.kind],
  });
  return state.entities.find(e => e.id === params.entityId) ?? null;
}

/**
 * 获取环境摘要（低开销，适合每次迭代前调用）。
 */
export async function getEnvironmentSummary(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
}): Promise<EnvironmentState["summary"]> {
  const state = await buildEnvironmentState(params);
  return state.summary;
}

// ── P2-触发器: 环境变化检测与通知 ─────────────────────

/** 环境变化事件 */
export interface EnvironmentChangeEvent {
  kind: "entity_status_change" | "constraint_appeared" | "constraint_resolved";
  entityKind?: string;
  entityId?: string;
  previousStatus?: EntityStatus;
  currentStatus?: EntityStatus;
  constraint?: EnvironmentConstraint;
  detectedAt: string;
}

/**
 * 比较两个环境快照，提取变化事件。
 * 用于检测 Agent Loop 迭代间的环境变化。
 */
export function detectEnvironmentChanges(
  previous: EnvironmentState,
  current: EnvironmentState,
): EnvironmentChangeEvent[] {
  const changes: EnvironmentChangeEvent[] = [];
  const now = new Date().toISOString();

  // 实体状态变化
  const prevMap = new Map(previous.entities.map(e => [`${e.kind}:${e.id}`, e]));
  for (const entity of current.entities) {
    const key = `${entity.kind}:${entity.id}`;
    const prev = prevMap.get(key);
    if (prev && prev.status !== entity.status) {
      changes.push({
        kind: "entity_status_change",
        entityKind: entity.kind,
        entityId: entity.id,
        previousStatus: prev.status,
        currentStatus: entity.status,
        detectedAt: now,
      });
    }
  }

  // 新约束出现
  const prevConstraintKeys = new Set(previous.constraints.map(c => `${c.kind}:${c.source}:${c.description}`));
  for (const constraint of current.constraints) {
    const key = `${constraint.kind}:${constraint.source}:${constraint.description}`;
    if (!prevConstraintKeys.has(key)) {
      changes.push({
        kind: "constraint_appeared",
        constraint,
        detectedAt: now,
      });
    }
  }

  // 约束解除
  const currConstraintKeys = new Set(current.constraints.map(c => `${c.kind}:${c.source}:${c.description}`));
  for (const constraint of previous.constraints) {
    const key = `${constraint.kind}:${constraint.source}:${constraint.description}`;
    if (!currConstraintKeys.has(key)) {
      changes.push({
        kind: "constraint_resolved",
        constraint,
        detectedAt: now,
      });
    }
  }

  return changes;
}

/**
 * 将环境变化转化为人类可读的摘要文本（供 Agent 决策使用）。
 */
export function environmentChangesToText(changes: EnvironmentChangeEvent[]): string {
  if (changes.length === 0) return "";
  const lines = [`Environment changes detected (${changes.length}):`];
  for (const change of changes.slice(0, 10)) {
    switch (change.kind) {
      case "entity_status_change":
        lines.push(`  • ${change.entityKind}:${change.entityId} status: ${change.previousStatus} → ${change.currentStatus}`);
        break;
      case "constraint_appeared":
        lines.push(`  ⚠️ New constraint: [${change.constraint?.severity}] ${change.constraint?.description}`);
        break;
      case "constraint_resolved":
        lines.push(`  ✅ Constraint resolved: ${change.constraint?.description}`);
        break;
    }
  }
  if (changes.length > 10) {
    lines.push(`  ... and ${changes.length - 10} more changes`);
  }
  return lines.join("\n");
}
