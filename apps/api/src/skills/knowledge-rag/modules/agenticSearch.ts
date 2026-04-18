/**
 * Agentic Search — 多轮搜索验证编排器
 *
 * 实现 RAG + Agentic Search 混合范式：
 * - 简单/内部问题优先 RAG（快速、低成本、可控）
 * - 复杂/外部/实时问题启用 Agentic Search（多轮搜索、验证、工具编排）
 * - 敏感数据查询强制叠加审批流程
 * - 所有 Agentic Search 必须运行于治理层约束下
 *
 * 搜索流程：
 *   1) 意图分析 → 判定策略（simple / agentic / hybrid）
 *   2) 查询改写 → 生成多个子查询变体
 *   3) 并行搜索 → RAG + 外部工具
 *   4) 结果验证 → 交叉验证 + 置信度评分
 *   5) 综合输出 → 带证据链的结构化答案
 *
 * @module knowledge-rag/agenticSearch
 */
import crypto from "node:crypto";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { searchChunksHybrid } from "./repo";

// ─── 类型定义 ──────────────────────────────────────────────────

/** Agentic Search 配置 */
export interface AgenticSearchConfig {
  /** 最大搜索轮次 */
  maxRounds: number;
  /** 目标置信度阈值 (达到后停止搜索) */
  confidenceThreshold: number;
  /** 单轮超时(ms) */
  roundTimeoutMs: number;
  /** 总超时(ms) */
  totalTimeoutMs: number;
  /** 是否启用查询改写 */
  enableQueryRewrite: boolean;
  /** 是否启用交叉验证 */
  enableCrossCheck: boolean;
  /** 最大并行子查询数 */
  maxParallelQueries: number;
}

/** 搜索会话 */
export interface AgenticSearchSession {
  sessionId: string;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  originalQuery: string;
  strategy: "simple" | "agentic" | "hybrid";
  status: "started" | "searching" | "verifying" | "completed" | "failed" | "timeout";
  rounds: AgenticSearchRound[];
  evidence: AgenticSearchEvidence[];
  finalConfidence: number;
  totalDurationMs: number;
  metadata: Record<string, unknown>;
}

/** 搜索轮次 */
export interface AgenticSearchRound {
  round: number;
  subQueries: string[];
  results: AgenticSearchResult[];
  verificationScore: number;
  durationMs: number;
}

/** 单次搜索结果 */
export interface AgenticSearchResult {
  query: string;
  evidence: AgenticSearchEvidence[];
  confidence: number;
  source: "rag" | "tool" | "external";
}

/** 聚合证据 */
export interface AgenticSearchEvidence {
  evidenceId: string;
  chunkId?: string;
  documentId?: string;
  snippet: string;
  sourceRef: Record<string, unknown>;
  aggregateScore: number;
  hitCount: number;
  verificationStatus: "unverified" | "verified" | "contradicted" | "uncertain";
  crossRefs: string[];
}

/** Agentic Search 最终输出 */
export interface AgenticSearchOutput {
  sessionId: string;
  strategy: string;
  answer: string | null;
  evidence: AgenticSearchEvidence[];
  confidence: number;
  totalRounds: number;
  durationMs: number;
  requiresApproval: boolean;
  metadata: {
    queryRewrites: string[];
    verificationSummary: string;
    degradeReason?: string;
  };
}

// ─── 默认配置 ──────────────────────────────────────────────────

