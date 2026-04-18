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
import {
  getLatestReleasedToolVersion,
  listToolDefinitions,
  getToolVersionByRef,
  type ToolDefinition,
  type ToolVersion,
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
  const raw = Number(process.env.ORCHESTRATOR_MEMORY_RECALL_LIMIT ?? "10");
  return clampInt(Number.isFinite(raw) ? Math.floor(raw) : 10, 0, 30);
}

const MEMORY_RECALL_MAX_CHARS = Math.max(500, Number(process.env.ORCHESTRATOR_MEMORY_RECALL_MAX_CHARS) || 3000);
const TASK_RECALL_MAX_CHARS = Math.max(500, Number(process.env.ORCHESTRATOR_TASK_RECALL_MAX_CHARS) || 1500);
const TASK_RECALL_LIMIT = 8;
const TOOLS_CATALOG_MAX_CHARS = Math.max(1000, Number(process.env.ORCHESTRATOR_TOOLS_CATALOG_MAX_CHARS) || 8000);
const PINNED_TOOL_NAMES = [
  "knowledge.search", "memory.read", "memory.write",
  "nl2ui.generate",
  "entity.create", "entity.update", "entity.delete",
] as const;

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
}): Promise<{ text: string; recallStats?: { evidenceCount: number; searchMode: string } }> {
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

    // 元数据管线（minhash + 12因子 rerank）已完成语义召回与质量排序，直接截断
    const evidence = allEvidence.slice(0, limit);
    if (!evidence.length) return { text: "" };

    // P1-3 Memory OS: 更新访问计数（不阻塞主流程）
    const recalledIds = evidence.map(e => e.id);
    touchMemoryAccess({ pool: params.pool, tenantId: params.tenantId, memoryIds: recalledIds }).catch(() => {});

    let totalChars = 0;
    const lines: string[] = [];
    for (const e of evidence) {
      const line = `- [${e.type ?? "memory"}] ${e.title ? e.title + ": " : ""}${e.snippet}`;
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

    return { text: lines.join("\n"), recallStats: { evidenceCount: evidence.length, searchMode } };
  } catch (err) {
    console.warn("[recallRelevantMemory] failed:", err);
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
    console.warn("[recallProceduralStrategies] failed:", err);
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
    console.warn("[recallRecentTasks] failed:", err);
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
    console.warn("[recallRelevantKnowledge] failed:", err);
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

function isPlannerVisibleTool(def: ToolDefinition): boolean {
  if (def.name.startsWith("device.")) return false;
  const hiddenTags = new Set(["planner:hidden", "internal-only"]);
  return !def.tags.some((tag) => hiddenTags.has(String(tag).toLowerCase()));
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

    // P2: 按分类过滤
    let filteredDefs = params.includeHiddenTools ? defs : defs.filter(isPlannerVisibleTool);
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

    const pinned: ToolDefinition[] = [];
    for (const n of PINNED_TOOL_NAMES) {
      const d = sortedDefs.find((x) => x.name === n);
      if (d) pinned.push(d);
    }
    const pinnedNameSet = new Set<string>(PINNED_TOOL_NAMES as unknown as string[]);
    const orderedDefs = [...pinned, ...sortedDefs.filter((d) => !pinnedNameSet.has(d.name))];

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
    console.warn("[discoverEnabledTools] failed:", err);
    return { catalog: "", tools: [] };
  }
}
