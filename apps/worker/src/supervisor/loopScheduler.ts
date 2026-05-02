/**
 * P2: Loop Scheduler — 负载感知调度与跨节点迁移
 *
 * 职责：
 * - 通过 Redis 追踪各 API 节点活跃 Agent Loop 数量
 * - 定期扫描不健康节点上的 Loop，主动 preempt + 迁移
 * - 提供负载均衡路由建议（给 Supervisor 和 Resume Handler 使用）
 * - 支持节点优雅下线时的 Loop 疏散（drain）
 *
 * 设计原则：
 * - 所有状态存储在 Redis 中，无进程内状态依赖
 * - 幂等操作，多 Worker 并发安全
 * - 节点心跳过期自动清理
 */
import type { Pool } from "pg";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:loopScheduler" });
import type { Redis } from "ioredis";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/** 节点负载信息 */
export interface NodeLoadInfo {
  nodeId: string;
  /** 当前活跃 Loop 数 */
  activeLoops: number;
  /** 最大允许 Loop 数 */
  maxLoops: number;
  /** 最后心跳时间戳 */
  lastHeartbeatAt: number;
  /** 节点是否处于 drain 模式 */
  draining: boolean;
  /** CPU 使用率估算（0-100），可选 */
  cpuPercent?: number;
  /** 内存使用率估算（0-100），可选 */
  memPercent?: number;
}

/** 迁移任务描述 */
export interface MigrationTask {
  loopId: string;
  runId: string;
  fromNodeId: string;
  toNodeId: string | null; // null 表示让 Supervisor 自动选择
  reason: "node_unhealthy" | "node_draining" | "load_balance" | "manual";
}

/** 调度建议 */
export interface ScheduleAdvice {
  /** 建议的目标 API 节点 URL */
  targetNode: string | null;
  /** 是否应该延迟执行（所有节点过载时） */
  shouldDelay: boolean;
  /** 延迟毫秒数 */
  delayMs: number;
  /** 全局活跃 Loop 数 */
  globalActiveLoops: number;
  /** 节点负载信息 */
  nodeLoads: NodeLoadInfo[];
}

/* ================================================================== */
/*  Configuration                                                       */
/* ================================================================== */

/** Redis key 前缀 */
const KEY_PREFIX = "loop:scheduler:";

/** 节点心跳过期时间（ms） */
const NODE_HEARTBEAT_TTL_MS = Math.max(15_000, Number(process.env.LOOP_SCHEDULER_HEARTBEAT_TTL_MS ?? "60000"));

/** 每节点最大 Loop 并发数 */
const MAX_LOOPS_PER_NODE = Math.max(1, Number(process.env.LOOP_SCHEDULER_MAX_PER_NODE ?? "20"));

/** 负载均衡阈值：某节点 Loop 数 > 此百分比 × maxLoops 时触发迁移 */
const LOAD_BALANCE_THRESHOLD = Math.max(0.5, Math.min(1, Number(process.env.LOOP_SCHEDULER_BALANCE_THRESHOLD ?? "0.8")));

/** 全局 Loop 数软上限 */
const GLOBAL_LOOP_SOFT_LIMIT = Math.max(10, Number(process.env.LOOP_SCHEDULER_GLOBAL_SOFT_LIMIT ?? "100"));

/* ================================================================== */
/*  Node Registration & Heartbeat                                       */
/* ================================================================== */

function nodeKey(nodeId: string): string {
  return `${KEY_PREFIX}node:${nodeId}`;
}

function allNodesKey(): string {
  return `${KEY_PREFIX}nodes`;
}

function currentNodeId(): string {
  return process.env.NODE_ID || process.env.HOSTNAME || `node-${process.pid}`;
}

/**
 * 注册/更新节点心跳。
 * 应由每个 API 节点在启动时和定期（每 15s）调用。
 */
export async function reportNodeLoad(
  redis: Redis,
  params?: { activeLoops?: number; maxLoops?: number; draining?: boolean; cpuPercent?: number; memPercent?: number },
): Promise<void> {
  const nodeId = currentNodeId();
  const info: NodeLoadInfo = {
    nodeId,
    activeLoops: params?.activeLoops ?? 0,
    maxLoops: params?.maxLoops ?? MAX_LOOPS_PER_NODE,
    lastHeartbeatAt: Date.now(),
    draining: params?.draining ?? false,
    cpuPercent: params?.cpuPercent,
    memPercent: params?.memPercent,
  };

  const pipeline = redis.pipeline();
  pipeline.hset(nodeKey(nodeId), info as any);
  pipeline.sadd(allNodesKey(), nodeId);
  pipeline.pexpire(nodeKey(nodeId), NODE_HEARTBEAT_TTL_MS * 2);
  await pipeline.exec();
}

