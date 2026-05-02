/**
 * agentContext.ts — Kernel 可调用的上下文组装工具
 *
 * 从 skills/orchestrator 迁移而来，恢复正确的分层：
 *   kernel → modules (✓)  而非  kernel → skills (✗)
 *
 * 包含：记忆召回 / 任务召回 / 知识召回 / 工具发现
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { searchMemory, listRecentTaskStates, touchMemoryAccess } from "./memory/repo";
import { computeMinhash, minhashOverlapScore } from "@mindpal/shared";
import type { ToolSemanticMeta } from "@mindpal/shared";
import { getKnowledgeContract } from "./contracts/knowledgeContract";
import { StructuredLogger } from "@mindpal/shared";
import { invokeModelChat } from "../lib/llm";

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

/** P4: 从现有工具元数据自动推断语义，显式 semantic_meta 覆盖推断值 */
export function inferSemanticMeta(def: { scope?: string | null; riskLevel?: string; category?: string; semanticMeta?: ToolSemanticMeta | null }): ToolSemanticMeta {
  const base: ToolSemanticMeta = {
    operationType: def.scope === "write" ? "write" : "read",
    precisionLevel: def.riskLevel === "high" ? "best_effort" : "exact",
    sideEffects: def.scope === "write" ? [def.category ?? "unknown"] : [],
    semanticEquivalents: [],
    notEquivalentTo: [],
  };
  if (def.semanticMeta) return { ...base, ...def.semanticMeta };
  return base;
}

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
const STRATEGY_RECALL_LIMIT = Math.max(1, Number(process.env.STRATEGY_RECALL_LIMIT) || 5);
const STRATEGY_RECALL_MAX_CHARS = Math.max(200, Number(process.env.STRATEGY_RECALL_MAX_CHARS) || 2000);
const CONFIDENCE_THRESHOLD = Math.max(0, Number(process.env.STRATEGY_RECALL_CONFIDENCE_THRESHOLD) || 0.65);
const DECAY_THRESHOLD = Math.max(0, Number(process.env.STRATEGY_RECALL_DECAY_THRESHOLD) || 0.1);

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

/** 按中英文标点将文本拆分为子句 */
function splitBySentence(text: string, maxParts = 4): string[] {
  return text.split(/[？?。！!；;，,\n]+/).map(s => s.trim()).filter(s => s.length > 2).slice(0, maxParts);
}

// ─── 查询分解 ─────────────────────────────────────────────────────

interface DecomposedQuery {
  subQueries: Array<{
    intent: string;          // 子意图描述
    searchQuery: string;     // 优化后的检索查询
    priority: 'critical' | 'supporting';
  }>;
  implicitConstraints: string[];  // 提取的隐式约束
}

const decomposeCache = new Map<string, DecomposedQuery>();
const DECOMPOSE_CACHE_MAX = 200;

const DECOMPOSE_SYSTEM_PROMPT = `你是一个查询分解引擎。将用户的复合消息分解为独立的信息检索子查询。
返回严格的 JSON，不要附加任何解释文字。
格式：
{
  "subQueries": [
    { "intent": "子意图描述", "searchQuery": "优化后的检索查询", "priority": "critical" | "supporting" }
  ],
  "implicitConstraints": ["提取的隐式约束"]
}
规则：
- 如果消息只有单一意图，返回包含一个 subQuery 的数组
- priority=critical 表示核心信息需求，supporting 表示辅助上下文
- implicitConstraints 提取时间、范围、身份等隐含限定条件
- subQueries 最多 4 个`;

/**
 * 将复合消息分解为独立子查询。
 * 当 app 可用时调用 LLM 做结构化分解，失败时 fallback 到 splitBySentence。
 */
