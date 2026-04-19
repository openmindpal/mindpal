/**
 * Event-Driven Agent Wakeup — 事件驱动 Agent 唤醒机制
 *
 * P2-触发器: 替代轮询，当特定事件发生时自动启动 Agent Loop。
 *
 * 核心能力：
 * - AgentWakeupRule: 事件类型 → Agent 配置映射
 * - 在 EventBus 上订阅关键频道，匹配时自动启动 runAgentLoop
 * - 去重: 同一事件不会重复唤醒同一 Agent
 * - 冷却时间: 同一规则触发后有最小间隔
 * - DB 持久化规则 + 进程内缓存
 */
import crypto from "node:crypto";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { EventEnvelope, EventBusSubscription } from "@openslin/shared";
import { channelMatchesPattern, type ExtendedEventBus } from "../lib/eventBus";
import { runAgentLoop, type AgentLoopParams } from "./agentLoop";
import type { WorkflowQueue } from "../modules/workflow/queue";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/** Agent 唤醒规则 — 定义何时自动启动 Agent Loop */
export interface AgentWakeupRule {
  /** 规则 ID */
  ruleId: string;
  /** 租户 ID */
  tenantId: string;
  /** 显示名称 */
  name: string;
  /** 规则描述 */
  description?: string;
  /** 匹配的事件通道模式（支持通配符 * **） */
  channelPattern: string;
  /** 匹配的事件类型模式（可选，为空匹配全部） */
  eventTypePattern?: string;
  /** 额外过滤条件（payload 字段匹配） */
  payloadFilters?: Record<string, unknown>;
  /** 唤醒后的 Agent 配置 */
  agentConfig: {
    /** Agent 目标模板（可含 {{payload.xxx}} 占位符） */
    goalTemplate: string;
    /** 最大迭代次数 */
    maxIterations?: number;
    /** 最大执行时间 (ms) */
    maxWallTimeMs?: number;
    /** 默认模型 */
    defaultModelRef?: string;
    /** 空间 ID（可选，为空使用租户默认） */
    spaceId?: string;
    /** 触发用户 subject ID */
    subjectId?: string;
  };
  /** 冷却时间 (ms)，同一规则最小触发间隔 */
  cooldownMs: number;
  /** 规则状态 */
  status: "active" | "paused" | "disabled";
  /** 优先级（数值越小越优先） */
  priority: number;
}

/** 唤醒执行记录 */
export interface WakeupExecution {
  executionId: string;
  ruleId: string;
  eventId: string;
  tenantId: string;
  runId: string | null;
  status: "triggered" | "running" | "completed" | "failed" | "skipped_cooldown" | "skipped_duplicate";
  triggeredAt: string;
  completedAt: string | null;
}

/* ================================================================== */
/*  Wakeup Manager — 管理规则注册 + 事件监听 + 唤醒触发                     */
/* ================================================================== */

export interface WakeupManagerParams {
  app: FastifyInstance;
  pool: Pool;
  queue: WorkflowQueue;
  eventBus: ExtendedEventBus;
}

export interface WakeupManager {
  /** 初始化：从 DB 加载规则 + 订阅 EventBus */
  start(): Promise<void>;
  /** 停止所有订阅 */
  stop(): Promise<void>;
  /** 注册新唤醒规则 */
  registerRule(rule: Omit<AgentWakeupRule, "ruleId">): Promise<AgentWakeupRule>;
  /** 更新规则状态 */
  updateRuleStatus(ruleId: string, status: AgentWakeupRule["status"]): Promise<void>;
  /** 列出租户的所有规则 */
  listRules(tenantId: string): Promise<AgentWakeupRule[]>;
  /** 删除规则 */
  deleteRule(ruleId: string): Promise<void>;
  /** 手动评估事件（用于测试） */
  evaluateEvent(event: EventEnvelope): Promise<WakeupExecution[]>;
}

