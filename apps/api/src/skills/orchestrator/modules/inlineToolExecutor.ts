/**
 * Inline Tool Executor（只读 + 安全写入）
 *
 * 解决系统性架构缺陷：当 LLM 在 answer 模式下生成工具 tool_call 时，
 * 不再静默丢弃，而是基于工具元数据（scope + riskLevel）动态判定并内联执行，
 * 将结果注入 LLM 上下文做二次回复。
 *
 * 设计原则：
 * - 零硬编码：不依赖工具名称黑/白名单，完全基于 ToolDefinition.scope 和 riskLevel 元数据
 * - 可扩展：未来新增的 scope=read + riskLevel=low 工具自动获得内联执行能力
 * - 安全写入：对 schema 中标记 inlineCreatable 的实体创建操作可内联执行，无需走重量级工作流管线
 * - 安全边界：只内联执行 scope=read+riskLevel=low 或安全写入白名单的工具，其余仍走 execute 升级
 * - 超时保护：单个工具内联执行有时间限制，避免阻塞对话流
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { searchMemory, listMemoryEntries, createMemoryEntry } from "../../../modules/memory/repo";
import { searchChunksHybrid } from "../../knowledge-rag/modules/repo";
import type { EnabledTool } from "../../../modules/agentContext";
import { evaluateMemoryRisk } from "@openslin/shared";

// ─── 类型定义 ────────────────────────────────────────────────────

export interface InlineToolCall {
  toolRef: string;
  inputDraft: Record<string, unknown>;
}

export interface InlineToolResult {
  toolRef: string;
  ok: boolean;
  output: unknown;
  error?: string;
  durationMs: number;
}

interface InlineExecContext {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  enabledTools: EnabledTool[];
  app?: FastifyInstance;
  traceId?: string | null;
}

// ─── 内联执行超时（毫秒） ──────────────────────────────────────
const INLINE_EXEC_TIMEOUT_MS = 8_000;

// ─── 注册式工具分发表（消除 if-else 硬编码，支持运行时增删改） ────
type InlineToolHandler = (input: Record<string, unknown>, ctx: InlineExecContext) => Promise<unknown>;

const _inlineToolHandlers = new Map<string, InlineToolHandler>();

/** 注册内联工具处理函数。工具名为去掉版本号后缀的名称（如 "memory.read"） */
export function registerInlineToolHandler(toolName: string, handler: InlineToolHandler): void {
  _inlineToolHandlers.set(toolName, handler);
}

/** 注销内联工具处理函数 */
export function unregisterInlineToolHandler(toolName: string): void {
  _inlineToolHandlers.delete(toolName);
}

/** 获取当前已注册的所有内联工具名称（用于日志/调试） */
export function listRegisteredInlineTools(): string[] {
  return Array.from(_inlineToolHandlers.keys());
}

// ─── 从数据库 schema 动态加载可内联创建的实体列表（带 60秒缓存） ───────────
let _inlineWritableCache: { entities: Set<string>; ts: number } | null = null;

/**
 * 从所有已发布 schema 的实体定义中加载标记了 inlineCreatable: true 的实体名称。
 * 结果缓存 60 秒，修改 schema 后自动生效，无需改代码。
 */
export async function loadInlineWritableEntities(pool: Pool): Promise<Set<string>> {
  const now = Date.now();
  if (_inlineWritableCache && now - _inlineWritableCache.ts < 60_000) {
    return _inlineWritableCache.entities;
  }
  const res = await pool.query(
    `
      SELECT DISTINCT ON (name) schema_json
      FROM schemas
      WHERE status = 'released'
      ORDER BY name, version DESC
    `,
  );
  const entities = new Set<string>();
  for (const row of res.rows) {
    for (const [name, def] of Object.entries<any>(row.schema_json?.entities ?? {})) {
      if (def?.inlineCreatable) entities.add(name);
    }
  }
  _inlineWritableCache = { entities, ts: now };
  return entities;
}

// ─── 核心判定：工具是否可内联执行 ───────────────────────────────

