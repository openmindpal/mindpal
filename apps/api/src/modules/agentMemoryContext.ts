/**
 * agentMemoryContext.ts — 记忆召回模块
 *
 * 从 agentContext.ts 拆分而来，负责：
 * - 通用记忆召回 (recallRelevantMemory)
 * - 策略记忆召回 (recallProceduralStrategies)
 * - 交错轮询截断算法 (interleavedRoundRobin)
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { searchMemory, touchMemoryAccess } from "./memory/repo";
import { computeMinhash, minhashOverlapScore } from "@mindpal/shared";
import { StructuredLogger } from "@mindpal/shared";
import { invokeModelChat } from "../lib/llm";
import { insertAuditEvent } from "./audit/auditRepo";

const _logger = new StructuredLogger({ module: "agentMemoryContext" });

// ─── 内部辅助 ─────────────────────────────────────────────────────

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function memoryRecallLimit() {
  const raw = Number(process.env.ORCHESTRATOR_MEMORY_RECALL_LIMIT ?? "20");
  return clampInt(Number.isFinite(raw) ? Math.floor(raw) : 20, 0, 50);
}

const MEMORY_RECALL_MAX_CHARS = Math.max(500, Number(process.env.ORCHESTRATOR_MEMORY_RECALL_MAX_CHARS) || 3000);

/** P2: 策略记忆召回配置 */
const STRATEGY_RECALL_LIMIT = Math.max(1, Number(process.env.STRATEGY_RECALL_LIMIT) || 5);
const STRATEGY_RECALL_MAX_CHARS = Math.max(200, Number(process.env.STRATEGY_RECALL_MAX_CHARS) || 2000);
const CONFIDENCE_THRESHOLD = Math.max(0, Number(process.env.STRATEGY_RECALL_CONFIDENCE_THRESHOLD) || 0.65);
const DECAY_THRESHOLD = Math.max(0, Number(process.env.STRATEGY_RECALL_DECAY_THRESHOLD) || 0.1);

/** 按中英文标点将文本拆分为子句 */
function splitBySentence(text: string, maxParts = 4): string[] {
  return text.split(/[？?。！!；;，,\n]+/).map(s => s.trim()).filter(s => s.length > 2).slice(0, maxParts);
}

// ─── 查询分解 ─────────────────────────────────────────────────────

interface DecomposedQuery {
  subQueries: Array<{
    intent: string;
    searchQuery: string;
    priority: 'critical' | 'supporting';
  }>;
  implicitConstraints: string[];
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
    touchMemoryAccess({ pool: params.pool, tenantId: params.tenantId, memoryIds: recalledIds });

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
    touchMemoryAccess({ pool: params.pool, tenantId: params.tenantId, memoryIds: ids });

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