export function createWakeupManager(params: WakeupManagerParams): WakeupManager {
  const { app, pool, queue, eventBus } = params;

  // 进程内缓存
  let rules: AgentWakeupRule[] = [];
  const subscriptions: EventBusSubscription[] = [];
  // 冷却追踪: ruleId → 最后触发时间
  const cooldownTracker = new Map<string, number>();
  // 去重追踪: "ruleId:eventId" → true
  const recentTriggers = new Map<string, boolean>();
  const DEDUP_WINDOW_MS = 60_000; // 1 分钟去重窗口

  // 定期清理去重缓存
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** 从 DB 加载活跃规则 */
  async function loadRulesFromDb(): Promise<AgentWakeupRule[]> {
    try {
      const res = await pool.query<{
        rule_id: string; tenant_id: string; name: string; description: string | null;
        channel_pattern: string; event_type_pattern: string | null;
        payload_filters: any; agent_config: any;
        cooldown_ms: number; status: string; priority: number;
      }>(
        `SELECT rule_id, tenant_id, name, description, channel_pattern, event_type_pattern,
                payload_filters, agent_config, cooldown_ms, status, priority
         FROM agent_wakeup_rules WHERE status = 'active'
         ORDER BY priority ASC, created_at ASC`,
      );
      return res.rows.map(r => ({
        ruleId: r.rule_id,
        tenantId: r.tenant_id,
        name: r.name,
        description: r.description ?? undefined,
        channelPattern: r.channel_pattern,
        eventTypePattern: r.event_type_pattern ?? undefined,
        payloadFilters: r.payload_filters ?? undefined,
        agentConfig: r.agent_config ?? { goalTemplate: "" },
        cooldownMs: r.cooldown_ms,
        status: r.status as AgentWakeupRule["status"],
        priority: r.priority,
      }));
    } catch {
      // 表不存在时降级为空
      return [];
    }
  }

  /** 检查 payload 过滤条件 */
  function matchesPayloadFilters(payload: Record<string, unknown>, filters?: Record<string, unknown>): boolean {
    if (!filters) return true;
    for (const [key, expected] of Object.entries(filters)) {
      const actual = payload[key];
      if (actual !== expected) return false;
    }
    return true;
  }

  /** 渲染目标模板（替换 {{payload.xxx}} 占位符） */
  function renderGoalTemplate(template: string, event: EventEnvelope): string {
    return template.replace(/\{\{([\w.]+)\}\}/g, (_, path: string) => {
      const parts = path.split(".");
      let val: unknown = event;
      for (const p of parts) {
        if (val && typeof val === "object") val = (val as Record<string, unknown>)[p];
        else return `{{${path}}}`;
      }
      return typeof val === "string" ? val : JSON.stringify(val ?? "");
    });
  }

  /** 评估单个事件是否匹配规则并唤醒 */
  async function evaluateEventInternal(event: EventEnvelope): Promise<WakeupExecution[]> {
    const executions: WakeupExecution[] = [];
    const activeRules = rules.filter(r => r.status === "active" && r.tenantId === event.tenantId);

    for (const rule of activeRules) {
      // 1. 通道模式匹配
      if (!channelMatchesPattern(event.channel, rule.channelPattern)) continue;

      // 2. 事件类型模式匹配
      if (rule.eventTypePattern && !channelMatchesPattern(event.eventType, rule.eventTypePattern)) continue;

      // 3. Payload 过滤
      if (!matchesPayloadFilters(event.payload, rule.payloadFilters)) continue;

      const executionId = crypto.randomUUID();
      const now = Date.now();

      // 4. 去重检查
      const dedupKey = `${rule.ruleId}:${event.eventId}`;
      if (recentTriggers.has(dedupKey)) {
        executions.push({
          executionId, ruleId: rule.ruleId, eventId: event.eventId,
          tenantId: event.tenantId, runId: null,
          status: "skipped_duplicate",
          triggeredAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        });
        continue;
      }

      // 5. 冷却时间检查
      const lastTriggered = cooldownTracker.get(rule.ruleId) ?? 0;
      if (now - lastTriggered < rule.cooldownMs) {
        executions.push({
          executionId, ruleId: rule.ruleId, eventId: event.eventId,
          tenantId: event.tenantId, runId: null,
          status: "skipped_cooldown",
          triggeredAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        });
        continue;
      }

      // 6. 触发唤醒
      cooldownTracker.set(rule.ruleId, now);
      recentTriggers.set(dedupKey, true);

      const runId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      const goal = renderGoalTemplate(rule.agentConfig.goalTemplate, event);

      const execution: WakeupExecution = {
        executionId, ruleId: rule.ruleId, eventId: event.eventId,
        tenantId: event.tenantId, runId,
        status: "triggered",
        triggeredAt: new Date().toISOString(), completedAt: null,
      };

      // 记录执行日志到 DB
      recordExecution(execution).catch((e: unknown) => {
        app.log.warn({ err: (e as Error)?.message, executionId, ruleId: rule.ruleId }, "[EventWakeup] recordExecution failed");
      });

      // 异步启动 Agent Loop（fire-and-forget）
      const loopParams: AgentLoopParams = {
        app,
        pool,
        queue,
        subject: {
          subjectId: rule.agentConfig.subjectId ?? `wakeup:${rule.ruleId}`,
          tenantId: event.tenantId,
          spaceId: rule.agentConfig.spaceId ?? "default",
        },
        locale: "zh-CN",
        authorization: null,
        traceId: event.eventId,
        goal,
        runId,
        jobId,
        taskId: `wakeup:${executionId}`,
        maxIterations: rule.agentConfig.maxIterations ?? 10,
        maxWallTimeMs: rule.agentConfig.maxWallTimeMs ?? 5 * 60 * 1000,
        defaultModelRef: rule.agentConfig.defaultModelRef,
      };

      app.log.info(
        { ruleId: rule.ruleId, ruleName: rule.name, eventId: event.eventId, eventType: event.eventType, runId },
        "[EventWakeup] 事件驱动唤醒 Agent Loop",
      );

      runAgentLoop(loopParams)
        .then((result) => {
          app.log.info(
            { ruleId: rule.ruleId, runId, ok: result.ok, endReason: result.endReason },
            "[EventWakeup] Agent Loop 完成",
          );
          updateExecution(executionId, result.ok ? "completed" : "failed").catch((e: unknown) => {
            app.log.warn({ err: (e as Error)?.message, executionId }, "[EventWakeup] updateExecution failed");
          });
        })
        .catch((err) => {
          app.log.error(
            { err: err?.message, ruleId: rule.ruleId, runId },
            "[EventWakeup] Agent Loop 失败",
          );
          updateExecution(executionId, "failed").catch((e2: unknown) => {
            app.log.warn({ err: (e2 as Error)?.message, executionId }, "[EventWakeup] updateExecution(failed) failed");
          });
        });

      execution.status = "running";
      executions.push(execution);
    }

    return executions;
  }

  /** 记录唤醒执行到 DB */
  async function recordExecution(exec: WakeupExecution): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO agent_wakeup_executions (execution_id, rule_id, event_id, tenant_id, run_id, status, triggered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [exec.executionId, exec.ruleId, exec.eventId, exec.tenantId, exec.runId, exec.status, exec.triggeredAt],
      );
    } catch { /* 表可能不存在 */ }
  }

  /** 更新执行状态 */
  async function updateExecution(executionId: string, status: string): Promise<void> {
    try {
      await pool.query(
        `UPDATE agent_wakeup_executions SET status = $2, completed_at = now() WHERE execution_id = $1`,
        [executionId, status],
      );
    } catch { /* ignore */ }
  }

  /** 订阅所有活跃规则对应的频道 */
  async function subscribeToRuleChannels(): Promise<void> {
    // 收集所有唯一的 channel patterns
    const patterns = new Set<string>();
    for (const rule of rules) {
      if (rule.status === "active") patterns.add(rule.channelPattern);
    }

    for (const pattern of patterns) {
      try {
        const sub = await eventBus.subscribe(pattern, (event) => {
          evaluateEventInternal(event).catch((err) => {
            app.log.warn({ err: (err as Error)?.message, channel: pattern }, "[EventWakeup] 事件评估失败");
          });
        });
        subscriptions.push(sub);
      } catch (err) {
        app.log.warn({ err: (err as Error)?.message, pattern }, "[EventWakeup] 订阅频道失败");
      }
    }
  }

  return {
    async start() {
      rules = await loadRulesFromDb();
      app.log.info({ ruleCount: rules.length }, "[EventWakeup] 加载唤醒规则");

      await subscribeToRuleChannels();

      // 定期清理去重缓存
      cleanupTimer = setInterval(() => {
        const cutoff = Date.now() - DEDUP_WINDOW_MS;
        for (const [key] of recentTriggers) {
          // 简单策略：清理所有超过窗口的条目（无精确时间戳，靠冷却时间兜底）
          recentTriggers.delete(key);
        }
        // 清理冷却追踪中过期条目
        for (const [ruleId, lastTime] of cooldownTracker) {
          const rule = rules.find(r => r.ruleId === ruleId);
          if (rule && Date.now() - lastTime > rule.cooldownMs * 2) {
            cooldownTracker.delete(ruleId);
          }
        }
      }, DEDUP_WINDOW_MS);
    },

    async stop() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      for (const sub of subscriptions) {
        try { await sub.unsubscribe(); } catch { /* ignore */ }
      }
      subscriptions.length = 0;
      rules = [];
      cooldownTracker.clear();
      recentTriggers.clear();
    },

    async registerRule(input) {
      const ruleId = crypto.randomUUID();
      const rule: AgentWakeupRule = { ...input, ruleId };

      try {
        await pool.query(
          `INSERT INTO agent_wakeup_rules
           (rule_id, tenant_id, name, description, channel_pattern, event_type_pattern,
            payload_filters, agent_config, cooldown_ms, status, priority, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())`,
          [
            ruleId, rule.tenantId, rule.name, rule.description ?? null,
            rule.channelPattern, rule.eventTypePattern ?? null,
            rule.payloadFilters ? JSON.stringify(rule.payloadFilters) : null,
            JSON.stringify(rule.agentConfig),
            rule.cooldownMs, rule.status, rule.priority,
          ],
        );
      } catch { /* 表可能不存在 */ }

      // 刷新进程内缓存
      if (rule.status === "active") {
        rules.push(rule);
        // 订阅新频道
        await subscribeToRuleChannels();
      }

      return rule;
    },

    async updateRuleStatus(ruleId, status) {
      try {
        await pool.query(
          `UPDATE agent_wakeup_rules SET status = $2, updated_at = now() WHERE rule_id = $1`,
          [ruleId, status],
        );
      } catch { /* ignore */ }

      // 刷新缓存
      const idx = rules.findIndex(r => r.ruleId === ruleId);
      if (idx >= 0) rules[idx].status = status;
    },

    async listRules(tenantId) {
      try {
        const res = await pool.query<{
          rule_id: string; tenant_id: string; name: string; description: string | null;
          channel_pattern: string; event_type_pattern: string | null;
          payload_filters: any; agent_config: any;
          cooldown_ms: number; status: string; priority: number;
        }>(
          `SELECT rule_id, tenant_id, name, description, channel_pattern, event_type_pattern,
                  payload_filters, agent_config, cooldown_ms, status, priority
           FROM agent_wakeup_rules WHERE tenant_id = $1
           ORDER BY priority ASC, created_at ASC`,
          [tenantId],
        );
        return res.rows.map(r => ({
          ruleId: r.rule_id,
          tenantId: r.tenant_id,
          name: r.name,
          description: r.description ?? undefined,
          channelPattern: r.channel_pattern,
          eventTypePattern: r.event_type_pattern ?? undefined,
          payloadFilters: r.payload_filters ?? undefined,
          agentConfig: r.agent_config ?? { goalTemplate: "" },
          cooldownMs: r.cooldown_ms,
          status: r.status as AgentWakeupRule["status"],
          priority: r.priority,
        }));
      } catch {
        return [];
      }
    },

    async deleteRule(ruleId) {
      try {
        await pool.query(`DELETE FROM agent_wakeup_rules WHERE rule_id = $1`, [ruleId]);
      } catch { /* ignore */ }
      rules = rules.filter(r => r.ruleId !== ruleId);
    },

    async evaluateEvent(event) {
      return evaluateEventInternal(event);
    },
  };
}
