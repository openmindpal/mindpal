/**
 * agentContext.ts — Kernel 可调用的上下文组装工具
 *
 * 从 skills/orchestrator 迁移而来，恢复正确的分层：
 *   kernel → modules (✓)  而非  kernel → skills (✗)
 *
 * 包含：记忆召回 / 任务召回 / 知识召回 / 工具发现
 */
import type { Pool } from "pg";
import { searchMemory, listRecentTaskStates, touchMemoryAccess } from "./memory/repo";
import { computeMinhash, minhashOverlapScore } from "@openslin/shared";
import { getKnowledgeContract } from "./contracts/knowledgeContract";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "agentContext" });
import {
  getLatestReleasedToolVersion,
  listToolDefinitions,
  getToolVersionByRef,
  type ToolDefinition,
  type ToolVersion,
  type ToolPolicyRule,
} from "./tools/toolRepo";
import { resolveEffectiveToolRef } from "./tools/resolve";
import { isToolEnabled } from "./governance/toolGovernanceRepo";
import { insertAuditEvent } from "./audit/auditRepo";

// ─── 工具类型 ─────────────────────────────────────────────────────

export type EnabledTool = { name: string; toolRef: string; def: ToolDefinition; ver: ToolVersion | null };

// ─── 内部辅助 ─────────────────────────────────────────────────────

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function memoryRecallLimit() {
  const raw = Number(process.env.ORCHESTRATOR_MEMORY_RECALL_LIMIT ?? "20");
  return clampInt(Number.isFinite(raw) ? Math.floor(raw) : 20, 0, 50);
}

const MEMORY_RECALL_MAX_CHARS = Math.max(500, Number(process.env.ORCHESTRATOR_MEMORY_RECALL_MAX_CHARS) || 3000);
const TASK_RECALL_MAX_CHARS = Math.max(500, Number(process.env.ORCHESTRATOR_TASK_RECALL_MAX_CHARS) || 1500);
const TASK_RECALL_LIMIT = 8;
const TOOLS_CATALOG_MAX_CHARS = Math.max(1000, Number(process.env.ORCHESTRATOR_TOOLS_CATALOG_MAX_CHARS) || 8000);

// 元数据驱动：pinned 工具完全由 DB tool_policy_rules 的 pinned 规则决定，不硬编码 fallback。

const KNOWLEDGE_RECALL_LIMIT = 3;
const KNOWLEDGE_RECALL_MAX_CHARS = 2000;

/** P2: 策略记忆召回配置 */
const STRATEGY_RECALL_LIMIT = 5;
const STRATEGY_RECALL_MAX_CHARS = 2000;

function knowledgeRecallLimit() {
  const raw = Number(process.env.AGENT_KNOWLEDGE_RECALL_LIMIT ?? String(KNOWLEDGE_RECALL_LIMIT));
  return clampInt(Number.isFinite(raw) ? Math.floor(raw) : KNOWLEDGE_RECALL_LIMIT, 0, 10);
}

function i18nText(v: unknown, locale: string): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const obj = v as Record<string, string>;
    return String(obj[locale] ?? obj["zh-CN"] ?? Object.values(obj)[0] ?? "");
  }
  return String(v);
}

// ─── 查询分解 ─────────────────────────────────────────────────────

/**
 * 将复合消息分解为独立子查询。
 * TODO: 接入 LLM 查询分解（需要 FastifyInstance 才能调用 invokeModelChat）
 * 当前实现为纯标点分割降级方案。
 * 超时或失败时返回 null，由调用方降级处理。
 */