function resolveAgenticSearchConfig(): AgenticSearchConfig {
  return {
    maxRounds: Math.max(1, Math.min(10, Number(process.env.AGENTIC_SEARCH_MAX_ROUNDS ?? 5))),
    confidenceThreshold: Math.max(0.1, Math.min(1.0, Number(process.env.AGENTIC_SEARCH_CONFIDENCE_THRESHOLD ?? 0.85))),
    roundTimeoutMs: Math.max(1000, Number(process.env.AGENTIC_SEARCH_ROUND_TIMEOUT_MS ?? 15000)),
    totalTimeoutMs: Math.max(5000, Number(process.env.AGENTIC_SEARCH_TOTAL_TIMEOUT_MS ?? 60000)),
    enableQueryRewrite: process.env.AGENTIC_SEARCH_QUERY_REWRITE !== "false",
    enableCrossCheck: process.env.AGENTIC_SEARCH_CROSS_CHECK !== "false",
    maxParallelQueries: Math.max(1, Math.min(5, Number(process.env.AGENTIC_SEARCH_MAX_PARALLEL ?? 3))),
  };
}

// ─── 策略判定 ──────────────────────────────────────────────────

/** 判定搜索策略（基于查询复杂度） */
export function determineSearchStrategy(query: string, context?: {
  hasExternalSources?: boolean;
  requiresRealtime?: boolean;
  sensitiveData?: boolean;
}): "simple" | "agentic" | "hybrid" {
  const q = query.trim();

  // 敏感数据查询 → 强制 agentic（需审批 + 多重验证）
  if (context?.sensitiveData) return "agentic";

  // 实时性要求 → agentic
  if (context?.requiresRealtime) return "agentic";

  // 外部数据源 → hybrid
  if (context?.hasExternalSources) return "hybrid";

  // 简短查询（<20字 且无复杂语法）→ simple
  if (q.length < 20 && !q.includes("对比") && !q.includes("分析") && !q.includes("验证")) return "simple";

  // 复杂查询（含多个关键词、对比分析、验证需求）→ agentic
  const complexIndicators = ["对比", "分析", "验证", "区别", "优劣", "趋势", "统计", "综合", "多个", "所有"];
  const complexCount = complexIndicators.filter(k => q.includes(k)).length;
  if (complexCount >= 2) return "agentic";

  // 中等复杂度 → hybrid
  if (complexCount >= 1 || q.length > 50) return "hybrid";

  return "simple";
}

// ─── 查询改写 ──────────────────────────────────────────────────

/** 查询改写：将原始查询扩展为多个子查询变体 */
export async function rewriteQuery(params: {
  app: FastifyInstance;
  query: string;
  context?: string;
  maxVariants?: number;
  authorization: string;
  traceId?: string;
}): Promise<string[]> {
  const { app, query, maxVariants = 3 } = params;

  try {
    // 调用 LLM 进行查询改写
    const { invokeModelChat } = await import("../../../lib/llm");
    const result = await invokeModelChat({
      app,
      subject: { tenantId: "system", subjectId: "agentic-search", spaceId: undefined },
      locale: "zh-CN",
      purpose: "agentic_search_query_rewrite",
      authorization: params.authorization,
      traceId: params.traceId ?? null,
      messages: [
        {
          role: "system",
          content: `你是一个搜索查询改写专家。将用户的搜索查询改写为 ${maxVariants} 个不同角度的子查询变体，每个变体用换行分隔。
要求：
1. 保持语义一致但关注不同方面
2. 包含同义词替换和概念扩展
3. 至少一个变体聚焦具体细节，一个变体关注宏观概念
4. 只输出改写后的查询，不要解释`,
        },
        { role: "user", content: query },
      ],
    });

    const text = typeof result?.outputText === "string" ? result.outputText : "";
    const variants = text
      .split("\n")
      .map((l: string) => l.replace(/^\d+[.)\s]+/, "").trim())
      .filter((l: string) => l.length > 2 && l.length < 500);

    // 始终包含原始查询
    return [query, ...variants.slice(0, maxVariants)];
  } catch (err: any) {
    app.log.warn({ err: err?.message }, "[AgenticSearch] 查询改写失败，回退到原始查询");
    return [query];
  }
}

// ─── 结果验证 ──────────────────────────────────────────────────