/**
 * 标记当前节点为 draining（准备下线）。
 * Loop Scheduler 会将此节点上的 Loop 逐步迁移到其他节点。
 */
export async function drainNode(redis: Redis): Promise<void> {
  const nodeId = currentNodeId();
  await redis.hset(nodeKey(nodeId), "draining", "true");
}

/**
 * 获取所有活跃节点的负载信息。
 */
export async function getAllNodeLoads(redis: Redis): Promise<NodeLoadInfo[]> {
  const nodeIds = await redis.smembers(allNodesKey());
  if (!nodeIds.length) return [];

  const pipeline = redis.pipeline();
  for (const id of nodeIds) {
    pipeline.hgetall(nodeKey(id));
  }
  const results = await pipeline.exec();
  if (!results) return [];

  const now = Date.now();
  const nodes: NodeLoadInfo[] = [];
  const expiredNodes: string[] = [];

  for (let i = 0; i < nodeIds.length; i++) {
    const [err, data] = results[i] ?? [];
    if (err || !data || typeof data !== "object") continue;
    const d = data as Record<string, string>;

    const lastHeartbeat = Number(d.lastHeartbeatAt ?? 0);
    if (now - lastHeartbeat > NODE_HEARTBEAT_TTL_MS * 2) {
      // 心跳过期，标记为待清理
      expiredNodes.push(nodeIds[i]);
      continue;
    }

    nodes.push({
      nodeId: nodeIds[i],
      activeLoops: Number(d.activeLoops ?? 0),
      maxLoops: Number(d.maxLoops ?? MAX_LOOPS_PER_NODE),
      lastHeartbeatAt: lastHeartbeat,
      draining: d.draining === "true",
      cpuPercent: d.cpuPercent ? Number(d.cpuPercent) : undefined,
      memPercent: d.memPercent ? Number(d.memPercent) : undefined,
    });
  }

  // 清理过期节点
  if (expiredNodes.length > 0) {
    const cleanPipeline = redis.pipeline();
    for (const id of expiredNodes) {
      cleanPipeline.srem(allNodesKey(), id);
      cleanPipeline.del(nodeKey(id));
    }
    cleanPipeline.exec().catch(() => {});
  }

  return nodes;
}

/* ================================================================== */
/*  Scheduling Advice                                                   */
/* ================================================================== */

/**
 * 获取调度建议：为新的 Loop 或 Resume 选择最佳目标节点。
 */
export async function getScheduleAdvice(redis: Redis): Promise<ScheduleAdvice> {
  const nodeLoads = await getAllNodeLoads(redis);

  // 筛选可用节点（非 draining、未过载）
  const available = nodeLoads.filter((n) => !n.draining && n.activeLoops < n.maxLoops);
  const globalActiveLoops = nodeLoads.reduce((s, n) => s + n.activeLoops, 0);

  // 全部过载
  if (available.length === 0) {
    return {
      targetNode: null,
      shouldDelay: true,
      delayMs: Math.min(5000, 1000 * Math.max(1, globalActiveLoops / GLOBAL_LOOP_SOFT_LIMIT)),
      globalActiveLoops,
      nodeLoads,
    };
  }

  // 全局软上限
  if (globalActiveLoops >= GLOBAL_LOOP_SOFT_LIMIT) {
    return {
      targetNode: null,
      shouldDelay: true,
      delayMs: 2000,
      globalActiveLoops,
      nodeLoads,
    };
  }

  // 选择负载最低的节点
  available.sort((a, b) => {
    const loadA = a.activeLoops / a.maxLoops;
    const loadB = b.activeLoops / b.maxLoops;
    return loadA - loadB;
  });

  return {
    targetNode: available[0].nodeId,
    shouldDelay: false,
    delayMs: 0,
    globalActiveLoops,
    nodeLoads,
  };
}

/* ================================================================== */
/*  Migration Detection                                                 */
/* ================================================================== */

/**
 * 扫描需要迁移的 Loop（draining 节点或过载节点上的 Loop）。
 * 由 Worker tick 调用。
 */
