/**
 * 主动学习反思引擎 — Agent 空闲时智能复盘
 *
 * 核心能力：
 * 1. 质量评分系统：综合 success_rate、duration、retry_count、error_diversity 评分
 * 2. 优先级扫描：低分 / 高耗时 / 重复失败的 runs 优先反思
 * 3. 跨 run 模式检测：识别同类错误根因、反复出现的失败模式
 * 4. 策略生成：从模式中提炼可操作策略，写入 procedural 级记忆
 * 5. 去重升级：覆盖 loopAutoReflexion 已写入的同 run 条目，避免重复
 */
import crypto from "node:crypto";
import path from "node:path";
import type { Pool } from "pg";
import { computeMinhash, StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "activeReflexion" });
import { encryptMemoryContent } from "../memory/memoryEncryption";

/* ================================================================== */
/*  配置常量（均可通过环境变量覆盖）                                       */
/* ================================================================== */

/** 扫描窗口：默认回溯 7 天 */
const SCAN_WINDOW_DAYS = Math.max(1, Number(process.env.ACTIVE_REFLEXION_SCAN_WINDOW_DAYS ?? "7"));

/** 单次最多处理的 runs 数 */
const MAX_RUNS_PER_TICK = Math.max(1, Number(process.env.ACTIVE_REFLEXION_MAX_RUNS ?? "10"));

/** 单次最多生成的策略数 */
const MAX_STRATEGIES_PER_TICK = Math.max(1, Number(process.env.ACTIVE_REFLEXION_MAX_STRATEGIES ?? "5"));

/**
 * 反思深度级别：
 * - shallow: 仅单 run 反思（快速，token 消耗低）
 * - standard: 单 run 反思 + 跨 run 模式检测（默认）
 * - deep: 单 run + 跨 run + 策略综合提炼（token 消耗最高）
 */
type ReflexionDepth = "shallow" | "standard" | "deep";
const REFLEXION_DEPTH: ReflexionDepth = (["shallow", "standard", "deep"] as const).includes(
  process.env.ACTIVE_REFLEXION_DEPTH as ReflexionDepth,
) ? (process.env.ACTIVE_REFLEXION_DEPTH as ReflexionDepth) : "standard";

/** 质量评分阈值：低于此分的 run 被认为需要反思 */
const QUALITY_SCORE_THRESHOLD = Math.max(0, Math.min(1, Number(process.env.ACTIVE_REFLEXION_QUALITY_THRESHOLD ?? "0.6")));

/** 耗时阈值（ms）：超过此值的 run 被标记为高耗时 */
const DURATION_THRESHOLD_MS = Math.max(1000, Number(process.env.ACTIVE_REFLEXION_DURATION_THRESHOLD_MS ?? "60000"));

/** 源标识，用于防重和追溯 */
const SOURCE_KIND = "active_reflexion";

/* ================================================================== */
/*  Run 质量评分模型                                                     */
/* ================================================================== */

interface RunQualityMetrics {
  runId: string;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  goal: string;
  status: string;
  totalSteps: number;
  succeededSteps: number;
  failedSteps: number;
  totalDurationMs: number;
  errorCategories: string[];
  toolRefs: string[];
  createdAt: string;
  finishedAt: string | null;
}

interface ScoredRun extends RunQualityMetrics {
  /** 综合质量评分 0-1，越低越需要反思 */
  qualityScore: number;
  /** 评分分项 */
  scoreBreakdown: {
    successRate: number;
    durationScore: number;
    errorDiversityPenalty: number;
    stepEfficiency: number;
  };
}

/**
 * 计算单个 run 的综合质量评分。
 *
 * 评分维度：
 * - successRate (40%): 成功步骤占比
 * - durationScore (25%): 耗时合理性（与阈值比较）
 * - errorDiversityPenalty (20%): 不同错误类型越多说明问题越严重
 * - stepEfficiency (15%): 步骤数合理性（步骤过多说明效率低）
 */