async function decomposeQuery(message: string): Promise<string[] | null> {
  try {
    // TODO: 接入 LLM 查询分解
    // 当 recallRelevantMemory 支持传入 app (FastifyInstance) 后，可使用 invokeModelChat：
    // prompt: "将用户消息拆分为独立的信息检索子查询。每行一个子查询，不加编号，不解释。如果消息只有一个意图则原样返回。"
    // 设置 2 秒超时 via AbortController

    // 降级方案：标点分割
    const parts = message
      .split(/[？?。！!；;，,\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 2)
      .slice(0, 4);
    return parts.length > 1 ? parts : null;
  } catch {
    return null; // 超时或失败时返回 null
  }
}

// ─── 记忆召回 ─────────────────────────────────────────────────────

export async function recallRelevantMemory(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  message: string;
  auditContext?: { traceId?: string; requestId?: string };
  /** P1-3 Memory OS: 可选多查询维度（例如 GoalGraph 子目标描述） */
  additionalQueries?: string[];
}): Promise<{ text: string; recallStats?: { evidenceCount: number; searchMode: string; retryTriggered?: boolean } }> {
  const limit = memoryRecallLimit();
  if (limit <= 0) return { text: "" };
  try {
    const querySlice = params.message.slice(0, 500);

    // P1-3 Memory OS: 多维度召回——主查询 + 额外查询并行执行，合并去重
    const queries = [querySlice];
    if (params.additionalQueries?.length) {
      for (const aq of params.additionalQueries.slice(0, 3)) {
        const trimmed = aq.trim().slice(0, 300);
        if (trimmed && !queries.includes(trimmed)) queries.push(trimmed);
      }
    }

    const searchPromises = queries.map(q =>
      searchMemory({
        pool: params.pool,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        subjectId: params.subjectId,
        query: q,
        limit: Math.ceil(limit / queries.length) + 2,
      }),
    );
    const searchResults = await Promise.all(searchPromises);

    // 合并去重
    const seen = new Set<string>();
    const allEvidence: typeof searchResults[0]["evidence"] = [];
    let searchMode = "lexical_only";
    for (const sr of searchResults) {
      if (sr.searchMode === "hybrid" || sr.searchMode === "hybrid_dense") searchMode = sr.searchMode;
      for (const e of sr.evidence ?? []) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          allEvidence.push(e);
        }
      }
    }

    // ─── 二阶段检索：当第一阶段结果不足时触发重试 ───
    const RETRY_THRESHOLD = 3;
    const needsRetry = allEvidence.length < RETRY_THRESHOLD && params.message.length > 30;
    let retryTriggered = false;

    if (needsRetry) {
      try {
        let subQueries: string[] | null = null;
        try {
          subQueries = await decomposeQuery(params.message);
        } catch {
          subQueries = null;
        }
        // 降级到标点分割
        if (!subQueries || subQueries.length === 0) {
          subQueries = params.message
            .split(/[？?。！!；;，,\n]+/)
            .filter(s => s.trim().length > 2)
            .map(s => s.trim())
            .slice(0, 4);
        }
        if (subQueries.length > 0) {
          const retryPromises = subQueries.map(q =>
            searchMemory({
              pool: params.pool,
              tenantId: params.tenantId,
              spaceId: params.spaceId,
              subjectId: params.subjectId,
              query: q.slice(0, 300),
              limit: Math.ceil(limit / subQueries!.length) + 2,
            }),
          );
          const retryResults = await Promise.all(retryPromises);
          for (const sr of retryResults) {
            if (sr.searchMode === "hybrid" || sr.searchMode === "hybrid_dense") searchMode = sr.searchMode;
            for (const e of sr.evidence ?? []) {
              if (!seen.has(e.id)) {
                seen.add(e.id);
                allEvidence.push(e);
              }
            }
          }
          retryTriggered = true;
        }
      } catch (retryErr) {
        _logger.warn("recallRelevantMemory retry phase failed", { err: (retryErr as Error)?.message });
      }
    }

    // 元数据管线（minhash + 12因子 rerank）已完成语义召回与质量排序，直接截断
    const evidence = allEvidence.slice(0, limit);
    if (!evidence.length) return { text: "" };

    // P1-3 Memory OS: 更新访问计数（不阻塞主流程）
    const recalledIds = evidence.map(e => e.id);
    touchMemoryAccess({ pool: params.pool, tenantId: params.tenantId, memoryIds: recalledIds }).catch(() => {});

    let totalChars = 0;
    const lines: string[] = [];
    for (const e of evidence) {
      let line = `- [记忆 #${e.id}] 类型: ${e.type ?? "memory"}${e.title ? ", 标题: " + e.title : ""}, 内容: ${e.snippet}`;
      if (e.conflictMarker && e.resolutionStatus === "pending") {
        line += ` [⚠ 存在冲突，需用户确认]`;
      }
      if (totalChars + line.length > MEMORY_RECALL_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }

    if (params.auditContext?.traceId) {
      insertAuditEvent(params.pool, {
        subjectId: params.subjectId,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        resourceType: "memory",
        action: "recall",
        inputDigest: { queryLen: querySlice.length, limit, queryCount: queries.length },
        outputDigest: { evidenceCount: evidence.length, returnedCount: lines.length, searchMode, totalChars },
        result: "success",
        traceId: params.auditContext.traceId,
        requestId: params.auditContext.requestId,
      }).catch(() => {});
    }

    return { text: lines.join("\n"), recallStats: { evidenceCount: evidence.length, searchMode, retryTriggered } };
  } catch (err) {
    _logger.warn("recallRelevantMemory failed", { err: (err as Error)?.message });
    return { text: "" };
  }
}