/** 交叉验证搜索结果 */
export function crossCheckEvidence(evidenceList: AgenticSearchEvidence[]): AgenticSearchEvidence[] {
  if (evidenceList.length <= 1) return evidenceList;

  const checked = [...evidenceList];

  for (let i = 0; i < checked.length; i++) {
    const current = checked[i]!;
    const supporters: string[] = [];
    const contradictors: string[] = [];

    for (let j = 0; j < checked.length; j++) {
      if (i === j) continue;
      const other = checked[j]!;

      // 简单相似度检测：snippet 重叠
      const overlap = computeSnippetOverlap(current.snippet, other.snippet);
      if (overlap > 0.3) {
        supporters.push(other.evidenceId);
      } else if (overlap < 0.05 && current.snippet.length > 50 && other.snippet.length > 50) {
        // 内容差异很大的证据可能互相矛盾（简化判定）
        contradictors.push(other.evidenceId);
      }
    }

    current.crossRefs = [...supporters, ...contradictors];
    current.hitCount = Math.max(current.hitCount, supporters.length + 1);

    // 更新验证状态
    if (supporters.length >= 2) {
      current.verificationStatus = "verified";
      current.aggregateScore = Math.min(1, current.aggregateScore * 1.3);
    } else if (contradictors.length > supporters.length && contradictors.length >= 2) {
      current.verificationStatus = "contradicted";
      current.aggregateScore = current.aggregateScore * 0.5;
    } else if (supporters.length > 0) {
      current.verificationStatus = "verified";
    } else {
      current.verificationStatus = "uncertain";
    }
  }

  return checked.sort((a, b) => b.aggregateScore - a.aggregateScore);
}

/** 计算两个摘要的文本重叠度 (0~1) */
function computeSnippetOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ─── 主搜索编排器 ──────────────────────────────────────────────

export interface AgenticSearchParams {
  app: FastifyInstance;
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  query: string;
  authorization: string;
  traceId?: string;
  /** 覆盖默认配置 */
  config?: Partial<AgenticSearchConfig>;
  /** 强制使用的策略 */
  forceStrategy?: "simple" | "agentic" | "hybrid";
  /** 上下文信号 */
  context?: {
    hasExternalSources?: boolean;
    requiresRealtime?: boolean;
    sensitiveData?: boolean;
  };
  /** 取消信号 */
  signal?: AbortSignal;
}

/**
 * 执行 Agentic Search — 多轮搜索验证编排
 *
 * 流程：
 * 1. 判定搜索策略
 * 2. 创建搜索会话（持久化）
 * 3. 执行搜索循环（查询改写 → 并行搜索 → 验证 → 置信度评估）
 * 4. 综合输出带证据链的结构化结果
 */