function computeQualityScore(run: RunQualityMetrics): ScoredRun {
  // 1. 成功率
  const successRate = run.totalSteps > 0
    ? run.succeededSteps / run.totalSteps
    : (run.status === "succeeded" ? 1 : 0);

  // 2. 耗时评分：在阈值内得满分，超出按比例扣分
  const durationScore = run.totalDurationMs <= DURATION_THRESHOLD_MS
    ? 1
    : Math.max(0, 1 - (run.totalDurationMs - DURATION_THRESHOLD_MS) / (DURATION_THRESHOLD_MS * 4));

  // 3. 错误多样性惩罚：不同错误类型越多，说明问题越分散（越难修复）
  const uniqueErrors = new Set(run.errorCategories.filter(Boolean)).size;
  const errorDiversityPenalty = uniqueErrors === 0 ? 1 : Math.max(0, 1 - uniqueErrors * 0.2);

  // 4. 步骤效率：理想步骤数 3-8，过多扣分
  const stepEfficiency = run.totalSteps <= 8
    ? 1
    : Math.max(0.2, 1 - (run.totalSteps - 8) * 0.05);

  // 加权综合
  const qualityScore =
    successRate * 0.4 +
    durationScore * 0.25 +
    errorDiversityPenalty * 0.2 +
    stepEfficiency * 0.15;

  return {
    ...run,
    qualityScore: Math.max(0, Math.min(1, qualityScore)),
    scoreBreakdown: { successRate, durationScore, errorDiversityPenalty, stepEfficiency },
  };
}

/* ================================================================== */
/*  跨 Run 模式检测                                                     */
/* ================================================================== */

interface ErrorPattern {
  /** 错误类别 */
  errorCategory: string;
  /** 出现次数 */
  occurrences: number;
  /** 涉及的 run IDs */
  runIds: string[];
  /** 涉及的 tool refs */
  toolRefs: string[];
  /** 平均失败耗时 */
  avgDurationMs: number;
}

interface StrategyCandidate {
  /** 策略类型 */
  kind: "error_pattern" | "efficiency_pattern" | "tool_preference" | "cross_run_insight";
  /** 策略摘要（人可读） */
  summary: string;
  /** 相关证据（run IDs） */
  evidenceRunIds: string[];
  /** 置信度 0-1 */
  confidence: number;
  /** 用于去重的指纹 */
  fingerprint: string;
}

/**
 * 从一组低质量 runs 中检测跨 run 错误模式。
 * 当同一错误在多个 runs 中反复出现时，识别为"系统性问题"。
 */