async function decomposeQuery(message: string, app?: FastifyInstance): Promise<DecomposedQuery | null> {
  const cacheKey = message.slice(0, 500);
  const cached = decomposeCache.get(cacheKey);
  if (cached) return cached;

  // 有 app 时尝试 LLM 分解
  if (app) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const result = await invokeModelChat({
        app,
        subject: { tenantId: "system", subjectId: "query_decompose" },
        locale: "zh-CN",
        purpose: "query_decompose",
        messages: [
          { role: "system", content: DECOMPOSE_SYSTEM_PROMPT },
          { role: "user", content: message.slice(0, 800) },
        ],
        timeoutMs: 3000,
      });
      clearTimeout(timer);

      const text = (result?.outputText ?? "").trim();
      // 提取 JSON（兼容 markdown 代码块包裹）
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as DecomposedQuery;
        if (Array.isArray(parsed.subQueries) && parsed.subQueries.length > 0) {
          // 规范化
          const normalized: DecomposedQuery = {
            subQueries: parsed.subQueries.slice(0, 4).map(sq => ({
              intent: String(sq.intent ?? ""),
              searchQuery: String(sq.searchQuery ?? ""),
              priority: sq.priority === "supporting" ? "supporting" : "critical",
            })),
            implicitConstraints: Array.isArray(parsed.implicitConstraints)
              ? parsed.implicitConstraints.map(String).slice(0, 5)
              : [],
          };
          // 写入缓存
          if (decomposeCache.size >= DECOMPOSE_CACHE_MAX) {
            const firstKey = decomposeCache.keys().next().value;
            if (firstKey !== undefined) decomposeCache.delete(firstKey);
          }
          decomposeCache.set(cacheKey, normalized);
          return normalized;
        }
      }
    } catch (err) {
      _logger.warn("decomposeQuery LLM failed, falling back to splitBySentence", { err: (err as Error)?.message });
    }
  }

  // fallback：标点分割转为 DecomposedQuery 格式
  const parts = splitBySentence(message);
  if (parts.length <= 1) return null;

  const fallback: DecomposedQuery = {
    subQueries: parts.map(p => ({ intent: p, searchQuery: p, priority: "critical" as const })),
    implicitConstraints: [],
  };
  return fallback;
}

// ─── 交错轮询截断算法 ─────────────────────────────────────────────

/**
 * 交错轮询合并：按 type 分组，每轮从每个类型组取 1 条，
 * 组间按最高分（score 字段）降序排列，确保高相关性类型优先。
 * 第 1 轮 = 每组 top-1，第 2 轮 = 每组 top-2，依次类推。
 */
