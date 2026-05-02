/**
 * Task Dependency Resolver — 任务依赖解析器
 *
 * P2-01: 核心依赖解析引擎
 * - finish_to_start: 前置完成后才能开始
 * - output_to_input: 前置输出注入后续输入
 * - cancel_cascade: 取消时级联
 *
 * P2-02: LLM 驱动的依赖推断
 * P2-04: 级联操作（cancel cascade / fail cascade / complete trigger）
 * P2-05: output_to_input 映射
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type {
  TaskQueueEntry, TaskDependency, DepType, DepSource,
  QueueEvent,
} from "./taskQueue.types";
import { TERMINAL_QUEUE_STATUSES } from "./taskQueue.types";
import * as repo from "./taskQueueRepo";
import { validateDAG, wouldCreateCycle, type DagNode } from "@mindpal/shared";
import type { LlmSubject } from "../lib/llm";
import { StructuredLogger } from "@mindpal/shared";

/* ================================================================== */
/*  日志                                                               */
/* ================================================================== */

const _logger = new StructuredLogger({ module: "taskDependencyResolver" });

function log(level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) {
  _logger[level](msg, ctx);
}

/* ================================================================== */
/*  依赖推断结果                                                        */
/* ================================================================== */

/** 单条推断出的依赖 */
export interface InferredDependency {
  fromEntryId: string;
  toEntryId: string;
  depType: DepType;
  /** LLM 给出的推断理由 */
  reason: string;
  /** output_to_input 类型的映射 */
  outputMapping?: Record<string, string>;
  /** 推断置信度 0-1 */
  confidence: number;
}

/** 依赖推断结果 */
export interface DependencyInferenceResult {
  dependencies: InferredDependency[];
  /** 推断过程的 reasoning */
  reasoning: string;
}

/* ================================================================== */
/*  TaskDependencyResolver                                              */
/* ================================================================== */

/** 依赖事件回调（由 TaskQueueManager 注入） */
export type DepEventCallback = (event: {
  type: "depCreated" | "depResolved" | "depBlocked" | "cascadeCancelled";
  sessionId: string;
  entryId: string;
  data: Record<string, unknown>;
}) => void;

export class TaskDependencyResolver {
  private pool: Pool;
  private onEvent: DepEventCallback | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** 注入事件回调 */
  setEventCallback(cb: DepEventCallback) {
    this.onEvent = cb;
  }

  /* ── P2-01: 核心依赖操作 ─────────────────────────────────── */

  /**
   * 创建一条依赖关系。
   * 自动检查循环依赖，如果会造成循环则拒绝。
   */
  async createDependency(params: {
    tenantId: string;
    sessionId: string;
    fromEntryId: string;
    toEntryId: string;
    depType: DepType;
    source?: DepSource;
    outputMapping?: Record<string, string> | null;
  }): Promise<{ ok: true; dep: TaskDependency } | { ok: false; error: string }> {
    const { tenantId, sessionId, fromEntryId, toEntryId, depType, source, outputMapping } = params;

    // 自引用检查
    if (fromEntryId === toEntryId) {
      return { ok: false, error: "Cannot create self-dependency" };
    }

    // 验证条目存在性
    const [fromEntry, toEntry] = await Promise.all([
      repo.getEntry(this.pool, fromEntryId, { tenantId, sessionId }),
      repo.getEntry(this.pool, toEntryId, { tenantId, sessionId }),
    ]);
    if (!fromEntry) return { ok: false, error: `Entry ${fromEntryId} not found` };
    if (!toEntry) return { ok: false, error: `Entry ${toEntryId} not found` };
    if (fromEntry.sessionId !== sessionId || toEntry.sessionId !== sessionId) {
      return { ok: false, error: "Entries must belong to the same session" };
    }

    // 循环依赖检查
    const allEntries = await repo.listActiveEntries(this.pool, tenantId, sessionId);
    const allDeps = await repo.listSessionDependencies(this.pool, tenantId, sessionId);
    const dagNodes = this.buildDagNodes(allEntries, allDeps);

    if (wouldCreateCycle(dagNodes, fromEntryId, toEntryId)) {
      return { ok: false, error: "Adding this dependency would create a circular dependency" };
    }

    // 创建依赖
    const dep = await repo.insertDependency(this.pool, {
      tenantId,
      sessionId,
      fromEntryId,
      toEntryId,
      depType,
      source: source ?? "manual",
      outputMapping,
    });

    // 如果上游已完成，立即标记依赖已解析
    if (TERMINAL_QUEUE_STATUSES.has(toEntry.status)) {
      if (toEntry.status === "completed") {
        await repo.updateDependencyStatus(this.pool, dep.depId, "resolved");
      } else {
        await repo.updateDependencyStatus(this.pool, dep.depId, "blocked");
      }
    }

    log("info", `Dependency created`, {
      depId: dep.depId, from: fromEntryId, to: toEntryId,
      depType, source: source ?? "manual",
    });

    // 发射 depCreated 事件
    this.onEvent?.({
      type: "depCreated",
      sessionId,
      entryId: fromEntryId,
      data: {
        tenantId,
        depId: dep.depId,
        fromEntryId,
        toEntryId,
        depType,
        source: dep.source,
        status: dep.status,
        outputMapping: dep.outputMapping,
      },
    });

    return { ok: true, dep };
  }