export async function runAgenticSearch(params: AgenticSearchParams): Promise<AgenticSearchOutput> {
  const { app, pool, tenantId, spaceId, subjectId, query, authorization, traceId, signal } = params;
  const config = { ...resolveAgenticSearchConfig(), ...(params.config ?? {}) };
  const startTime = Date.now();

  // 1. 判定搜索策略
  const strategy = params.forceStrategy ?? determineSearchStrategy(query, params.context);
  app.log.info({ query: query.slice(0, 100), strategy, traceId }, "[AgenticSearch] 开始搜索");

  // 2. 创建搜索会话
  const sessionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO agentic_search_sessions
       (session_id, tenant_id, space_id, subject_id, original_query, strategy, status, max_rounds, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'started', $7, $8)`,
    [sessionId, tenantId, spaceId, subjectId, query.slice(0, 10000), strategy, config.maxRounds, traceId ?? null],
  );

  // simple 策略直接走单次 RAG
  if (strategy === "simple") {
    return await executeSimpleRAG({
      app,
      sessionId,
      pool,
      tenantId,
      spaceId,
      subjectId,
      query,
      startTime,
      authorization,
      traceId,
    });
  }

  // 3. Agentic / Hybrid 多轮搜索
  const allEvidence: Map<string, AgenticSearchEvidence> = new Map();
  const allQueryRewrites: string[] = [];
  let currentConfidence = 0;
  let totalRounds = 0;
  let timedOut = false;
  let aborted = false;

  try {
    await pool.query(
      `UPDATE agentic_search_sessions SET status = 'searching', updated_at = now() WHERE session_id = $1`,
      [sessionId],
    );

    for (let round = 0; round < config.maxRounds; round++) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      if (Date.now() - startTime > config.totalTimeoutMs) {
        timedOut = true;
        break;
      }

      totalRounds = round + 1;
      const roundStart = Date.now();

      // 3a. 查询改写（第一轮从原始查询改写，后续轮次基于已有证据补充改写）
      let subQueries: string[];
      if (config.enableQueryRewrite && round === 0) {
        subQueries = await rewriteQuery({ app, query, maxVariants: config.maxParallelQueries, authorization, traceId });
      } else if (round > 0) {
        // 后续轮次：基于已发现证据的缺口生成补充查询
        const gaps = identifyEvidenceGaps(query, Array.from(allEvidence.values()));
        subQueries = gaps.length > 0 ? gaps : [query];
      } else {
        subQueries = [query];
      }
      allQueryRewrites.push(...subQueries);

      // 记录查询改写步骤
      await recordSearchStep(pool, {
        sessionId, tenantId, round, stepType: "query_rewrite",
        input: { originalQuery: query }, output: { subQueries },
        status: "succeeded",
      });

      // 3b. 并行执行子查询搜索
      const searchPromises = subQueries.slice(0, config.maxParallelQueries).map(async (sq) => {
        try {
          const result = await searchChunksHybrid({
            pool, tenantId, spaceId, subjectId, query: sq, limit: 10,
          });
          return { query: sq, evidence: mapToEvidence(result), confidence: 0, source: "rag" as const };
        } catch (err: any) {
          app.log.warn({ err: err?.message, query: sq.slice(0, 50) }, "[AgenticSearch] 子查询搜索失败");
          return { query: sq, evidence: [], confidence: 0, source: "rag" as const };
        }
      });

      const searchResults = await Promise.allSettled(searchPromises);
      const roundResults: AgenticSearchResult[] = [];

      for (const r of searchResults) {
        if (r.status === "fulfilled") {
          roundResults.push(r.value);
          // 合并证据（去重）
          for (const ev of r.value.evidence) {
            const key = ev.chunkId ?? ev.snippet.slice(0, 100);
            const existing = allEvidence.get(key);
            if (existing) {
              existing.hitCount += 1;
              existing.aggregateScore = Math.min(1, existing.aggregateScore + 0.1);
            } else {
              allEvidence.set(key, { ...ev });
            }
          }
        }
      }

      // 记录搜索步骤
      await recordSearchStep(pool, {
        sessionId, tenantId, round, stepType: "search",
        input: { subQueries },
        output: { resultCount: roundResults.reduce((s, r) => s + r.evidence.length, 0) },
        evidenceRefs: roundResults.flatMap(r => r.evidence.map(e => e.evidenceId)),
        status: "succeeded", durationMs: Date.now() - roundStart,
      });

      // 3c. 交叉验证
      if (config.enableCrossCheck && allEvidence.size > 1) {
        await pool.query(
          `UPDATE agentic_search_sessions SET status = 'verifying', updated_at = now() WHERE session_id = $1`,
          [sessionId],
        );

        const verified = crossCheckEvidence(Array.from(allEvidence.values()));
        allEvidence.clear();
        for (const ev of verified) {
          const key = ev.chunkId ?? ev.snippet.slice(0, 100);
          allEvidence.set(key, ev);
        }

        await recordSearchStep(pool, {
          sessionId, tenantId, round, stepType: "verify",
          input: { evidenceCount: verified.length },
          output: { verifiedCount: verified.filter(e => e.verificationStatus === "verified").length },
          confidence: computeOverallConfidence(verified),
          status: "succeeded",
        });
      }

      // 3d. 评估置信度
      const evidenceArr = Array.from(allEvidence.values());
      currentConfidence = computeOverallConfidence(evidenceArr);

      // 更新会话轮次
      await pool.query(
        `UPDATE agentic_search_sessions SET total_rounds = $2, updated_at = now() WHERE session_id = $1`,
        [sessionId, totalRounds],
      );

      // 达到置信度阈值，提前结束
      if (currentConfidence >= config.confidenceThreshold) {
        app.log.info({ round, confidence: currentConfidence, traceId }, "[AgenticSearch] 置信度达标，结束搜索");
        break;
      }
    }

    // 4. 综合输出
    const finalEvidence = Array.from(allEvidence.values())
      .sort((a, b) => b.aggregateScore - a.aggregateScore)
      .slice(0, 20);

    // 持久化证据
    for (const ev of finalEvidence) {
      await pool.query(
        `INSERT INTO agentic_search_evidence
           (evidence_id, session_id, tenant_id, chunk_id, document_id, snippet, source_ref, aggregate_score, hit_count, verification_status, cross_refs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (evidence_id) DO NOTHING`,
        [ev.evidenceId, sessionId, tenantId, ev.chunkId ?? null, ev.documentId ?? null,
         ev.snippet.slice(0, 5000), JSON.stringify(ev.sourceRef), ev.aggregateScore,
         ev.hitCount, ev.verificationStatus, JSON.stringify(ev.crossRefs)],
      );
    }

    const totalDuration = Date.now() - startTime;
    const requiresApproval = params.context?.sensitiveData === true;
    const degradeReason =
      aborted ? "搜索被外部中断，已返回当前已收集证据" :
      timedOut ? "达到总超时阈值，已返回当前已收集证据" :
      undefined;
    const synthesizeStart = Date.now();
    const answer = await synthesizeSearchAnswer({
      app,
      query,
      evidence: finalEvidence,
      authorization,
      traceId,
      degradeReason,
    });

    await recordSearchStep(pool, {
      sessionId,
      tenantId,
      round: Math.max(totalRounds - 1, 0),
      stepType: "synthesize",
      input: {
        query,
        evidenceCount: finalEvidence.length,
        degraded: degradeReason != null,
      },
      output: {
        answer,
        degradeReason: degradeReason ?? null,
      },
      evidenceRefs: finalEvidence.map((ev) => ev.evidenceId),
      confidence: currentConfidence,
      status: "succeeded",
      durationMs: Date.now() - synthesizeStart,
    });

    // 完成会话
    await pool.query(
      `UPDATE agentic_search_sessions
       SET status = $2, final_confidence = $3, total_duration_ms = $4,
           requires_approval = $5, total_rounds = $6, updated_at = now()
       WHERE session_id = $1`,
      [
        sessionId,
        timedOut || aborted ? "timeout" : "completed",
        currentConfidence,
        totalDuration,
        requiresApproval,
        totalRounds,
      ],
    );

    return {
      sessionId,
      strategy,
      answer,
      evidence: finalEvidence,
      confidence: currentConfidence,
      totalRounds,
      durationMs: totalDuration,
      requiresApproval,
      metadata: {
        queryRewrites: [...new Set(allQueryRewrites)],
        verificationSummary: `${finalEvidence.filter(e => e.verificationStatus === "verified").length}/${finalEvidence.length} 条证据已验证`,
        ...(degradeReason ? { degradeReason } : {}),
      },
    };
  } catch (err: any) {
    app.log.error({ err: err?.message, sessionId, traceId }, "[AgenticSearch] 搜索失败");
    await pool.query(
      `UPDATE agentic_search_sessions SET status = 'failed', total_duration_ms = $2, updated_at = now() WHERE session_id = $1`,
      [sessionId, Date.now() - startTime],
    );
    throw err;
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────────

/** 简单 RAG 搜索（无多轮验证） */
async function executeSimpleRAG(params: {
  app: FastifyInstance;
  sessionId: string; pool: Pool; tenantId: string; spaceId: string;
  subjectId: string; query: string; startTime: number; authorization: string; traceId?: string;
}): Promise<AgenticSearchOutput> {
  const { app, sessionId, pool, tenantId, spaceId, subjectId, query, startTime, authorization, traceId } = params;

  const result = await searchChunksHybrid({ pool, tenantId, spaceId, subjectId, query, limit: 10 });
  const evidence = mapToEvidence(result);
  const confidence = evidence.length > 0 ? Math.min(1, 0.5 + evidence.length * 0.05) : 0;
  const durationMs = Date.now() - startTime;
  const answer = await synthesizeSearchAnswer({ app, query, evidence, authorization, traceId });

  for (const ev of evidence) {
    await pool.query(
      `INSERT INTO agentic_search_evidence
         (evidence_id, session_id, tenant_id, chunk_id, document_id, snippet, source_ref, aggregate_score, hit_count, verification_status, cross_refs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (evidence_id) DO NOTHING`,
      [ev.evidenceId, sessionId, tenantId, ev.chunkId ?? null, ev.documentId ?? null,
       ev.snippet.slice(0, 5000), JSON.stringify(ev.sourceRef), ev.aggregateScore,
       ev.hitCount, ev.verificationStatus, JSON.stringify(ev.crossRefs)],
    );
  }

  await recordSearchStep(pool, {
    sessionId,
    tenantId,
    round: 0,
    stepType: "search",
    input: { subQueries: [query] },
    output: { resultCount: evidence.length },
    evidenceRefs: evidence.map((ev) => ev.evidenceId),
    confidence,
    status: "succeeded",
    durationMs,
  });

  await recordSearchStep(pool, {
    sessionId,
    tenantId,
    round: 0,
    stepType: "synthesize",
    input: { query, evidenceCount: evidence.length, degraded: false },
    output: { answer },
    evidenceRefs: evidence.map((ev) => ev.evidenceId),
    confidence,
    status: "succeeded",
  });

  await pool.query(
    `UPDATE agentic_search_sessions
     SET status = 'completed', final_confidence = $2, total_duration_ms = $3, total_rounds = 1, updated_at = now()
     WHERE session_id = $1`,
    [sessionId, confidence, durationMs],
  );

  return {
    sessionId, strategy: "simple", answer, evidence, confidence,
    totalRounds: 1, durationMs, requiresApproval: false,
    metadata: { queryRewrites: [query], verificationSummary: "单次RAG，未执行多轮验证" },
  };
}

/** 将 hybrid search 结果映射为 AgenticSearchEvidence */
function mapToEvidence(result: any): AgenticSearchEvidence[] {
  const candidates = Array.isArray(result?.evidence) ? result.evidence : (Array.isArray(result) ? result : []);
  return candidates.map((c: any) => ({
    evidenceId: crypto.randomUUID(),
    chunkId: c?.sourceRef?.chunkId ?? c?.chunkId ?? c?.id ?? null,
    documentId: c?.sourceRef?.documentId ?? c?.documentId ?? null,
    snippet: c?.snippet ?? c?.text ?? "",
    sourceRef: c?.sourceRef ?? {},
    aggregateScore: Number(c?.score ?? c?.relevance ?? 0.5),
    hitCount: 1,
    verificationStatus: "unverified" as const,
    crossRefs: [],
  }));
}

/** 基于已有证据识别信息缺口，生成补充查询 */
function identifyEvidenceGaps(originalQuery: string, evidence: AgenticSearchEvidence[]): string[] {
  // 简单实现：如果已有证据覆盖率低，从不同角度重新提问
  if (evidence.length < 3) {
    return [
      `${originalQuery} 详细解释`,
      `${originalQuery} 相关案例`,
    ];
  }
  // 如果有矛盾证据，深入调查
  const contradicted = evidence.filter(e => e.verificationStatus === "contradicted");
  if (contradicted.length > 0) {
    return [
      `${originalQuery} 最新权威解释`,
      `${originalQuery} 不同观点对比`,
    ];
  }
  return [];
}

/** 计算整体置信度 */
function computeOverallConfidence(evidence: AgenticSearchEvidence[]): number {
  if (evidence.length === 0) return 0;
  const verified = evidence.filter(e => e.verificationStatus === "verified");
  const avgScore = evidence.reduce((s, e) => s + e.aggregateScore, 0) / evidence.length;
  const verifiedRatio = verified.length / evidence.length;
  return Math.min(1, avgScore * 0.6 + verifiedRatio * 0.4);
}

async function synthesizeSearchAnswer(params: {
  app: FastifyInstance;
  query: string;
  evidence: AgenticSearchEvidence[];
  authorization: string;
  traceId?: string;
  degradeReason?: string;
}): Promise<string | null> {
  const { app, query, evidence, authorization, traceId, degradeReason } = params;
  if (evidence.length === 0) return null;

  const topEvidence = evidence
    .slice(0, 8)
    .map((item, index) => `证据 ${index + 1} [${item.verificationStatus}, score=${item.aggregateScore.toFixed(2)}]: ${item.snippet.slice(0, 400)}`)
    .join("\n");

  try {
    const { invokeModelChat } = await import("../../../lib/llm");
    const result = await invokeModelChat({
      app,
      subject: { tenantId: "system", subjectId: "agentic-search", spaceId: undefined },
      locale: "zh-CN",
      purpose: "agentic_search_synthesize_answer",
      authorization,
      traceId: traceId ?? null,
      messages: [
        {
          role: "system",
          content: `你是一个严谨的检索答案综合器。只能依据提供证据回答，不得编造未出现的信息。
输出要求：
1. 先给出直接回答
2. 再给出 2~4 条关键依据
3. 若证据不足，明确说明不确定性
4. 输出纯文本，不要使用 Markdown 标题`,
        },
        {
          role: "user",
          content: `问题：${query}
${degradeReason ? `补充说明：${degradeReason}` : ""}

证据：
${topEvidence}`,
        },
      ],
    });
    const answer = typeof result?.outputText === "string" ? result.outputText.trim() : "";
    if (answer) return answer.slice(0, 4000);
  } catch (err: any) {
    app.log.warn({ err: err?.message, traceId }, "[AgenticSearch] 综合回答生成失败，回退为证据摘要");
  }

  return [
    `基于当前检索证据，对问题“${query}”的结论如下：`,
    ...evidence.slice(0, 3).map((item, index) => `${index + 1}. ${item.snippet.slice(0, 220)}`),
    degradeReason ? `说明：${degradeReason}` : undefined,
  ].filter(Boolean).join("\n");
}

/** 记录搜索步骤 */
async function recordSearchStep(pool: Pool, params: {
  sessionId: string; tenantId: string; round: number;
  stepType: string; input: any; output?: any;
  subQueries?: string[]; evidenceRefs?: string[];
  status: string; confidence?: number; durationMs?: number;
}) {
  await pool.query(
    `INSERT INTO agentic_search_steps
       (session_id, tenant_id, round, step_type, input, output, sub_queries, evidence_refs, status, confidence, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      params.sessionId, params.tenantId, params.round, params.stepType,
      JSON.stringify(params.input), JSON.stringify(params.output ?? {}),
      JSON.stringify(params.subQueries ?? []), JSON.stringify(params.evidenceRefs ?? []),
      params.status, params.confidence ?? null, params.durationMs ?? null,
    ],
  );
}