/**
 * 基于工具元数据判定是否可内联执行。
 * 条件：scope=read 且 riskLevel=low 且非 nl2ui 类工具（有独立 UI 生成管线）
 */
export function isInlineEligible(toolRef: string, enabledTools: EnabledTool[]): boolean {
  const tool = enabledTools.find(t => t.toolRef === toolRef);
  if (!tool) return false;

  // nl2ui 类工具有独立的 UI 生成管线，不走内联执行路径
  if (tool.def.resourceType === "nl2ui") return false;

  const scope = tool.def.scope;
  const riskLevel = tool.def.riskLevel ?? "low";

  return scope === "read" && riskLevel === "low";
}

/**
 * 判定写入类工具是否可安全内联执行。
 * 基于工具元数据（scope=riskLevel）和动态风险评估，不依赖任何硬编码工具名。
 * - 对 memory 类写入工具：调用 evaluateMemoryRisk 动态判定
 * - 对 entity.create 类工具：检查目标实体是否在 schema 中标记 inlineCreatable
 */
export function isInlineWriteEligible(
  toolRef: string,
  inputDraft: Record<string, unknown>,
  inlineWritableEntities: Set<string>,
  enabledTools?: EnabledTool[],
): boolean {
  const at = toolRef.lastIndexOf("@");
  const toolName = at > 0 ? toolRef.slice(0, at) : toolRef;

  // 查找工具元数据，基于 scope/riskLevel 动态判定
  const toolMeta = enabledTools?.find(t => t.name === toolName);
  const isWriteTool = toolMeta?.def.scope === "write";

  // 写入类工具：memory 类通过风险评估，entity 类通过白名单
  if (isWriteTool) {
    // 判断是否为 memory 类写入（通过 resourceType 元数据，而非硬编码名称）
    if (toolMeta?.def.resourceType === "memory") {
      const type = String(inputDraft?.type ?? "other");
      const risk = evaluateMemoryRisk({ type, contentText: String(inputDraft?.contentText ?? "") });
      return risk.riskLevel === "low" && !risk.approvalRequired;
    }
    // entity.create 类：检查 schema inlineCreatable 白名单
    if (toolMeta?.def.action === "create" && toolMeta?.def.resourceType === "entity") {
      const entityName = String(inputDraft?.entityName ?? "");
      return inlineWritableEntities.has(entityName);
    }
    // 其他写入工具默认不可内联执行（走 workflow 管线）
    return false;
  }

  return false;
}

/**
 * 从 tool_calls 列表中分离出可内联执行的只读工具和需要升级执行的写操作工具。
 *
 * 返回：
 * - inlineTools: 可在当前请求中内联执行的只读工具
 * - upgradeTools: 需要升级到 execute 模式的工具（write/高风险等）
 * - nl2uiTool: nl2ui 类工具调用（有独立 UI 生成管线）
 */
export function classifyToolCalls(
  toolCalls: InlineToolCall[],
  enabledTools: EnabledTool[],
  inlineWritableEntities?: Set<string>,
): {
  inlineTools: InlineToolCall[];
  upgradeTools: InlineToolCall[];
  nl2uiTool: InlineToolCall | null;
} {
  const inlineTools: InlineToolCall[] = [];
  const upgradeTools: InlineToolCall[] = [];
  let nl2uiTool: InlineToolCall | null = null;

  const enabledToolRefSet = new Set(enabledTools.map(t => t.toolRef));
  const enabledToolMap = new Map(enabledTools.map(t => [t.toolRef, t]));

  for (const tc of toolCalls) {
    const tool = enabledToolMap.get(tc.toolRef);
    // nl2ui 类工具有独立 UI 生成管线，单独提取
    if (tool?.def.resourceType === "nl2ui") {
      nl2uiTool = tc;
      continue;
    }
    if (!enabledToolRefSet.has(tc.toolRef)) continue;
    if (isInlineEligible(tc.toolRef, enabledTools)) {
      inlineTools.push(tc);
    } else if (inlineWritableEntities && isInlineWriteEligible(tc.toolRef, tc.inputDraft, inlineWritableEntities, enabledTools)) {
      // 安全写入白名单实体（schema 中标记 inlineCreatable）→ 内联执行，跳过工作流管线
      inlineTools.push(tc);
    } else {
      upgradeTools.push(tc);
    }
  }

  return { inlineTools, upgradeTools, nl2uiTool };
}