  /**
   * 删除一条依赖关系（手动覆盖）
   */
  async removeDependency(depId: string): Promise<boolean> {
    const result = await repo.deleteDependency(this.pool, depId);
    if (result) {
      log("info", `Dependency removed`, { depId });
    }
    return result;
  }

  /**
   * 覆盖依赖状态（用户手动标记为 overridden）
   */
  async overrideDependency(depId: string): Promise<TaskDependency | null> {
    const dep = await repo.updateDependencyStatus(this.pool, depId, "overridden");
    if (dep) {
      log("info", `Dependency overridden`, { depId });
    }
    return dep;
  }

  /* ── P2-01: DAG 验证 ─────────────────────────────────────── */

  /**
   * 验证会话的整体依赖 DAG 是否合法
   */
  async validateSessionDAG(tenantId: string, sessionId: string): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    const entries = await repo.listActiveEntries(this.pool, tenantId, sessionId);
    const deps = await repo.listSessionDependencies(this.pool, tenantId, sessionId);
    const dagNodes = this.buildDagNodes(entries, deps);

    const result = validateDAG(dagNodes);
    return { valid: result.valid, errors: result.errors };
  }

  /* ── P2-02: LLM 驱动的依赖推断 ──────────────────────────── */

  /**
   * 为新入队的任务自动推断依赖关系。
   * 分析新任务与队列中已有任务的关系，推断可能的依赖。
   *
   * 推断维度：
   * 1. 上下文依赖 — 任务目标之间的逻辑先后关系
   * 2. 输出依赖 — 前置任务的输出可能是后续任务的输入
   * 3. 资源依赖 — 操作相同资源时需要串行化
   */
  async inferDependencies(params: {
    app: FastifyInstance;
    subject: LlmSubject;
    locale: string;
    authorization: string | null;
    traceId: string | null;
    newEntry: TaskQueueEntry;
    existingEntries: TaskQueueEntry[];
    defaultModelRef?: string;
  }): Promise<DependencyInferenceResult> {
    const { newEntry, existingEntries } = params;

    // 过滤：只看非终态的活跃任务
    const activeEntries = existingEntries.filter(
      (e) => !TERMINAL_QUEUE_STATUSES.has(e.status) && e.entryId !== newEntry.entryId,
    );

    if (activeEntries.length === 0) {
      return { dependencies: [], reasoning: "No active tasks in queue — no dependencies needed." };
    }

    // 构造 LLM prompt
    const taskSummaries = activeEntries.map((e, i) => ({
      index: i,
      entryId: e.entryId,
      goal: e.goal.slice(0, 200),
      mode: e.mode,
      status: e.status,
      priority: e.priority,
    }));

    const systemPrompt = `You are a task dependency analyzer for a multi-task execution system.
Given a NEW task and a list of EXISTING tasks in the same session queue, determine if the new task depends on any existing tasks.

Dependency types:
- finish_to_start: The new task cannot start until the existing task completes (logical ordering).
- output_to_input: The new task needs the output/result of the existing task as input.
- cancel_cascade: If the existing task is cancelled, the new task should also be cancelled.

Rules:
1. Only infer genuine dependencies — do NOT create unnecessary dependencies.
2. Most tasks can run in parallel unless there's a clear logical reason for ordering.
3. For output_to_input, specify the output_mapping (what output field maps to what input).
4. Confidence should be 0.0-1.0 (only include dependencies with confidence >= 0.5).
5. Return JSON array of dependencies.

Respond with ONLY valid JSON:
{
  "dependencies": [
    {
      "toEntryId": "<existing_task_entry_id>",
      "depType": "finish_to_start" | "output_to_input" | "cancel_cascade",
      "reason": "<brief reason>",
      "outputMapping": { "<from_field>": "<to_field>" } | null,
      "confidence": 0.0-1.0
    }
  ],
  "reasoning": "<brief overall reasoning>"
}`;

    const userPrompt = `NEW TASK:
- Entry ID: ${newEntry.entryId}
- Goal: ${newEntry.goal.slice(0, 300)}
- Mode: ${newEntry.mode}

EXISTING TASKS IN QUEUE:
${JSON.stringify(taskSummaries, null, 2)}

Analyze and return the dependency relationships.`;

    try {
      // 动态导入避免循环依赖
      const { invokeModelChat } = await import("../lib/llm");

      const response = await invokeModelChat({
        app: params.app,
        subject: params.subject,
        locale: params.locale,
        authorization: params.authorization,
        traceId: params.traceId,
        purpose: "task_dependency_inference",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      const text = typeof response === "string" ? response : response?.outputText ?? "";
      // 尝试解析 JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log("warn", `LLM returned non-JSON response for dep inference`, { entryId: newEntry.entryId });
        return { dependencies: [], reasoning: "LLM response was not parseable" };
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        dependencies?: Array<{
          toEntryId?: string;
          depType?: string;
          reason?: string;
          outputMapping?: Record<string, string> | null;
          confidence?: number;
        }>;
        reasoning?: string;
      };

      const dependencies: InferredDependency[] = [];
      const validEntryIds = new Set(activeEntries.map((e) => e.entryId));

      for (const raw of parsed.dependencies ?? []) {
        if (!raw.toEntryId || !validEntryIds.has(raw.toEntryId)) continue;
        if (!raw.depType || !["finish_to_start", "output_to_input", "cancel_cascade"].includes(raw.depType)) continue;
        if (typeof raw.confidence === "number" && raw.confidence < 0.5) continue;

        dependencies.push({
          fromEntryId: newEntry.entryId,
          toEntryId: raw.toEntryId,
          depType: raw.depType as DepType,
          reason: raw.reason || "LLM inferred",
          outputMapping: raw.outputMapping ?? undefined,
          confidence: typeof raw.confidence === "number" ? raw.confidence : 0.7,
        });
      }

      log("info", `LLM inferred ${dependencies.length} dependencies`, {
        entryId: newEntry.entryId, count: dependencies.length,
      });

      return {
        dependencies,
        reasoning: parsed.reasoning || "LLM analysis complete",
      };
    } catch (err) {
      log("error", `LLM dependency inference failed`, {
        entryId: newEntry.entryId, error: String(err),
      });
      return {
        dependencies: [],
        reasoning: `Inference failed: ${String(err)}`,
      };
    }
  }

  /**
   * 为新任务推断并创建依赖关系（组合方法）
   */
  async inferAndCreateDependencies(params: {
    app: FastifyInstance;
    subject: LlmSubject;
    locale: string;
    authorization: string | null;
    traceId: string | null;
    newEntry: TaskQueueEntry;
    tenantId: string;
    sessionId: string;
    defaultModelRef?: string;
  }): Promise<TaskDependency[]> {
    const { app, subject, locale, authorization, traceId, newEntry, tenantId, sessionId, defaultModelRef } = params;

    const existingEntries = await repo.listActiveEntries(this.pool, tenantId, sessionId);

    const inferResult = await this.inferDependencies({
      app, subject, locale, authorization, traceId,
      newEntry, existingEntries, defaultModelRef,
    });

    const createdDeps: TaskDependency[] = [];

    for (const inferred of inferResult.dependencies) {
      const result = await this.createDependency({
        tenantId,
        sessionId,
        fromEntryId: inferred.fromEntryId,
        toEntryId: inferred.toEntryId,
        depType: inferred.depType,
        source: "auto",
        outputMapping: inferred.outputMapping ?? null,
      });

      if (result.ok) {
        createdDeps.push(result.dep);
      } else {
        log("warn", `Failed to create inferred dependency`, {
          from: inferred.fromEntryId, to: inferred.toEntryId, error: result.error,
        });
      }
    }

    return createdDeps;
  }

  /* ── P2-04: 级联操作 ─────────────────────────────────────── */

  /**
   * 当任务完成时：
   * 1. 解析所有 finish_to_start 和 output_to_input 依赖
   * 2. 对 output_to_input 依赖执行输出映射
   * 3. 触发下游任务的依赖检查
   */
  async onTaskCompleted(
    completedEntryId: string,
    taskOutput?: Record<string, unknown>,
  ): Promise<{ resolvedDeps: TaskDependency[]; outputMappings: Array<{ entryId: string; injectedData: Record<string, unknown> }> }> {
    // 解析依赖
    const resolvedDeps = await repo.resolveUpstreamDeps(this.pool, completedEntryId);

    // P2-05: 处理 output_to_input 映射
    const outputMappings: Array<{ entryId: string; injectedData: Record<string, unknown> }> = [];
    for (const dep of resolvedDeps) {
      if (dep.depType === "output_to_input" && dep.outputMapping && taskOutput) {
        const injectedData = this.applyOutputMapping(dep.outputMapping, taskOutput);
        if (Object.keys(injectedData).length > 0) {
          outputMappings.push({ entryId: dep.fromEntryId, injectedData });

          // 将映射数据注入到下游任务的 metadata 中
          const downstream = await repo.getEntry(this.pool, dep.fromEntryId);
          if (downstream) {
            // P1-G6b: 使用 repo 函数进行 JSONB 合并更新，而非覆盖整个 metadata
            await repo.updateEntryMetadata(this.pool, dep.fromEntryId, {
              _injectedInputs: {
                ...((downstream.metadata as any)?._injectedInputs ?? {}),
                [completedEntryId]: injectedData,
              },
            }, downstream.tenantId);
          }
        }
      }
    }

    log("info", `Resolved ${resolvedDeps.length} deps on task completion`, {
      completedEntryId,
      outputMappings: outputMappings.length,
    });

    return { resolvedDeps, outputMappings };
  }

  /**
   * 当任务失败时：
   * 1. 阻塞所有下游 finish_to_start 和 output_to_input 依赖
   * 2. 执行 cancel_cascade 级联取消
   * 返回需要级联取消的 entryId 列表
   */
  async onTaskFailed(failedEntryId: string, sessionId?: string): Promise<{
    blockedDeps: TaskDependency[];
    cascadeTargets: string[];
  }> {
    const blockedDeps = await repo.blockUpstreamDeps(this.pool, failedEntryId);
    const cascadeTargets = await repo.getCascadeCancelTargets(this.pool, failedEntryId);

    // 发射 depBlocked 事件
    if (sessionId) {
      for (const dep of blockedDeps) {
        this.onEvent?.({
          type: "depBlocked",
          sessionId,
          entryId: dep.fromEntryId,
          data: { tenantId: dep.tenantId, depId: dep.depId, blockedBy: failedEntryId },
        });
      }
    }

    log("info", `Task failed: blocked ${blockedDeps.length} deps, ${cascadeTargets.length} cascade targets`, {
      failedEntryId,
    });

    return { blockedDeps, cascadeTargets };
  }

  /**
   * 当任务取消时：
   * 1. 阻塞下游依赖
   * 2. 执行 cancel_cascade
   */
  async onTaskCancelled(cancelledEntryId: string, sessionId?: string): Promise<{
    blockedDeps: TaskDependency[];
    cascadeTargets: string[];
  }> {
    return this.onTaskFailed(cancelledEntryId, sessionId);
  }

  /* ── P2-05: output_to_input 映射 ────────────────────────── */

  /**
   * 应用输出映射：从 taskOutput 中提取字段，映射到目标字段名
   *
   * outputMapping 格式: { "targetField": "sourceField" }
   * - sourceField 支持点号路径：如 "result.data.url"
   * - 如果 sourceField 以 * 结尾，表示透传整个对象
   */
  applyOutputMapping(
    mapping: Record<string, string>,
    taskOutput: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [targetField, sourcePath] of Object.entries(mapping)) {
      if (sourcePath === "*") {
        // 透传整个输出
        result[targetField] = taskOutput;
        continue;
      }

      // 点号路径解析
      const parts = sourcePath.split(".");
      let value: unknown = taskOutput;
      for (const part of parts) {
        if (value === null || value === undefined) break;
        if (typeof value === "object") {
          value = (value as Record<string, unknown>)[part];
        } else {
          value = undefined;
          break;
        }
      }

      if (value !== undefined) {
        result[targetField] = value;
      }
    }

    return result;
  }

  /**
   * 获取下游任务的已注入输入数据
   */
  async getInjectedInputs(entryId: string): Promise<Record<string, Record<string, unknown>>> {
    const entry = await repo.getEntry(this.pool, entryId);
    if (!entry?.metadata) return {};
    return (entry.metadata as any)?._injectedInputs ?? {};
  }

  /* ── 内部工具 ────────────────────────────────────────────── */

  /** 将队列条目和依赖关系转换为通用 DAG 节点 */
  private buildDagNodes(entries: TaskQueueEntry[], deps: TaskDependency[]): DagNode[] {
    const depMap = new Map<string, string[]>();
    for (const dep of deps) {
      if (dep.status === "overridden") continue; // 跳过被覆盖的依赖
      if (!depMap.has(dep.fromEntryId)) depMap.set(dep.fromEntryId, []);
      depMap.get(dep.fromEntryId)!.push(dep.toEntryId);
    }

    return entries.map((e) => ({
      id: e.entryId,
      dependsOn: depMap.get(e.entryId) ?? [],
    }));
  }
}

/* ================================================================== */
/*  工厂函数                                                            */
/* ================================================================== */

export function createTaskDependencyResolver(pool: Pool): TaskDependencyResolver {
  return new TaskDependencyResolver(pool);
}