export async function detectMigrationCandidates(
  pool: Pool,
  redis: Redis,
): Promise<MigrationTask[]> {
  const nodeLoads = await getAllNodeLoads(redis);
  const migrations: MigrationTask[] = [];

  // 1. Draining 节点上的活跃 Loop → 迁移
  const drainingNodes = nodeLoads.filter((n) => n.draining && n.activeLoops > 0);
  for (const node of drainingNodes) {
    const loopsOnNode = await pool.query<{ loop_id: string; run_id: string }>(
      `SELECT loop_id, run_id FROM agent_loop_checkpoints
       WHERE node_id = $1 AND status IN ('running', 'resuming')
       LIMIT 10`,
      [node.nodeId],
    );
    for (const row of loopsOnNode.rows) {
      migrations.push({
        loopId: row.loop_id,
        runId: row.run_id,
        fromNodeId: node.nodeId,
        toNodeId: null,
        reason: "node_draining",
      });
    }
  }

  // 2. 过载节点（负载 > 阈值）上多余的 Loop → 迁移到低负载节点
  const overloaded = nodeLoads.filter(
    (n) => !n.draining && n.activeLoops / n.maxLoops > LOAD_BALANCE_THRESHOLD,
  );
  const underloaded = nodeLoads.filter(
    (n) => !n.draining && n.activeLoops / n.maxLoops < LOAD_BALANCE_THRESHOLD * 0.5,
  );

  if (overloaded.length > 0 && underloaded.length > 0) {
    for (const node of overloaded) {
      const excessLoops = node.activeLoops - Math.floor(node.maxLoops * LOAD_BALANCE_THRESHOLD);
      if (excessLoops <= 0) continue;

      const loopsOnNode = await pool.query<{ loop_id: string; run_id: string }>(
        `SELECT loop_id, run_id FROM agent_loop_checkpoints
         WHERE node_id = $1 AND status IN ('running', 'resuming')
         ORDER BY heartbeat_at ASC
         LIMIT $2`,
        [node.nodeId, Math.min(excessLoops, 3)], // 每次最多迁移 3 个
      );

      for (const row of loopsOnNode.rows) {
        // 选择负载最低的目标节点
        underloaded.sort((a, b) => a.activeLoops / a.maxLoops - b.activeLoops / b.maxLoops);
        const target = underloaded[0];
        if (!target || target.activeLoops >= target.maxLoops) continue;

        migrations.push({
          loopId: row.loop_id,
          runId: row.run_id,
          fromNodeId: node.nodeId,
          toNodeId: target.nodeId,
          reason: "load_balance",
        });
        target.activeLoops++; // 更新估算值
      }
    }
  }

  return migrations;
}

/**
 * 执行迁移：暂停 Loop（标记为 preempted）→ Supervisor 下次 tick 会发现并重新调度。
 */
export async function executeMigration(
  pool: Pool,
  task: MigrationTask,
): Promise<boolean> {
  // CAS 更新：仅当 Loop 仍在源节点上运行时才 preempt
  const res = await pool.query(
    `UPDATE agent_loop_checkpoints
     SET status = 'running', node_id = NULL, heartbeat_at = '1970-01-01'::timestamptz, updated_at = now()
     WHERE loop_id = $1 AND node_id = $2 AND status IN ('running', 'resuming')
     RETURNING loop_id`,
    [task.loopId, task.fromNodeId],
  );

  if ((res.rowCount ?? 0) > 0) {
    _logger.info("migrating loop", { loopId: task.loopId, from: task.fromNodeId, to: task.toNodeId ?? "auto", reason: task.reason });
    return true;
  }
  return false;
}

/* ================================================================== */
/*  Scheduler Tick                                                      */
/* ================================================================== */

/**
 * 单次调度器 tick。
 * 由 Worker 的 setInterval 周期性调用。
 */
export async function tickLoopScheduler(deps: {
  pool: Pool;
  redis: Redis;
}): Promise<{ migratedCount: number }> {
  const { pool, redis } = deps;

  // 1. 检测迁移候选
  const candidates = await detectMigrationCandidates(pool, redis);
  if (candidates.length === 0) return { migratedCount: 0 };

  _logger.info("migration candidates detected", { count: candidates.length });

  // 2. 执行迁移
  let migratedCount = 0;
  for (const task of candidates) {
    try {
      const migrated = await executeMigration(pool, task);
      if (migrated) migratedCount++;
    } catch (e: any) {
      _logger.error("migration failed", { loopId: task.loopId, err: e?.message });
    }
  }

  if (migratedCount > 0) {
    _logger.info("loops migrated", { count: migratedCount });
  }

  return { migratedCount };
}

/* ================================================================== */
/*  Summary                                                             */
/* ================================================================== */

export async function getSchedulerSummary(redis: Redis): Promise<{
  nodeCount: number;
  globalActiveLoops: number;
  drainingNodes: number;
  overloadedNodes: number;
  nodes: NodeLoadInfo[];
}> {
  const nodes = await getAllNodeLoads(redis);
  return {
    nodeCount: nodes.length,
    globalActiveLoops: nodes.reduce((s, n) => s + n.activeLoops, 0),
    drainingNodes: nodes.filter((n) => n.draining).length,
    overloadedNodes: nodes.filter((n) => n.activeLoops / n.maxLoops > LOAD_BALANCE_THRESHOLD).length,
    nodes,
  };
}