// ─── 内联执行引擎 ───────────────────────────────────────────────

/**
 * 执行一组内联工具调用并返回结果。
 * 对每个工具调用有超时保护。
 */
export async function executeInlineTools(
  toolCalls: InlineToolCall[],
  ctx: InlineExecContext,
): Promise<InlineToolResult[]> {
  if (!toolCalls.length) return [];

  const results: InlineToolResult[] = [];

  for (const tc of toolCalls) {
    const startMs = Date.now();
    try {
      const output = await Promise.race([
        executeOneTool(tc, ctx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("inline_tool_timeout")), INLINE_EXEC_TIMEOUT_MS),
        ),
      ]);
      results.push({
        toolRef: tc.toolRef,
        ok: true,
        output,
        durationMs: Date.now() - startMs,
      });
    } catch (err: any) {
      const errMsg = String(err?.message ?? err);
      ctx.app?.log.warn(
        { traceId: ctx.traceId, toolRef: tc.toolRef, error: errMsg },
        "[InlineToolExecutor] 内联工具执行失败",
      );
      results.push({
        toolRef: tc.toolRef,
        ok: false,
        output: null,
        error: errMsg,
        durationMs: Date.now() - startMs,
      });
    }
  }

  return results;
}

/**
 * 执行单个内联工具。
 * 通过注册表动态路由到对应的处理函数，不依赖硬编码 if-else。
 */
async function executeOneTool(
  tc: InlineToolCall,
  ctx: InlineExecContext,
): Promise<unknown> {
  // 从 toolRef 提取工具名（去掉版本号后缀）
  const at = tc.toolRef.lastIndexOf("@");
  const toolName = at > 0 ? tc.toolRef.slice(0, at) : tc.toolRef;

  const handler = _inlineToolHandlers.get(toolName);
  if (handler) {
    return handler(tc.inputDraft, ctx);
  }

  // 未注册的工具 —— 按元数据判定它是可内联的，但没有对应的执行函数
  ctx.app?.log.warn(
    { traceId: ctx.traceId, toolRef: tc.toolRef, toolName, registeredTools: listRegisteredInlineTools() },
    "[InlineToolExecutor] 未注册的只读工具内联处理函数，降级为不执行",
  );
  return { _notice: `工具 ${toolName} 尚未注册内联执行函数`, toolRef: tc.toolRef };
}

// ─── 各工具的具体执行实现 ───────────────────────────────────────

async function executeMemoryRead(
  input: Record<string, unknown>,
  ctx: InlineExecContext,
): Promise<unknown> {
  const query = String(input?.query ?? "");
  const scope = input?.scope === "space" ? "space" : input?.scope === "user" ? "user" : undefined;
  const limit = typeof input?.limit === "number" && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(20, input.limit)) : 10;

  if (!query) {
    // 空 query → 列出最近记忆（如“显示我的记忆”）
    const entries = await listMemoryEntries({
      pool: ctx.pool,
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      subjectId: ctx.subjectId,
      scope,
      limit,
      offset: 0,
    });
    return {
      evidence: entries.map(e => ({
        id: e.id,
        type: e.type,
        scope: e.scope,
        title: e.title,
        snippet: (e.title ? e.title + "\n" : "") + (e.contentText ?? "").slice(0, 300),
        createdAt: e.createdAt,
      })),
      candidateCount: entries.length,
    };
  }

  // 有 query → 语义+词法搜索
  return searchMemory({
    pool: ctx.pool,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    subjectId: ctx.subjectId,
    query,
    scope,
    limit,
  });
}

async function executeKnowledgeSearch(
  input: Record<string, unknown>,
  ctx: InlineExecContext,
): Promise<unknown> {
  const query = String(input?.query ?? "");
  if (!query) return { evidence: [], candidateCount: 0 };

  const limit = typeof input?.limit === "number" && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(20, input.limit)) : 5;

  const result = await searchChunksHybrid({
    pool: ctx.pool,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    subjectId: ctx.subjectId,
    query,
    limit,
  });
  return result;
}