// ─── P2: 策略记忆召回（procedural 级） ─────────────────────────────

/**
 * 专用召回 procedural 级策略记忆。
 *
 * 与 recallRelevantMemory 的区别：
 * - 仅检索 memory_class='procedural' 且 type='strategy' 的记忆
 * - 不与一般记忆混在一起，在 prompt 中独立呈现，权重更高
 * - 优先召回高置信度、近期生成的策略
 *
 * 这些策略由 activeReflexion 引擎写入，包含可操作的规划建议。
 */
export async function recallProceduralStrategies(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  goal: string;
  auditContext?: { traceId?: string; requestId?: string; subjectId?: string };
}): Promise<{ text: string; strategyCount: number }> {
  const limit = STRATEGY_RECALL_LIMIT;
  try {
    const goalSlice = params.goal.slice(0, 500);

    // 直接查询 procedural 策略记忆，按置信度 + 新鲜度排序
    const res = await params.pool.query<{
      id: string;
      title: string | null;
      content_text: string;
      confidence: number;
      created_at: string;
      embedding_minhash: number[] | null;
    }>(
      `SELECT id, title, content_text, confidence, created_at, embedding_minhash
       FROM memory_entries
       WHERE tenant_id = $1
         AND space_id = $2
         AND memory_class = 'procedural'
         AND type = 'strategy'
         AND deleted_at IS NULL
         AND decay_score > 0.1
       ORDER BY confidence DESC, created_at DESC
       LIMIT $3`,
      [params.tenantId, params.spaceId, limit],
    );

    const rows = res.rows ?? [];
    if (!rows.length) return { text: "", strategyCount: 0 };

    // 元数据过滤：高置信度无条件保留 + minhash 语义匹配
    const goalMinhash = computeMinhash(goalSlice);
    const relevant = rows.filter(r => {
      if (r.confidence >= 0.8) return true;
      const mh = Array.isArray(r.embedding_minhash) ? r.embedding_minhash : [];
      const strategyOverlap = Number(process.env.MEMORY_STRATEGY_OVERLAP_THRESHOLD) || 0.15;
      if (mh.length && minhashOverlapScore(goalMinhash, mh) >= strategyOverlap) return true;
      return false;
    });

    if (!relevant.length) return { text: "", strategyCount: 0 };

    // 更新访问计数（不阻塞）
    const ids = relevant.map(r => r.id);
    touchMemoryAccess({ pool: params.pool, tenantId: params.tenantId, memoryIds: ids }).catch(() => {});

    let totalChars = 0;
    const lines: string[] = [];
    for (const r of relevant) {
      const snippet = (r.content_text ?? "").slice(0, 400);
      const conf = typeof r.confidence === "number" ? ` (confidence=${r.confidence.toFixed(2)})` : "";
      const line = `- [strategy] ${r.title ? r.title + ": " : ""}${snippet}${conf}`;
      if (totalChars + line.length > STRATEGY_RECALL_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }

    // 审计
    if (params.auditContext?.traceId && params.auditContext?.subjectId) {
      insertAuditEvent(params.pool, {
        subjectId: params.auditContext.subjectId,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        resourceType: "memory",
        action: "strategy_recall",
        inputDigest: { goalLen: goalSlice.length, limit },
        outputDigest: { totalFound: rows.length, relevant: relevant.length, returned: lines.length, totalChars },
        result: "success",
        traceId: params.auditContext.traceId,
        requestId: params.auditContext.requestId,
      }).catch(() => {});
    }

    return { text: lines.join("\n"), strategyCount: lines.length };
  } catch (err) {
    _logger.warn("recallProceduralStrategies failed", { err: (err as Error)?.message });
    return { text: "", strategyCount: 0 };
  }
}


// ─── 任务召回 ─────────────────────────────────────────────────────

export async function recallRecentTasks(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId?: string;
  auditContext?: { traceId?: string; requestId?: string };
}): Promise<{ text: string; recallStats?: { taskCount: number } }> {
  try {
    const tasks = await listRecentTaskStates({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      limit: TASK_RECALL_LIMIT,
      subjectId: params.subjectId,
    });
    if (!tasks.length) return { text: "" };

    let totalChars = 0;
    const lines: string[] = [];
    for (const t of tasks) {
      const planSummary = t.plan && typeof t.plan === "object"
        ? (Array.isArray(t.plan.steps) ? `${t.plan.steps.length} steps` : "has plan")
        : "no plan";
      const line = `- [${t.phase}] run=${t.runId.slice(0, 8)}… ${planSummary}, updated=${t.updatedAt}`;
      if (totalChars + line.length > TASK_RECALL_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }

    if (params.auditContext?.traceId && params.subjectId) {
      insertAuditEvent(params.pool, {
        subjectId: params.subjectId,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        resourceType: "memory",
        action: "task_recall",
        inputDigest: { limit: TASK_RECALL_LIMIT },
        outputDigest: { taskCount: tasks.length, returnedCount: lines.length, totalChars },
        result: "success",
        traceId: params.auditContext.traceId,
        requestId: params.auditContext.requestId,
      }).catch(() => {});
    }

    return { text: lines.join("\n"), recallStats: { taskCount: tasks.length } };
  } catch (err) {
    _logger.warn("recallRecentTasks failed", { err: (err as Error)?.message });
    return { text: "" };
  }
}

// ─── 知识召回 ─────────────────────────────────────────────────────

export async function recallRelevantKnowledge(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  message: string;
  auditContext?: { traceId?: string; requestId?: string };
}): Promise<{ text: string; recallStats?: { hitCount: number } }> {
  const limit = knowledgeRecallLimit();
  if (limit <= 0) return { text: "" };
  try {
    const querySlice = params.message.slice(0, 500);
    const result = await getKnowledgeContract().searchChunksHybrid({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      query: querySlice,
      limit,
    });
    const hits = result.hits ?? [];
    if (!hits.length) return { text: "" };

    let totalChars = 0;
    const lines: string[] = [];
    for (const h of hits) {
      const snippet = String(h.snippet ?? "").slice(0, 500);
      const line = `- [knowledge] ${snippet}`;
      if (totalChars + line.length > KNOWLEDGE_RECALL_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }

    if (params.auditContext?.traceId) {
      insertAuditEvent(params.pool, {
        subjectId: params.subjectId,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        resourceType: "knowledge",
        action: "recall",
        inputDigest: { queryLen: querySlice.length, limit },
        outputDigest: { hitCount: hits.length, returnedCount: lines.length, totalChars },
        result: "success",
        traceId: params.auditContext.traceId,
        requestId: params.auditContext.requestId,
      }).catch(() => {});
    }

    return { text: lines.join("\n"), recallStats: { hitCount: hits.length } };
  } catch (err) {
    _logger.warn("recallRelevantKnowledge failed", { err: (err as Error)?.message });
    return { text: "" };
  }
}

// ─── 工具发现 ─────────────────────────────────────────────────────

/**
 * P1-2 FIX: 工具发现缓存
 * 按 tenantId:spaceId:locale 缓存 discoverEnabledTools 结果，避免每次对话都完整查 DB。
 * TTL 可通过环境变量 TOOL_DISCOVERY_CACHE_TTL_MS 配置（默认 60s）。
 */
const _toolDiscoveryCache = new Map<string, { result: { catalog: string; tools: EnabledTool[] }; expiresAt: number }>();
const TOOL_DISCOVERY_CACHE_TTL_MS = Math.max(5000, Number(process.env.TOOL_DISCOVERY_CACHE_TTL_MS) || 60_000);
const TOOL_DISCOVERY_CACHE_MAX_ENTRIES = 100;

function _toolDiscoveryCacheKey(tenantId: string, spaceId: string, locale: string, category?: string, query?: string, includeHiddenTools?: boolean): string {
  return `${tenantId}:${spaceId}:${locale}:${category ?? ""}:${query ?? ""}:${includeHiddenTools ? "all" : "planner"}`;
}

// ── tool_policy_rules 缓存加载 ──
let _policyCache: ToolPolicyRule[] | null = null;
let _policyCacheAt = 0;
const POLICY_CACHE_TTL_MS = 60_000;

async function loadToolPolicyRules(pool: Pool, tenantId: string): Promise<ToolPolicyRule[]> {
  if (_policyCache && Date.now() - _policyCacheAt < POLICY_CACHE_TTL_MS) {
    return _policyCache;
  }
  try {
    const { rows } = await pool.query(
      `SELECT rule_type, match_field, match_pattern, effect, enabled
       FROM tool_policy_rules WHERE tenant_id = $1 AND enabled = true`,
      [tenantId],
    );
    _policyCache = rows;
    _policyCacheAt = Date.now();
    return _policyCache;
  } catch {
    return _policyCache ?? [];
  }
}

function isPlannerVisibleTool(
  def: ToolDefinition,
  hiddenRules: ToolPolicyRule[],
): boolean {
  for (const rule of hiddenRules) {
    if (rule.rule_type !== "hidden") continue;
    switch (rule.match_field) {
      case "prefix":
        if (def.name.startsWith(rule.match_pattern)) return false;
        break;
      case "tag":
        if (def.tags.some(t => String(t).toLowerCase() === rule.match_pattern.toLowerCase())) return false;
        break;
      case "name":
        if (def.name === rule.match_pattern) return false;
        break;
    }
  }
  return true;
}

/** 清除工具目录查询缓存（工具配置变更时可调用，TTL 过期后也会自动失效） */
export function invalidateToolCatalogQueryCache(tenantId?: string): void {
  if (!tenantId) {
    _toolDiscoveryCache.clear();
    return;
  }
  for (const [key] of _toolDiscoveryCache) {
    if (key.startsWith(tenantId + ":")) _toolDiscoveryCache.delete(key);
  }
}

export async function discoverEnabledTools(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  locale: string;
  /** P2: 可选-按分类过滤 */
  category?: string;
  /** P2: 可选-返回数量限制（默认不限） */
  limit?: number;
  /** P2: 可选-搜索关键词（用于标签匹配） */
  query?: string;
  /** P1-2: 跳过缓存（强制刷新） */
  skipCache?: boolean;
  /** 包含默认不暴露给规划层的内部/原语工具 */
  includeHiddenTools?: boolean;
}): Promise<{ catalog: string; tools: EnabledTool[] }> {
  try {
    // P1-2 FIX: 优先从缓存读取
    const cacheKey = _toolDiscoveryCacheKey(params.tenantId, params.spaceId, params.locale, params.category, params.query, params.includeHiddenTools);
    if (!params.skipCache) {
      const cached = _toolDiscoveryCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }
    }
    const defs = await listToolDefinitions(params.pool, params.tenantId);
    if (!defs.length) return { catalog: "", tools: [] };

    // 从 DB 加载 tool_policy_rules
    const policyRules = await loadToolPolicyRules(params.pool, params.tenantId);
    const hiddenRules = policyRules.filter(r => r.rule_type === "hidden");

    // P2: 按分类过滤
    let filteredDefs = params.includeHiddenTools ? defs : defs.filter(d => isPlannerVisibleTool(d, hiddenRules));
    if (params.category) {
      filteredDefs = filteredDefs.filter(d => d.category === params.category);
    }

    // P2: 按标签搜索
    if (params.query) {
      const queryLower = params.query.toLowerCase();
      filteredDefs = filteredDefs.filter(d => {
        // 匹配标签
        if (d.tags.some(tag => tag.toLowerCase().includes(queryLower))) return true;
        // 匹配名称
        if (d.name.toLowerCase().includes(queryLower)) return true;
        // 匹配描述
        const desc = i18nText(d.description, params.locale).toLowerCase();
        if (desc.includes(queryLower)) return true;
        return false;
      });
    }

    // P2: 按优先级排序（高优先级在前），其次按名称
    const sortedDefs = [...filteredDefs].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.name.localeCompare(b.name);
    });

    // 从 DB 规则构建 pinned 顺序
    const pinnedRules = policyRules
      .filter(r => r.rule_type === "pinned")
      .sort((a, b) => (a.effect.pinnedOrder ?? 99) - (b.effect.pinnedOrder ?? 99));
    const pinnedNames = pinnedRules.map(r => r.match_pattern);
    // 元数据驱动：pinned 顺序完全来自 DB tool_policy_rules 规则
    const effectivePinnedNames = pinnedNames;

    const pinned: ToolDefinition[] = [];
    for (const n of effectivePinnedNames) {
      const d = sortedDefs.find(x => x.name === n);
      if (d) pinned.push(d);
    }
    const pinnedNameSet = new Set(effectivePinnedNames);
    const orderedDefs = [...pinned, ...sortedDefs.filter(d => !pinnedNameSet.has(d.name))];

    const toolResults = await Promise.all(orderedDefs.map(async (def): Promise<EnabledTool | null> => {
      try {
        let effRef = await resolveEffectiveToolRef({
          pool: params.pool,
          tenantId: params.tenantId,
          spaceId: params.spaceId,
          name: def.name,
        });
        if (!effRef) return null;
        let enabled = await isToolEnabled({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, toolRef: effRef });
        if (!enabled) {
          const latest = await getLatestReleasedToolVersion(params.pool, params.tenantId, def.name);
          const latestRef = latest?.toolRef ?? null;
          if (latestRef && latestRef !== effRef) {
            const enabled2 = await isToolEnabled({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, toolRef: latestRef });
            if (enabled2) {
              effRef = latestRef;
              enabled = true;
            }
          }
        }
        if (!enabled) return null;
        const ver = await getToolVersionByRef(params.pool, params.tenantId, effRef);
        if (!ver || ver.status !== "released") return null;
        return { name: def.name, toolRef: effRef, def, ver };
      } catch {
        return null;
      }
    }));
    const enabledTools: EnabledTool[] = toolResults.filter((t): t is EnabledTool => t !== null);
    if (!enabledTools.length) {
      // P1-2: 空结果也缓存（避免反复查 DB），但 TTL 更短
      const emptyResult = { catalog: "", tools: [] as EnabledTool[] };
      _toolDiscoveryCache.set(cacheKey, { result: emptyResult, expiresAt: Date.now() + Math.min(TOOL_DISCOVERY_CACHE_TTL_MS, 15_000) });
      return emptyResult;
    }

    let totalChars = 0;
    const lines: string[] = [];
    const effectiveLimit = params.limit ?? Infinity;
    let toolCount = 0;
    
    for (const t of enabledTools) {
      // P2: 应用数量限制
      if (toolCount >= effectiveLimit) break;
      
      const displayName = i18nText(t.def.displayName, params.locale) || t.name;
      const desc = i18nText(t.def.description, params.locale);
      const inputFields = t.ver?.inputSchema?.fields
        ? Object.entries(t.ver.inputSchema.fields as Record<string, any>)
            .map(([k, v]) => `${k}:${v?.type ?? "string"}${v?.required ? "*" : ""}`)
            .join(", ")
        : "";
      const line = `- ${t.toolRef} | ${displayName}${desc ? ": " + desc : ""}${inputFields ? " | input: {" + inputFields + "}" : ""} | risk=${t.def.riskLevel} | priority=${t.def.priority}${t.def.category !== 'uncategorized' ? ' | category=' + t.def.category : ''}`;
      if (totalChars + line.length > TOOLS_CATALOG_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
      toolCount++;
    }
    const result = { catalog: lines.join("\n"), tools: enabledTools };

    // P1-2 FIX: 写入缓存，超出最大条目数时清理最旧的
    if (_toolDiscoveryCache.size >= TOOL_DISCOVERY_CACHE_MAX_ENTRIES) {
      const firstKey = _toolDiscoveryCache.keys().next().value;
      if (firstKey !== undefined) _toolDiscoveryCache.delete(firstKey);
    }
    _toolDiscoveryCache.set(cacheKey, { result, expiresAt: Date.now() + TOOL_DISCOVERY_CACHE_TTL_MS });

    return result;
  } catch (err) {
    _logger.warn("discoverEnabledTools failed", { err: (err as Error)?.message });
    return { catalog: "", tools: [] };
  }
}