function detectErrorPatterns(runs: ScoredRun[]): ErrorPattern[] {
  const errorMap = new Map<string, ErrorPattern>();

  for (const run of runs) {
    for (const ec of run.errorCategories) {
      if (!ec) continue;
      let pattern = errorMap.get(ec);
      if (!pattern) {
        pattern = { errorCategory: ec, occurrences: 0, runIds: [], toolRefs: [], avgDurationMs: 0 };
        errorMap.set(ec, pattern);
      }
      pattern.occurrences++;
      pattern.runIds.push(run.runId);
      // 合并关联的 toolRefs
      for (const tr of run.toolRefs) {
        if (!pattern.toolRefs.includes(tr)) pattern.toolRefs.push(tr);
      }
      pattern.avgDurationMs = (pattern.avgDurationMs * (pattern.occurrences - 1) + run.totalDurationMs) / pattern.occurrences;
    }
  }

  // 仅返回出现 >= 2 次的模式（单次出现不构成模式）
  return Array.from(errorMap.values())
    .filter(p => p.occurrences >= 2)
    .sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * 检测工具使用效率模式：某些工具在特定场景下反复失败。
 */
function detectToolFailurePatterns(runs: ScoredRun[]): Map<string, { failCount: number; totalCount: number; runIds: string[] }> {
  const toolStats = new Map<string, { failCount: number; totalCount: number; runIds: string[] }>();

  for (const run of runs) {
    const seenTools = new Set<string>();
    for (const tr of run.toolRefs) {
      if (!seenTools.has(tr)) {
        seenTools.add(tr);
        let stat = toolStats.get(tr);
        if (!stat) {
          stat = { failCount: 0, totalCount: 0, runIds: [] };
          toolStats.set(tr, stat);
        }
        stat.totalCount++;
        stat.runIds.push(run.runId);
      }
    }
    // 标记失败 run 中涉及的工具
    if (run.status !== "succeeded") {
      for (const tr of run.toolRefs) {
        const stat = toolStats.get(tr);
        if (stat) stat.failCount++;
      }
    }
  }

  // 仅保留失败率 > 50% 且使用次数 >= 2 的工具
  const result = new Map<string, { failCount: number; totalCount: number; runIds: string[] }>();
  for (const [tool, stat] of toolStats) {
    if (stat.totalCount >= 2 && stat.failCount / stat.totalCount > 0.5) {
      result.set(tool, stat);
    }
  }
  return result;
}

/**
 * 将检测到的模式转化为策略候选。
 */
function buildStrategyCandidates(
  errorPatterns: ErrorPattern[],
  toolFailures: Map<string, { failCount: number; totalCount: number; runIds: string[] }>,
  runs: ScoredRun[],
): StrategyCandidate[] {
  const candidates: StrategyCandidate[] = [];

  // 从错误模式生成策略
  for (const ep of errorPatterns.slice(0, 5)) {
    const tools = ep.toolRefs.slice(0, 3).join(", ");
    candidates.push({
      kind: "error_pattern",
      summary: `错误「${ep.errorCategory}」在 ${ep.occurrences} 个任务中反复出现（涉及工具: ${tools}）。` +
        `平均耗时 ${Math.round(ep.avgDurationMs / 1000)}s。需要在规划阶段预防此类错误。`,
      evidenceRunIds: ep.runIds.slice(0, 5),
      confidence: Math.min(0.95, 0.5 + ep.occurrences * 0.1),
      fingerprint: `err:${ep.errorCategory}`,
    });
  }

  // 从工具失败模式生成策略
  for (const [tool, stat] of toolFailures) {
    const failRate = Math.round(stat.failCount / stat.totalCount * 100);
    candidates.push({
      kind: "tool_preference",
      summary: `工具「${tool}」失败率高达 ${failRate}%（${stat.failCount}/${stat.totalCount} 次），` +
        `建议在可选替代方案时优先使用其他工具，或在调用前增加前置检查。`,
      evidenceRunIds: stat.runIds.slice(0, 5),
      confidence: Math.min(0.9, 0.4 + (stat.failCount / stat.totalCount) * 0.5),
      fingerprint: `tool_fail:${tool}`,
    });
  }

  // 从高耗时 runs 中提炼效率策略
  const slowRuns = runs.filter(r => r.totalDurationMs > DURATION_THRESHOLD_MS && r.totalSteps > 8);
  if (slowRuns.length >= 2) {
    const avgSteps = Math.round(slowRuns.reduce((s, r) => s + r.totalSteps, 0) / slowRuns.length);
    const avgDuration = Math.round(slowRuns.reduce((s, r) => s + r.totalDurationMs, 0) / slowRuns.length / 1000);
    candidates.push({
      kind: "efficiency_pattern",
      summary: `发现 ${slowRuns.length} 个高耗时任务（平均 ${avgSteps} 步、${avgDuration}s），` +
        `建议对复杂任务采用更细粒度的目标分解（GoalGraph），避免在单个 run 中执行过多步骤。`,
      evidenceRunIds: slowRuns.map(r => r.runId).slice(0, 5),
      confidence: Math.min(0.85, 0.5 + slowRuns.length * 0.05),
      fingerprint: `efficiency:slow_runs`,
    });
  }

  return candidates;
}

/* ================================================================== */
/*  反思执行引擎                                                         */
/* ================================================================== */

/**
 * 加载 reflexion-skill（动态加载，与 batchReflexion 相同的机制）。
 */
function loadReflexionSkill(): { execute: (params: any) => Promise<any> } | null {
  const skillPaths = [
    path.resolve(process.cwd(), "skills/reflexion-skill/dist/index.js"),
    path.resolve(__dirname, "../../../../skills/reflexion-skill/dist/index.js"),
  ];
  for (const sp of skillPaths) {
    try {
      const mod = require(sp);
      if (typeof mod?.execute === "function") return mod;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 对单个 run 执行深度反思，生成可操作的策略建议。
 * 比 batchReflexion 更深入：不仅总结教训，还提炼出 "下次遇到类似任务应该怎么做" 的策略。
 */
async function reflectOnRun(params: {
  pool: Pool;
  run: ScoredRun;
  reflexionSkill: { execute: (p: any) => Promise<any> };
}): Promise<{ lesson: string; strategy: string; confidence: number } | null> {
  const { pool, run, reflexionSkill } = params;

  // 获取该 run 的步骤详情
  const stepsRes = await pool.query<{
    seq: number;
    tool_ref: string | null;
    status: string;
    error_category: string | null;
    created_at: string;
    finished_at: string | null;
    output_digest: any;
  }>(
    `SELECT seq, tool_ref, status, error_category, created_at, finished_at, output_digest
     FROM steps
     WHERE run_id = $1
     ORDER BY seq ASC
     LIMIT 50`,
    [run.runId],
  );

  const steps = stepsRes.rows.map(s => {
    let durationMs: number | null = null;
    if (s.created_at && s.finished_at) {
      durationMs = Date.parse(s.finished_at) - Date.parse(s.created_at);
    }
    return {
      seq: s.seq,
      toolRef: s.tool_ref ?? "unknown",
      status: s.status,
      durationMs,
      error: s.error_category,
      outputSummary: s.output_digest ? JSON.stringify(s.output_digest).slice(0, 200) : null,
    };
  });

  if (steps.length === 0) return null;

  try {
    const result = await reflexionSkill.execute({
      input: {
        goal: run.goal,
        outcome: run.status === "succeeded" ? "succeeded" : "failed",
        steps,
        totalDurationMs: run.totalDurationMs,
        qualityScore: run.qualityScore,
        scoreBreakdown: run.scoreBreakdown,
        context: `runId=${run.runId}, activeReflexion=true, depth=${REFLEXION_DEPTH}, ` +
          `quality=${run.qualityScore.toFixed(2)}, successRate=${run.scoreBreakdown.successRate.toFixed(2)}`,
        // 主动反思要求 skill 输出 strategy 字段
        requestStrategy: true,
      },
    });

    const lesson = String(result?.lesson ?? "").trim();
    const strategy = String(result?.strategy ?? result?.lesson ?? "").trim();
    const confidence = typeof result?.confidence === "number" ? result.confidence : 0.7;

    if (!lesson && !strategy) return null;
    return { lesson, strategy, confidence };
  } catch (err: any) {
        _logger.warn("reflectOnRun failed", { runId: run.runId, err: err?.message });
    return null;
  }
}

/**
 * 将策略写入 procedural 级记忆。
 * 与 batchReflexion 的 lesson 写入区别：
 * - memory_class = 'procedural'（而非默认的 'semantic'）
 * - type = 'strategy'（而非 'lesson'）
 * - 包含可操作的策略建议
 */
async function writeProceduralStrategy(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  strategy: string;
  sourceRef: Record<string, unknown>;
  confidence: number;
  title: string;
}): Promise<string | null> {
  const { pool, tenantId, spaceId, subjectId, strategy, sourceRef, confidence, title } = params;

  const contentDigest = crypto.createHash("sha256").update(strategy, "utf8").digest("hex");
  const minhash = computeMinhash(strategy);

  // 防重：检查是否已有相同 content_digest 的策略
  const existing = await pool.query(
    `SELECT id FROM memory_entries
     WHERE tenant_id = $1 AND space_id = $2
       AND type = 'strategy' AND memory_class = 'procedural'
       AND content_digest = $3 AND deleted_at IS NULL
     LIMIT 1`,
    [tenantId, spaceId, contentDigest],
  );
  if (existing.rowCount && existing.rowCount > 0) {
        _logger.info("strategy already exists, skip", { digest: contentDigest.slice(0, 12) });
    return null;
  }

  const res = await pool.query(
    `INSERT INTO memory_entries (
      tenant_id, space_id, owner_subject_id, scope, type, title,
      content_text, content_digest, write_policy, source_ref,
      embedding_model_ref, embedding_minhash, embedding_updated_at,
      memory_class, confidence
    ) VALUES ($1,$2,$3,'space','strategy',$4,$5,$6,'policyAllowed',$7,'minhash:16@1',$8,now(),'procedural',$9)
    RETURNING id`,
    [
      tenantId, spaceId, subjectId,
      title,
      await encryptMemoryContent({ pool, tenantId, plaintext: strategy }),
      contentDigest,
      JSON.stringify(sourceRef),
      minhash,
      Math.max(0.5, Math.min(1, confidence)),
    ],
  );

  const entryId = String(res.rows[0]?.id ?? "");
  if (entryId) {
        _logger.info("procedural strategy written", { entryId, title: title.slice(0, 50) });
  }
  return entryId || null;
}

/* ================================================================== */
/*  主入口：tickActiveReflexion                                         */
/* ================================================================== */

export interface ActiveReflexionResult {
  scannedRuns: number;
  reflectedRuns: number;
  strategiesWritten: number;
  patternsDetected: number;
  durationMs: number;
}

/**
 * 主动学习反思引擎 tick 函数。
 *
 * 流程：
 * 1. 扫描历史 runs → 计算质量评分 → 按评分排序
 * 2. 对低分 runs 逐一执行深度反思（reflexion-skill）
 * 3. [standard/deep] 跨 run 模式检测：错误模式 + 工具失败 + 效率问题
 * 4. [deep] 综合提炼策略并写入 procedural 级记忆
 * 5. 单 run 教训也升级写入 procedural（如果评分足够低）
 */
export async function tickActiveReflexion(params: { pool: Pool }): Promise<ActiveReflexionResult> {
  const startTime = Date.now();
  const result: ActiveReflexionResult = {
    scannedRuns: 0,
    reflectedRuns: 0,
    strategiesWritten: 0,
    patternsDetected: 0,
    durationMs: 0,
  };

  // 环境变量开关（默认启用）
  if ((process.env.ACTIVE_REFLEXION_ENABLED ?? "1") === "0") {
    result.durationMs = Date.now() - startTime;
    return result;
  }

  const { pool } = params;

  // 加载 reflexion-skill
  const reflexionSkill = loadReflexionSkill();
  if (!reflexionSkill) {
        _logger.info("reflexion-skill not available, skipping");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── Phase 1: 扫描 + 评分 ──
  // 查找扫描窗口内的终态 runs，排除已被主动反思处理过的
  const runsRes = await pool.query<{
    run_id: string;
    tenant_id: string;
    status: string;
    input_digest: any;
    created_at: string;
    finished_at: string | null;
  }>(
    `SELECT r.run_id, r.tenant_id, r.status, r.input_digest, r.created_at, r.finished_at
     FROM runs r
     WHERE r.status IN ('failed', 'stopped', 'succeeded')
       AND r.finished_at > now() - make_interval(days => $2)
       AND NOT EXISTS (
         SELECT 1 FROM memory_entries me
         WHERE me.deleted_at IS NULL
           AND me.type = 'strategy'
           AND me.memory_class = 'procedural'
           AND me.source_ref::text LIKE '%' || r.run_id::text || '%'
       )
     ORDER BY r.finished_at DESC
     LIMIT $1`,
    [MAX_RUNS_PER_TICK * 3, SCAN_WINDOW_DAYS], // 多取一些用于评分筛选
  );

  if (!runsRes.rowCount) {
        _logger.info("no unreflected runs found within scan window");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // 为每个 run 收集步骤统计
  const scoredRuns: ScoredRun[] = [];
  for (const row of runsRes.rows) {
    const runId = String(row.run_id);
    const inputDigest = (row.input_digest ?? {}) as Record<string, unknown>;
    const spaceId = String(inputDigest?.spaceId ?? inputDigest?.space_id ?? "");
    const goal = String(inputDigest?.goal ?? inputDigest?.message ?? "");
    if (!spaceId || !goal) continue;

    // 获取步骤统计
    const statsRes = await pool.query<{
      total: string;
      succeeded: string;
      failed: string;
      error_categories: string[];
      tool_refs: string[];
    }>(
      `SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
        ARRAY_AGG(DISTINCT error_category) FILTER (WHERE error_category IS NOT NULL) AS error_categories,
        ARRAY_AGG(DISTINCT tool_ref) FILTER (WHERE tool_ref IS NOT NULL) AS tool_refs
       FROM steps
       WHERE run_id = $1`,
      [runId],
    );

    const stats = statsRes.rows[0];
    if (!stats) continue;

    let totalDurationMs = 0;
    if (row.created_at && row.finished_at) {
      totalDurationMs = Date.parse(row.finished_at) - Date.parse(row.created_at);
    }

    const metrics: RunQualityMetrics = {
      runId,
      tenantId: String(row.tenant_id),
      spaceId,
      subjectId: String(inputDigest?.subjectId ?? inputDigest?.subject_id ?? "system"),
      goal,
      status: row.status,
      totalSteps: Number(stats.total) || 0,
      succeededSteps: Number(stats.succeeded) || 0,
      failedSteps: Number(stats.failed) || 0,
      totalDurationMs,
      errorCategories: stats.error_categories ?? [],
      toolRefs: stats.tool_refs ?? [],
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };

    scoredRuns.push(computeQualityScore(metrics));
  }

  result.scannedRuns = scoredRuns.length;
  if (scoredRuns.length === 0) {
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // 按质量评分升序排序（最差的优先反思）
  scoredRuns.sort((a, b) => a.qualityScore - b.qualityScore);

  // 筛选需要反思的 runs：低于阈值 + 限制数量
  const runsToReflect = scoredRuns
    .filter(r => r.qualityScore < QUALITY_SCORE_THRESHOLD)
    .slice(0, MAX_RUNS_PER_TICK);

  _logger.info("scan completed", {
    scanned: scoredRuns.length, belowThreshold: runsToReflect.length,
    depth: REFLEXION_DEPTH, threshold: QUALITY_SCORE_THRESHOLD,
  });

  // ── Phase 2: 单 Run 深度反思 ──
  for (const run of runsToReflect) {
    try {
      const reflexionResult = await reflectOnRun({ pool, run, reflexionSkill });
      if (!reflexionResult) continue;

      result.reflectedRuns++;

      // 写入 procedural 策略记忆
      const title = `[策略] ${run.goal.slice(0, 40)} (质量=${run.qualityScore.toFixed(2)})`;
      const strategyContent = reflexionResult.strategy || reflexionResult.lesson;
      if (strategyContent) {
        const entryId = await writeProceduralStrategy({
          pool,
          tenantId: run.tenantId,
          spaceId: run.spaceId,
          subjectId: run.subjectId,
          strategy: strategyContent,
          sourceRef: {
            kind: SOURCE_KIND,
            runId: run.runId,
            qualityScore: run.qualityScore,
            scoreBreakdown: run.scoreBreakdown,
            depth: REFLEXION_DEPTH,
          },
          confidence: reflexionResult.confidence,
          title,
        });
        if (entryId) result.strategiesWritten++;
      }
    } catch (err: any) {
          _logger.warn("single run reflexion failed", { runId: run.runId, err: err?.message });
    }
  }

  // ── Phase 3: 跨 Run 模式检测（standard / deep） ──
  if (REFLEXION_DEPTH !== "shallow" && scoredRuns.length >= 3) {
    try {
      const errorPatterns = detectErrorPatterns(scoredRuns);
      const toolFailures = detectToolFailurePatterns(scoredRuns);
      const strategyCandidates = buildStrategyCandidates(errorPatterns, toolFailures, scoredRuns);

      result.patternsDetected = errorPatterns.length + toolFailures.size;

      _logger.info("patterns detected", {
        errors: errorPatterns.length, toolFailures: toolFailures.size,
        candidates: strategyCandidates.length,
      });

      // 将策略候选写入 procedural 记忆
      let strategiesWritten = 0;
      for (const candidate of strategyCandidates) {
        if (strategiesWritten >= MAX_STRATEGIES_PER_TICK) break;

        // 按 fingerprint 去重：使用 JSONB 原生操作
        const existing = await pool.query(
          `SELECT id FROM memory_entries
           WHERE type = 'strategy' AND memory_class = 'procedural'
             AND deleted_at IS NULL
             AND source_ref @> $1::jsonb
           LIMIT 1`,
          [JSON.stringify({ fingerprint: candidate.fingerprint })],
        );
        if (existing.rowCount && existing.rowCount > 0) continue;

        // 需要一个 tenantId + spaceId，取第一个相关 run 的
        const firstRun = scoredRuns.find(r => candidate.evidenceRunIds.includes(r.runId));
        if (!firstRun) continue;

        const title = `[模式策略] ${candidate.kind}: ${candidate.summary.slice(0, 40)}`;
        const entryId = await writeProceduralStrategy({
          pool,
          tenantId: firstRun.tenantId,
          spaceId: firstRun.spaceId,
          subjectId: firstRun.subjectId,
          strategy: candidate.summary,
          sourceRef: {
            kind: SOURCE_KIND,
            patternKind: candidate.kind,
            fingerprint: candidate.fingerprint,
            evidenceRunIds: candidate.evidenceRunIds,
            depth: REFLEXION_DEPTH,
          },
          confidence: candidate.confidence,
          title,
        });
        if (entryId) {
          strategiesWritten++;
          result.strategiesWritten++;
        }
      }

      // ── Phase 4: [deep] 综合策略提炼 ──
      if (REFLEXION_DEPTH === "deep" && strategyCandidates.length >= 2) {
        try {
          const combinedContext = strategyCandidates
            .map((c, i) => `${i + 1}. [${c.kind}] ${c.summary}`)
            .join("\n");

          const synthesisResult = await reflexionSkill.execute({
            input: {
              goal: "综合分析以下多个策略发现，提炼出最核心的可操作改进建议",
              outcome: "analysis",
              steps: [],
              context: combinedContext,
              requestStrategy: true,
              synthesisMode: true,
            },
          });

          const synthesis = String(synthesisResult?.strategy ?? synthesisResult?.lesson ?? "").trim();
          if (synthesis && firstRunInScope(scoredRuns)) {
            const firstRun = firstRunInScope(scoredRuns)!;
            const entryId = await writeProceduralStrategy({
              pool,
              tenantId: firstRun.tenantId,
              spaceId: firstRun.spaceId,
              subjectId: firstRun.subjectId,
              strategy: synthesis,
              sourceRef: {
                kind: SOURCE_KIND,
                synthesisMode: true,
                inputPatternCount: strategyCandidates.length,
                depth: "deep",
              },
              confidence: Math.min(0.95, (synthesisResult?.confidence ?? 0.8)),
              title: `[综合策略] ${synthesis.slice(0, 40)}`,
            });
            if (entryId) result.strategiesWritten++;
          }
        } catch (err: any) {
              _logger.warn("deep synthesis failed", { err: err?.message });
        }
      }
    } catch (err: any) {
          _logger.warn("cross-run pattern detection failed", { err: err?.message });
    }
  }

  result.durationMs = Date.now() - startTime;
  _logger.info("reflexion completed", {
    scannedRuns: result.scannedRuns, reflectedRuns: result.reflectedRuns,
    strategiesWritten: result.strategiesWritten, patternsDetected: result.patternsDetected,
    durationMs: result.durationMs,
  });

  return result;
}

/** 辅助：找到第一个有效的 run（用于获取 tenantId/spaceId） */
function firstRunInScope(runs: ScoredRun[]): ScoredRun | null {
  return runs.find(r => r.tenantId && r.spaceId) ?? null;
}