async function executeMemoryRecall(
  input: Record<string, unknown>,
  ctx: InlineExecContext,
): Promise<unknown> {
  const query = String(input?.query ?? "");
  const limit = typeof input?.limit === "number" ? Math.max(1, Math.min(20, input.limit)) : 5;
  return searchMemory({
    pool: ctx.pool,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    subjectId: ctx.subjectId,
    query,
    limit,
  });
}

async function executeTaskRecall(ctx: InlineExecContext): Promise<unknown> {
  const { listRecentTaskStates } = await import("../../../modules/memory/repo");
  const tasks = await listRecentTaskStates({
    pool: ctx.pool,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    limit: 10,
  });
  return { tasks };
}

async function executeSystemToolList(
  input: Record<string, unknown>,
  ctx: InlineExecContext,
): Promise<unknown> {
  const { listToolDefinitions } = await import("../../../modules/tools/toolRepo");
  const defs = await listToolDefinitions(ctx.pool, ctx.tenantId);
  return {
    tools: defs.map(d => ({
      name: d.name,
      scope: d.scope,
      riskLevel: d.riskLevel,
      resourceType: d.resourceType,
    })),
  };
}

async function executeEntityList(
  input: Record<string, unknown>,
  ctx: InlineExecContext,
): Promise<unknown> {
  const { listRecords } = await import("../../../modules/data/dataRepo");
  const entityName = String(input?.entityName ?? "");
  const limit = typeof input?.limit === "number" && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(50, input.limit)) : 20;

  const items = await listRecords({
    pool: ctx.pool,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    entityName,
    limit,
    subjectId: ctx.subjectId,
  });

  return {
    entityName,
    items: items.map((r: any) => ({
      id: r.id,
      payload: r.payload,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    totalReturned: items.length,
  };
}

// ─── 安全内联写入：entity.create ─────────────────────────────────

/**
 * 内联执行 entity.create：直接写数据库，绕过工作流管线。
 * 仅用于安全白名单内的实体（schema 中标记 inlineCreatable），避免简单操作走
 * job → run → step → BullMQ → worker → HTTP回调 的重量级链路。
 */
async function executeEntityCreateInline(
  input: Record<string, unknown>,
  ctx: InlineExecContext,
): Promise<unknown> {
  const { insertRecord } = await import("../../../modules/data/dataRepo");
  const { getEffectiveSchema, resolveSchemaNameForEntity } = await import("../../../modules/metadata/schemaRepo");

  const entityName = String(input?.entityName ?? "");
  const resolvedSchemaName = await resolveSchemaNameForEntity({
    pool: ctx.pool,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    entityName,
    requestedSchemaName: typeof input?.schemaName === "string" ? input.schemaName : null,
  });
  if (!resolvedSchemaName.ok) throw new Error(resolvedSchemaName.reason);
  const schemaName = resolvedSchemaName.schemaName;
  const payload = (input?.payload && typeof input.payload === "object" && !Array.isArray(input.payload))
    ? input.payload as Record<string, unknown>
    : {};

  if (!entityName) throw new Error("缺少 entityName");
  if (!Object.keys(payload).length) throw new Error("缺少 payload");

  // 获取 schema 版本号
  const schema = await getEffectiveSchema({
    pool: ctx.pool,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    name: schemaName,
  });
  const schemaVersion = schema?.version ?? 1;

  // 直接写入数据库
  const record = await insertRecord({
    pool: ctx.pool,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    entityName,
    schemaName,
    schemaVersion,
    payload,
    ownerSubjectId: ctx.subjectId,
  });

  ctx.app?.log.info(
    { traceId: ctx.traceId, entityName, recordId: record.id },
    "[InlineToolExecutor] 内联创建实体记录成功",
  );

  return {
    recordId: record.id,
    entityName,
    payload: record.payload,
    createdAt: record.createdAt,
    message: `已成功创建 ${entityName} 记录`,
  };
}

// ─── 安全内联写入：memory.write（低风险类型） ─────────

/**
 * 内联执行 memory.write：直接写入长期记忆，跳过工作流管线。
 * 仅用于低风险记忆类型（preference/note/fact/identity/profile 等），
 * 避免简单的「记住我的名字」走 job → run → step → BullMQ → worker 的重量级链路。
 */
async function executeMemoryWriteInline(
  input: Record<string, unknown>,
  ctx: InlineExecContext,
): Promise<unknown> {
  const scope = input?.scope === "space" ? "space" : "user";
  const type = String(input?.type ?? "other");
  const title = input?.title ? String(input.title) : null;
  const contentText = String(input?.contentText ?? "");

  if (!contentText.trim()) {
    return { error: "记忆内容不能为空", ok: false };
  }

  try {
    const result = await createMemoryEntry({
      pool: ctx.pool,
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      ownerSubjectId: scope === "user" ? ctx.subjectId : null,
      scope,
      type,
      title,
      contentText,
      writeIntent: { policy: "policyAllowed" },
      subjectId: ctx.subjectId,
      sourceRef: { kind: "inline_tool", tool: "memory.write" },
      mergeThreshold: Number(process.env.MEMORY_MERGE_THRESHOLD) || 0.86,
    });

    ctx.app?.log.info(
      { traceId: ctx.traceId, memoryId: result.entry.id, type, title },
      "[InlineToolExecutor] 内联写入记忆成功",
    );

    return {
      entry: {
        id: result.entry.id,
        scope: result.entry.scope,
        type: result.entry.type,
        title: result.entry.title,
        createdAt: result.entry.createdAt,
      },
      dlpSummary: result.dlpSummary,
      riskEvaluation: result.riskEvaluation,
      message: `已成功写入长期记忆`,
    };
  } catch (err: any) {
    ctx.app?.log.error(
      { traceId: ctx.traceId, error: err?.message, type, title },
      "[InlineToolExecutor] 内联写入记忆失败",
    );
    return { error: String(err?.message ?? "写入失败"), ok: false };
  }
}

// ─── 初始化：注册内置工具处理函数 ────────────────────────────────
// 使用注册表模式，新增工具只需调用 registerInlineToolHandler() 即可

registerInlineToolHandler("memory.read", executeMemoryRead);
registerInlineToolHandler("knowledge.search", executeKnowledgeSearch);
registerInlineToolHandler("system.tool.list", executeSystemToolList);
registerInlineToolHandler("memory.recall", executeMemoryRecall);
registerInlineToolHandler("task.recall", (_input, ctx) => executeTaskRecall(ctx));
registerInlineToolHandler("entity.list", executeEntityList);
registerInlineToolHandler("entity.create", executeEntityCreateInline);
registerInlineToolHandler("memory.write", executeMemoryWriteInline);

// ─── 结果格式化：将工具结果转为 LLM 可理解的文本 ────────────────

/**
 * 将内联工具执行结果格式化为注入 LLM follow-up prompt 的文本。
 * LLM 可基于此文本生成面向用户的自然语言回复。
 */
export function formatInlineResultsForLLM(
  results: InlineToolResult[],
  locale: string,
): string {
  if (!results.length) return "";

  const zh = locale !== "en-US";
  const parts: string[] = [
    zh ? "## 工具执行结果" : "## Tool Execution Results",
    zh ? "以下是刚才调用的工具返回的数据，请基于这些数据直接回复用户的问题：\n" : "Below are the results from the tool calls. Use this data to answer the user directly:\n",
  ];

  for (const r of results) {
    const toolName = r.toolRef.replace(/@.*$/, "");
    if (r.ok) {
      const outputStr = typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2);
      // 截断过长输出
      const clipped = outputStr.length > 4000 ? outputStr.slice(0, 4000) + "\n...(已截断)" : outputStr;
      parts.push(`### ${toolName}\n${clipped}\n`);
    } else {
      parts.push(
        zh
          ? `### ${toolName}\n执行失败：${r.error ?? "未知错误"}\n`
          : `### ${toolName}\nExecution failed: ${r.error ?? "unknown error"}\n`,
      );
    }
  }

  return parts.join("\n");
}