export function interleavedRoundRobin<T extends { type?: string | null; score?: number }>(
  items: T[],
): T[] {
  // 按 type 分组，每组内保持原始顺序
  const byType = new Map<string, T[]>();
  for (const e of items) {
    const key = (e.type as string) ?? "memory";
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(e);
  }

  const sorted: T[] = [];
  let round = 0;
  let added = true;
  while (added) {
    added = false;
    const groups = [...byType.entries()]
      .filter(([, arr]) => arr.length > round)
      .sort((a, b) => {
        // 按各组最高分（第 0 条）降序排列
        const scoreA = (a[1][0] as any)?.score ?? 0;
        const scoreB = (b[1][0] as any)?.score ?? 0;
        return scoreB - scoreA;
      });
    for (const [, arr] of groups) {
      if (round < arr.length) {
        sorted.push(arr[round]!);
        added = true;
      }
    }
    round++;
  }
  return sorted;
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
  /** P2: 可选 FastifyInstance，传入后启用 LLM 语义查询分解 */
  app?: FastifyInstance;
}): Promise<{
  text: string;
  recallStats?: { evidenceCount: number; searchMode: string; retryTriggered?: boolean };
  /** P2-召回反哺: LLM / 子查询覆盖率检测到的信息缺口 */
  informationGaps?: string[];
  /** P2-召回反哺: 召回内容摘要，供 planner 快速判断已知范围 */
  recallSummary?: string;
}> {
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
        limit: Math.max(Math.ceil(limit / queries.length) + 2, 10),
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
        let decomposed: DecomposedQuery | null = null;
        try {
          decomposed = await decomposeQuery(params.message, params.app);
        } catch {
          decomposed = null;
        }

        // 从 DecomposedQuery 提取 searchQuery 列表，fallback 到标点分割
        let subQueries: string[];
        if (decomposed && decomposed.subQueries.length > 0) {
          // 优先使用 critical 查询，其次 supporting
          const sorted = [...decomposed.subQueries].sort((a, b) =>
            a.priority === "critical" && b.priority !== "critical" ? -1 :
            b.priority === "critical" && a.priority !== "critical" ? 1 : 0,
          );
          subQueries = sorted.map(sq => sq.searchQuery).filter(q => q.length > 2);
        } else {
          subQueries = splitBySentence(params.message);
        }

        if (subQueries.length > 0) {
          const retryPromises = subQueries.map(q =>
            searchMemory({
              pool: params.pool,
              tenantId: params.tenantId,
              spaceId: params.spaceId,
              subjectId: params.subjectId,
              query: q.slice(0, 300),
              limit: Math.ceil(limit / subQueries.length) + 2,
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

    // ─── P2: 分层召回与相关性过滤 ───
    // 1. 相关性评分：使用 minhash overlap 作为轻量相关性指标
    const queryMinhash = computeMinhash(params.message.slice(0, 500));
    const scoredEvidence = allEvidence.map(e => {
      // 基于 snippet 文本计算 minhash overlap 作为相关性分数
      const snippetText = (e.title ? e.title + " " : "") + (e.snippet ?? "");
      const snippetMinhash = computeMinhash(snippetText);
      const minhashScore = minhashOverlapScore(queryMinhash, snippetMinhash);
      // 词法命中补偿：snippet 包含查询关键词时加分
      const queryLower = params.message.slice(0, 100).toLowerCase();
      const lexicalHit = snippetText.toLowerCase().includes(queryLower) ? 0.4 : 0;
      const relevanceScore = Math.min(1, minhashScore + lexicalHit);
      return { ...e, _relevanceScore: relevanceScore };
    });

    // 自适应阈值：取最高分的一定比例作为截断线
    const scores = scoredEvidence.map(e => e._relevanceScore);
    const maxScore = Math.max(...scores, 0.01);
    const adaptiveThreshold = maxScore * 0.3;
    const filtered = scoredEvidence.filter(e => e._relevanceScore >= adaptiveThreshold);

    // 2. 分层注入：按 priority 标签分组（由 decomposeQuery 二阶段检索赋予）
    // evidence 来自不同子查询——使用查询顺序推断优先级
    // critical 子查询结果优先注入（60% 预算），supporting 次之（30%），其余 10%
    let decomposed: DecomposedQuery | null = null;
    if (!needsRetry && params.message.length > 20) {
      // 仅在未触发 retry 时做 decompose（retry 路径内部已使用 decompose）
      try { decomposed = await decomposeQuery(params.message, params.app); } catch { decomposed = null; }
    }

    // 标记 evidence 的优先级：基于其 snippet 与各 sub-query 的匹配度
    type PrioritizedEvidence = typeof filtered[number] & { _priority: 'critical' | 'supporting' | 'other' };
    let prioritized: PrioritizedEvidence[];

    if (decomposed && decomposed.subQueries.length > 1) {
      prioritized = filtered.map(e => {
        const snippetLower = ((e.title ?? "") + " " + (e.snippet ?? "")).toLowerCase();
        let bestPriority: 'other' = 'other';
        for (const sq of decomposed!.subQueries) {
          const sqLower = sq.searchQuery.toLowerCase();
          if (sqLower.length >= 2 && snippetLower.includes(sqLower.slice(0, 30))) {
            if (sq.priority === 'critical') { bestPriority = 'critical' as any; break; }
            if (sq.priority === 'supporting') bestPriority = 'supporting' as any;
          }
        }
        return { ...e, _priority: bestPriority as 'critical' | 'supporting' | 'other' };
      });
    } else {
      // 无分解结果时，全部视为 critical
      prioritized = filtered.map(e => ({ ...e, _priority: 'critical' as const }));
    }

    // 3. 按 priority 分组并按预算分配结果数
    const criticalResults = prioritized.filter(r => r._priority === 'critical');
    const supportingResults = prioritized.filter(r => r._priority === 'supporting');
    const otherResults = prioritized.filter(r => r._priority === 'other');

    // 以 limit 数量作为总预算（字符预算在后续截断阶段处理）
    const totalBudget = limit;
    const criticalBudget = Math.floor(totalBudget * 0.6);
    const supportingBudget = Math.floor(totalBudget * 0.3);
    const otherBudget = totalBudget - criticalBudget - supportingBudget;

    // 按相关性分数降序排列各层，截取预算内结果
    const sortByRelevance = (a: { _relevanceScore: number }, b: { _relevanceScore: number }) => b._relevanceScore - a._relevanceScore;
    const selectedCritical = criticalResults.sort(sortByRelevance).slice(0, Math.max(criticalBudget, 1));
    const selectedSupporting = supportingResults.sort(sortByRelevance).slice(0, supportingBudget);
    const selectedOther = otherResults.sort(sortByRelevance).slice(0, otherBudget);

    // 合并去重（critical 优先）
    const finalSeen = new Set<string>();
    const evidence: typeof allEvidence = [];
    for (const batch of [selectedCritical, selectedSupporting, selectedOther]) {
      for (const item of batch) {
        if (!finalSeen.has(item.id)) {
          finalSeen.add(item.id);
          evidence.push(item);
        }
      }
    }
    if (!evidence.length) return { text: "" };

    // P1-3 Memory OS: 更新访问计数（不阻塞主流程）
    const recalledIds = evidence.map(e => e.id);
    touchMemoryAccess({ pool: params.pool, tenantId: params.tenantId, memoryIds: recalledIds }).catch(() => {});

    // ── 相关性优先 + 类型多样性交错轮询 ──
    const sorted = interleavedRoundRobin(evidence);

    let totalChars = 0;
    const lines: string[] = [];
    for (const e of sorted) {
      let line = `- [记忆 #${e.id}] 类型: ${e.type ?? "memory"}${e.title ? ", 标题: " + e.title : ""}, 内容: ${e.snippet}`;
      if (e.conflictMarker && e.conflictMarker.length > 0 && e.resolutionStatus === "pending") {
        line += ` [⚠ 存在冲突，需用户确认]`;
      }
      if (totalChars + line.length > MEMORY_RECALL_MAX_CHARS) {
        // 预算不足时压缩 snippet 而非直接丢弃
        const compressed = `- [记忆 #${e.id}] 类型: ${e.type ?? "memory"}${e.title ? ", 标题: " + e.title : ""}, 内容: ${e.snippet.slice(0, 100)}…`;
        if (totalChars + compressed.length > MEMORY_RECALL_MAX_CHARS) break;
        lines.push(compressed);
        totalChars += compressed.length;
        continue;
      }
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

    // ─── P2-召回反哺: 信息缺口检测 ───
    // 获取本次完整的 decomposed（retry 路径已经使用过，非 retry 路径在分层召回阶段获取）
    const effectiveDecomposed = decomposed ?? (needsRetry ? await decomposeQuery(params.message, params.app).catch(() => null) : null);

    const informationGaps: string[] = [];
    if (effectiveDecomposed?.subQueries) {
      for (const sq of effectiveDecomposed.subQueries) {
        if (sq.priority !== "critical") continue;
        const sqLower = sq.searchQuery.toLowerCase().slice(0, 60);
        if (sqLower.length < 2) continue;
        const covered = evidence.some(e => {
          const txt = ((e.title ?? "") + " " + (e.snippet ?? "")).toLowerCase();
          return txt.includes(sqLower.slice(0, 30)) || sqLower.includes((e.title ?? "").toLowerCase().slice(0, 20));
        });
        if (!covered) {
          informationGaps.push(sq.intent || sq.searchQuery);
        }
      }
    }

    // ─── P2-召回反哺: 召回摘要生成 ───
    const coveredTypes = [...new Set(evidence.map(e => e.type || "general"))];
    const recallSummary = evidence.length > 0
      ? `Found ${evidence.length} relevant items covering: ${coveredTypes.join(", ")}`
      : "No relevant information found";

    return {
      text: lines.join("\n"),
      recallStats: { evidenceCount: evidence.length, searchMode, retryTriggered },
      informationGaps: informationGaps.length > 0 ? informationGaps : undefined,
      recallSummary,
    };
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
         AND decay_score > $3
       ORDER BY confidence DESC, created_at DESC
       LIMIT $4`,
      [params.tenantId, params.spaceId, DECAY_THRESHOLD, limit],
    );

    const rows = res.rows ?? [];
    if (!rows.length) return { text: "", strategyCount: 0 };

    // 元数据过滤：高置信度无条件保留 + minhash 语义匹配
    const goalMinhash = computeMinhash(goalSlice);
    const relevant = rows.filter(r => {
      if (r.confidence >= CONFIDENCE_THRESHOLD) return true;
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
            .map(([k, v]) => {
              const type = v?.type ?? "string";
              const req = v?.required ? "*" : "";
              const descRaw = typeof v?.description === "string" ? v.description : "";
              const descShort = descRaw.length > 120 ? descRaw.slice(0, 120) + "..." : descRaw;
              return `${k}:${type}${req}${descShort ? "(" + descShort + ")" : ""}`;
            })
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
