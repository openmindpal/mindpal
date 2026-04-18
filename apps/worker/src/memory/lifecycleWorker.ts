import crypto from "node:crypto";
import type { Pool } from "pg";
import { computeMinhash, minhashOverlapScore, MINHASH_K } from "@openslin/shared";

/* ── Memory Lifecycle Worker ── */

/**
 * P1-4: Memory Lifecycle Worker
 * - purgeExpired: 清理 expires_at 已过期的记忆
 * - compactSimilar: 合并高度相似的记忆
 * - distillSummaries: 蒸馏长对话摘要（减少记忆膨胀）
 */

export interface LifecycleWorkerConfig {
  /** 每次批处理的最大记录数 */
  batchSize: number;
  /** 合并阈值（minhash overlap >= 此值时合并） */
  compactThreshold: number;
  /** 干运行模式（只记录不实际删除/合并） */
  dryRun: boolean;
}

const DEFAULT_CONFIG: LifecycleWorkerConfig = {
  batchSize: 100,
  compactThreshold: 0.92,
  dryRun: false,
};

export interface LifecycleWorkerResult {
  operation: string;
  processed: number;
  affected: number;
  errors: number;
  details: Array<{ id: string; action: string; reason?: string }>;
  durationMs: number;
  /** 蒸馏产生的新记忆条目 ID（用于后续投递 embedding 任务） */
  distilledEntryIds?: string[];
}

/* ── P1-4a: Purge Expired Memories ── */

/* ── Distill LLM 桥接（OpenAI 兼容 API） ── */

type DistillLlmConfig = {
  endpoint: string;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
};

function resolveDistillLlmConfig(): DistillLlmConfig | null {
  const endpoint = String(process.env.DISTILL_LLM_ENDPOINT ?? process.env.KNOWLEDGE_EMBEDDING_ENDPOINT ?? "").trim();
  if (!endpoint) return null;
  return {
    endpoint,
    apiKey: String(process.env.DISTILL_LLM_API_KEY ?? process.env.KNOWLEDGE_EMBEDDING_API_KEY ?? "").trim() || null,
    model: String(process.env.DISTILL_LLM_MODEL ?? "gpt-4o-mini").trim(),
    timeoutMs: Math.max(5000, Number(process.env.DISTILL_LLM_TIMEOUT_MS ?? 30000)),
  };
}

/**
 * 通过 OpenAI 兼容 API 生成摘要，失败时返回 null（降级到简单拼接）。
 */
export async function summarizeWithLlm(
  entries: Array<{ title: string | null; content: string }>,
): Promise<string | null> {
  const cfg = resolveDistillLlmConfig();
  if (!cfg) return null;
  const url = cfg.endpoint.replace(/\/$/, "") + "/v1/chat/completions";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;

  const entriesText = entries
    .map((e, i) => `${i + 1}. ${e.title ? `[${e.title}] ` : ""}${e.content.slice(0, 200)}`)
    .join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: "你是记忆蒸馏助手。将以下多条记忆条目压缩为一段精练的中文摘要，保留核心事实和关键细节，删除重复和冗余信息。最多 500 字。" },
          { role: "user", content: entriesText },
        ],
        max_tokens: 600,
        temperature: 0.3,
      }),
      signal: controller.signal,
    } as any);
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const text = json?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 清理过期记忆
 * - 软删除 expires_at < now() 的记忆
 * - 按 tenant 分批处理避免长事务
 */
export async function purgeExpiredMemories(params: {
  pool: Pool;
  tenantId?: string;
  config?: Partial<LifecycleWorkerConfig>;
}): Promise<LifecycleWorkerResult> {
  const config = { ...DEFAULT_CONFIG, ...params.config };
  const startTime = Date.now();
  const details: LifecycleWorkerResult["details"] = [];
  let processed = 0;
  let affected = 0;
  let errors = 0;

  try {
    // 查找过期记忆（排除 pinned=true 的记忆）
    const whereClause = params.tenantId
      ? "tenant_id = $1 AND expires_at < now() AND deleted_at IS NULL AND pinned = FALSE"
      : "expires_at < now() AND deleted_at IS NULL AND pinned = FALSE";
    const args = params.tenantId ? [params.tenantId, config.batchSize] : [config.batchSize];

    const expiredRes = await params.pool.query(
      `
        SELECT id, tenant_id, space_id, type, title, expires_at
        FROM memory_entries
        WHERE ${whereClause}
        ORDER BY expires_at ASC
        LIMIT $${params.tenantId ? 2 : 1}
      `,
      args,
    );

    processed = expiredRes.rowCount ?? 0;

    if (processed === 0) {
      return {
        operation: "purge_expired",
        processed: 0,
        affected: 0,
        errors: 0,
        details: [],
        durationMs: Date.now() - startTime,
      };
    }

    // 执行软删除
    if (!config.dryRun) {
      const ids = (expiredRes.rows as any[]).map((r) => r.id);
      const deleteRes = await params.pool.query(
        `
          UPDATE memory_entries
          SET deleted_at = now(), updated_at = now()
          WHERE id = ANY($1::uuid[])
          AND deleted_at IS NULL
          RETURNING id
        `,
        [ids],
      );
      affected = deleteRes.rowCount ?? 0;
    } else {
      affected = processed; // dry run 模式下假设全部会被删除
    }

    // 记录详情
    for (const row of expiredRes.rows as any[]) {
      details.push({
        id: String(row.id),
        action: config.dryRun ? "would_purge" : "purged",
        reason: `expired_at=${row.expires_at}`,
      });
    }

    console.log(
      `[memory-lifecycle] purge_expired: processed=${processed}, affected=${affected}, dryRun=${config.dryRun}, durationMs=${Date.now() - startTime}`,
    );
  } catch (err) {
    errors++;
    console.error("[memory-lifecycle] purge_expired error:", err);
  }

  return {
    operation: "purge_expired",
    processed,
    affected,
    errors,
    details,
    durationMs: Date.now() - startTime,
  };
}

/* ── P1-4c: Compact Similar Memories ── */

/**
 * 合并高度相似的记忆
 * - 基于 minhash overlap 检测相似记忆
 * - 保留最新的，将旧的标记为 superseded
 */
export async function compactSimilarMemories(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  config?: Partial<LifecycleWorkerConfig>;
}): Promise<LifecycleWorkerResult> {
  const config = { ...DEFAULT_CONFIG, ...params.config };
  const startTime = Date.now();
  const details: LifecycleWorkerResult["details"] = [];
  let processed = 0;
  let affected = 0;
  let errors = 0;

  try {
    // 查找候选记忆（按 type 分组处理）
    const candidateRes = await params.pool.query(
      `
        SELECT id, type, title, content_text, embedding_minhash, created_at, updated_at
        FROM memory_entries
        WHERE tenant_id = $1
          AND space_id = $2
          AND deleted_at IS NULL
          AND embedding_minhash IS NOT NULL
        ORDER BY type, updated_at DESC
        LIMIT $3
      `,
      [params.tenantId, params.spaceId, config.batchSize * 2],
    );

    const rows = candidateRes.rows as any[];
    processed = rows.length;

    if (processed < 2) {
      return {
        operation: "compact_similar",
        processed,
        affected: 0,
        errors: 0,
        details: [],
        durationMs: Date.now() - startTime,
      };
    }

    // 按 type 分组
    const byType = new Map<string, any[]>();
    for (const r of rows) {
      const type = String(r.type);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(r);
    }

    // 检测相似对
    const toMerge: Array<{ keepId: string; removeId: string; score: number }> = [];
    const processed_set = new Set<string>();

    for (const [_, typeRows] of byType) {
      for (let i = 0; i < typeRows.length; i++) {
        const a = typeRows[i];
        if (processed_set.has(a.id)) continue;
        const mhA = Array.isArray(a.embedding_minhash) ? (a.embedding_minhash as number[]) : [];
        if (!mhA.length) continue;

        for (let j = i + 1; j < typeRows.length; j++) {
          const b = typeRows[j];
          if (processed_set.has(b.id)) continue;
          const mhB = Array.isArray(b.embedding_minhash) ? (b.embedding_minhash as number[]) : [];
          if (!mhB.length) continue;

          const score = minhashOverlapScore(mhA, mhB);
          if (score >= config.compactThreshold) {
            // 保留更新时间更新的
            const aTime = Date.parse(String(a.updated_at ?? a.created_at));
            const bTime = Date.parse(String(b.updated_at ?? b.created_at));
            if (aTime >= bTime) {
              toMerge.push({ keepId: a.id, removeId: b.id, score });
              processed_set.add(b.id);
            } else {
              toMerge.push({ keepId: b.id, removeId: a.id, score });
              processed_set.add(a.id);
            }
            break; // 一个记忆只合并一次
          }
        }
      }
    }

    // 执行合并
    if (!config.dryRun && toMerge.length > 0) {
      const removeIds = toMerge.map((m) => m.removeId);
      const updateRes = await params.pool.query(
        `
          UPDATE memory_entries
          SET resolution_status = 'superseded',
              deleted_at = now(),
              updated_at = now()
          WHERE id = ANY($1::uuid[])
          RETURNING id
        `,
        [removeIds],
      );
      affected = updateRes.rowCount ?? 0;
    } else {
      affected = toMerge.length;
    }

    // 记录详情
    for (const { keepId, removeId, score } of toMerge) {
      details.push({
        id: removeId,
        action: config.dryRun ? "would_merge" : "merged",
        reason: `similar_to=${keepId}, score=${score.toFixed(3)}`,
      });
    }

    console.log(
      `[memory-lifecycle] compact_similar: processed=${processed}, pairs=${toMerge.length}, affected=${affected}, dryRun=${config.dryRun}, durationMs=${Date.now() - startTime}`,
    );
  } catch (err) {
    errors++;
    console.error("[memory-lifecycle] compact_similar error:", err);
  }

  return {
    operation: "compact_similar",
    processed,
    affected,
    errors,
    details,
    durationMs: Date.now() - startTime,
  };
}

/* ── P1-4b: Distill Session Summaries ── */

/**
 * 蒸馏会话摘要
 * - 检测同一 space 下大量碎片化记忆
 * - 生成压缩摘要记忆，标记原始记忆为已蒸馏
 * 
 * 注意：完整实现需要 LLM 进行摘要生成，此处提供框架
 */
export async function distillSessionSummaries(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  /** 触发蒸馏的最小记忆数量 */
  minEntriesForDistill?: number;
  /** 蒸馏后的最大摘要长度 */
  maxSummaryLength?: number;
  /** 摘要生成回调（可选，用于集成 LLM） */
  summarizeCallback?: (entries: Array<{ title: string | null; content: string }>) => Promise<string>;
  config?: Partial<LifecycleWorkerConfig>;
}): Promise<LifecycleWorkerResult> {
  const config = { ...DEFAULT_CONFIG, ...params.config };
  const minEntries = params.minEntriesForDistill ?? 10;
  const maxLength = params.maxSummaryLength ?? 500;
  const startTime = Date.now();
  const details: LifecycleWorkerResult["details"] = [];
  let processed = 0;
  let affected = 0;
  let errors = 0;
  const distilledEntryIds: string[] = [];

  try {
    // 统计每个 type 的记忆数量
    const statsRes = await params.pool.query(
      `
        SELECT type, COUNT(*) as cnt
        FROM memory_entries
        WHERE tenant_id = $1
          AND space_id = $2
          AND deleted_at IS NULL
          AND resolution_status IS NULL
        GROUP BY type
        HAVING COUNT(*) >= $3
        ORDER BY cnt DESC
        LIMIT 5
      `,
      [params.tenantId, params.spaceId, minEntries],
    );

    const typesToDistill = (statsRes.rows as any[]).map((r) => ({
      type: String(r.type),
      count: Number(r.cnt),
    }));

    if (typesToDistill.length === 0) {
      return {
        operation: "distill_summaries",
        processed: 0,
        affected: 0,
        errors: 0,
        details: [{ id: "-", action: "skip", reason: "no_types_exceed_threshold" }],
        durationMs: Date.now() - startTime,
      };
    }

    // 对每个类型进行蒸馏
    for (const { type, count } of typesToDistill) {
      // 获取该类型的记忆
      const entriesRes = await params.pool.query(
        `
          SELECT id, title, content_text, created_at
          FROM memory_entries
          WHERE tenant_id = $1
            AND space_id = $2
            AND type = $3
            AND deleted_at IS NULL
            AND resolution_status IS NULL
          ORDER BY created_at ASC
          LIMIT $4
        `,
        [params.tenantId, params.spaceId, type, config.batchSize],
      );

      const entries = (entriesRes.rows as any[]).map((r) => ({
        id: String(r.id),
        title: r.title ? String(r.title) : null,
        content: String(r.content_text ?? ""),
        createdAt: String(r.created_at),
      }));

      processed += entries.length;

      if (entries.length < minEntries) continue;

      // 生成摘要
      let summary: string;
      if (params.summarizeCallback) {
        // 使用自定义摘要生成器
        summary = await params.summarizeCallback(
          entries.map((e) => ({ title: e.title, content: e.content })),
        );
      } else {
        // 默认：简单拼接截断（生产环境应使用 LLM）
        const combined = entries
          .map((e) => (e.title ? `[${e.title}] ` : "") + e.content.slice(0, 100))
          .join(" | ");
        summary = combined.slice(0, maxLength) + (combined.length > maxLength ? "..." : "");
      }

      // 记录详情
      details.push({
        id: `distill:${type}`,
        action: config.dryRun ? "would_distill" : "distilled",
        reason: `type=${type}, count=${count}, summary_len=${summary.length}`,
      });

      if (!config.dryRun) {
        // 创建摘要记忆
        const minhash = computeMinhash(summary);
        const summaryTitle = `[摘要] ${type} (${entries.length} 条)`;

        const distillInsertRes = await params.pool.query(
          `
            INSERT INTO memory_entries (
              tenant_id, space_id, owner_subject_id, scope, type, title,
              content_text, content_digest, write_policy, source_ref,
              embedding_model_ref, embedding_minhash, embedding_updated_at
            ) VALUES ($1, $2, NULL, 'space', $3, $4, $5, $6, 'policyAllowed', $7, $8, $9, now())
            RETURNING id
          `,
          [
            params.tenantId,
            params.spaceId,
            `${type}_summary`,
            summaryTitle,
            summary,
            crypto.createHash("sha256").update(summary, "utf8").digest("hex"),
            JSON.stringify({ kind: "distill", sourceCount: entries.length, distilledAt: new Date().toISOString() }),
            "minhash:16@1",
            minhash,
          ],
        );
        const distilledId = distillInsertRes.rows[0]?.id ? String(distillInsertRes.rows[0].id) : null;
        if (distilledId) distilledEntryIds.push(distilledId);

        // 标记原始记忆为已蒸馏
        const entryIds = entries.map((e) => e.id);
        await params.pool.query(
          `
            UPDATE memory_entries
            SET resolution_status = 'distilled',
                updated_at = now()
            WHERE id = ANY($1::uuid[])
          `,
          [entryIds],
        );

        affected += entries.length;
      } else {
        affected += entries.length;
      }
    }

    console.log(
      `[memory-lifecycle] distill_summaries: types=${typesToDistill.length}, processed=${processed}, affected=${affected}, dryRun=${config.dryRun}, durationMs=${Date.now() - startTime}`,
    );
  } catch (err) {
    errors++;
    console.error("[memory-lifecycle] distill_summaries error:", err);
  }

  return {
    operation: "distill_summaries",
    processed,
    affected,
    errors,
    details,
    durationMs: Date.now() - startTime,
    distilledEntryIds: distilledEntryIds.length > 0 ? distilledEntryIds : undefined,
  };
}

/* ── Lifecycle Worker Runner ── */

/**
 * 运行完整的生命周期维护
 */
export async function runLifecycleWorker(params: {
  pool: Pool;
  tenantId?: string;
  spaceId?: string;
  operations?: Array<"purge" | "compact" | "distill" | "distill_upgrade" | "decay">,
  config?: Partial<LifecycleWorkerConfig>;
}): Promise<LifecycleWorkerResult[]> {
  const operations = params.operations ?? ["purge"];
  const results: LifecycleWorkerResult[] = [];

  // 1. Purge expired (全局或按 tenant)
  if (operations.includes("purge")) {
    const purgeResult = await purgeExpiredMemories({
      pool: params.pool,
      tenantId: params.tenantId,
      config: params.config,
    });
    results.push(purgeResult);
  }

  // 2. Compact similar (需要 tenant + space)
  if (operations.includes("compact") && params.tenantId && params.spaceId) {
    const compactResult = await compactSimilarMemories({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      config: params.config,
    });
    results.push(compactResult);
  }

  // 3. Distill summaries (需要 tenant + space)
  if (operations.includes("distill") && params.tenantId && params.spaceId) {
    const distillResult = await distillSessionSummaries({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      config: params.config,
    });
    results.push(distillResult);
  }

  // 4. P1-3 Memory OS: 三级蒸馏升级 (episodic→semantic→procedural)
  if (operations.includes("distill_upgrade") && params.tenantId && params.spaceId) {
    const upgradeResult = await distillUpgradeMemories({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      config: params.config,
    });
    results.push(upgradeResult);
  }

  // 5. P1-3 Memory OS: 差异化衰减更新
  if (operations.includes("decay")) {
    const decayResult = await updateMemoryDecayScores({
      pool: params.pool,
      tenantId: params.tenantId,
      config: params.config,
    });
    results.push(decayResult);
  }

  return results;
}

/* ── P1-3 Memory OS: 三级蒸馏升级引擎 ── */

/**
 * 三级蒸馏升级引擎：
 * 1. episodic → semantic：多条事件记忆蒸馏为事实/经验
 * 2. semantic → procedural：多条事实记忆蒸馏为策略/规范
 *
 * 触发条件：同一 space 下某类记忆数量超过阈值且未被蒸馏过
 */
export async function distillUpgradeMemories(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  /** episodic 蒸馏阈值，默认 5 条 */
  episodicThreshold?: number;
  /** semantic 蒸馏阈值，默认 8 条 */
  semanticThreshold?: number;
  config?: Partial<LifecycleWorkerConfig>;
}): Promise<LifecycleWorkerResult> {
  const config = { ...DEFAULT_CONFIG, ...params.config };
  const startTime = Date.now();
  const details: LifecycleWorkerResult["details"] = [];
  let processed = 0;
  let affected = 0;
  let errors = 0;
  const distilledEntryIds: string[] = [];

  const episodicThreshold = params.episodicThreshold ?? 5;
  const semanticThreshold = params.semanticThreshold ?? 8;

  try {
    // ── Stage 1: episodic → semantic 蒸馏 ──
    const episodicRes = await params.pool.query(
      `SELECT id, title, content_text, type, created_at, confidence
       FROM memory_entries
       WHERE tenant_id = $1 AND space_id = $2
         AND memory_class = 'episodic'
         AND distilled_to IS NULL
         AND deleted_at IS NULL
         AND decay_score > 0.1
       ORDER BY created_at ASC
       LIMIT $3`,
      [params.tenantId, params.spaceId, config.batchSize],
    );

    const episodicRows = episodicRes.rows as any[];
    processed += episodicRows.length;

    if (episodicRows.length >= episodicThreshold) {
      // 按 type 分组蒸馏
      const byType = new Map<string, any[]>();
      for (const r of episodicRows) {
        const t = String(r.type ?? "general");
        if (!byType.has(t)) byType.set(t, []);
        byType.get(t)!.push(r);
      }

      for (const [type, rows] of byType) {
        if (rows.length < Math.min(3, episodicThreshold)) continue;

        // 生成蒸馏摘要
        const entriesText = rows.map((r: any) =>
          `[${r.title ?? "无标题"}] ${String(r.content_text ?? "").slice(0, 200)}`
        ).join("\n");

        let summary: string | null = null;
        try {
          summary = await summarizeWithLlm(
            rows.map((r: any) => ({ title: r.title ?? null, content: String(r.content_text ?? "").slice(0, 200) }))
          );
        } catch { /* LLM 失败降级 */ }

        if (!summary) {
          summary = rows.map((r: any) => String(r.content_text ?? "").slice(0, 100)).join("; ").slice(0, 500);
        }

        if (!config.dryRun) {
          const minhash = computeMinhash(summary);
          const summaryTitle = `[经验蒸馏] ${type} (${rows.length} 条事件)`;
          const sourceIds = rows.map((r: any) => String(r.id));
          const maxGen = Math.max(...rows.map((r: any) => Number(r.distillation_generation ?? 0)), 0);

          // 创建 semantic 记忆
          const insertRes = await params.pool.query(
            `INSERT INTO memory_entries (
              tenant_id, space_id, owner_subject_id, scope, type, title,
              content_text, content_digest, write_policy,
              embedding_model_ref, embedding_minhash, embedding_updated_at,
              memory_class, distilled_from, distillation_generation, confidence
            ) VALUES ($1,$2,NULL,'space',$3,$4,$5,$6,'policyAllowed',$7,$8,now(),'semantic',$9,$10,$11)
            RETURNING id`,
            [
              params.tenantId, params.spaceId, `${type}_experience`, summaryTitle,
              summary, crypto.createHash("sha256").update(summary, "utf8").digest("hex"),
              "minhash:16@1", minhash, sourceIds, maxGen + 1,
              Math.min(0.9, Math.max(...rows.map((r: any) => Number(r.confidence ?? 0.5)), 0.5) + 0.1),
            ],
          );
          const targetId = String(insertRes.rows[0]?.id);
          if (targetId) distilledEntryIds.push(targetId);

          // 标记源记忆
          await params.pool.query(
            `UPDATE memory_entries SET distilled_to = $2, resolution_status = 'distilled', updated_at = now() WHERE tenant_id = $1 AND id = ANY($3::uuid[]) AND deleted_at IS NULL`,
            [params.tenantId, targetId, sourceIds],
          );

          // 写蒸馏日志
          await params.pool.query(
            `INSERT INTO memory_distillation_log (tenant_id, space_id, distillation_type, source_memory_ids, target_memory_id, reasoning, quality_score)
             VALUES ($1,$2,'episodic_to_semantic',$3,$4,$5,$6)`,
            [params.tenantId, params.spaceId, sourceIds, targetId, `蒸馏 ${rows.length} 条 episodic 记忆为 semantic 经验`, 0.8],
          );

          affected += rows.length;
          details.push({ id: targetId, action: "distill_episodic_to_semantic", reason: `type=${type}, count=${rows.length}` });
        }
      }
    }

    // ── Stage 2: semantic → procedural 蒸馏 ──
    const semanticRes = await params.pool.query(
      `SELECT id, title, content_text, type, created_at, confidence, distillation_generation
       FROM memory_entries
       WHERE tenant_id = $1 AND space_id = $2
         AND memory_class = 'semantic'
         AND distilled_to IS NULL
         AND deleted_at IS NULL
         AND distillation_generation >= 1
         AND decay_score > 0.2
       ORDER BY type, created_at ASC
       LIMIT $3`,
      [params.tenantId, params.spaceId, config.batchSize],
    );

    const semanticRows = semanticRes.rows as any[];
    processed += semanticRows.length;

    if (semanticRows.length >= semanticThreshold) {
      const entriesText = semanticRows.map((r: any) =>
        `[${r.title ?? "无标题"}] ${String(r.content_text ?? "").slice(0, 300)}`
      ).join("\n");

      let summary: string | null = null;
      try {
        summary = await summarizeWithLlm(
          semanticRows.map((r: any) => ({ title: r.title ?? null, content: `[策略升华] ${String(r.content_text ?? "").slice(0, 300)}` }))
        );
      } catch { /* LLM 失败降级 */ }

      if (!summary) {
        summary = semanticRows.map((r: any) => String(r.content_text ?? "").slice(0, 150)).join("; ").slice(0, 500);
      }

      if (!config.dryRun) {
        const minhash = computeMinhash(summary);
        const sourceIds = semanticRows.map((r: any) => String(r.id));
        const maxGen = Math.max(...semanticRows.map((r: any) => Number(r.distillation_generation ?? 0)), 0);

        const insertRes = await params.pool.query(
          `INSERT INTO memory_entries (
            tenant_id, space_id, owner_subject_id, scope, type, title,
            content_text, content_digest, write_policy,
            embedding_model_ref, embedding_minhash, embedding_updated_at,
            memory_class, distilled_from, distillation_generation, confidence
          ) VALUES ($1,$2,NULL,'space','procedural_strategy',$3,$4,$5,'policyAllowed',$6,$7,now(),'procedural',$8,$9,$10)
          RETURNING id`,
          [
            params.tenantId, params.spaceId,
            `[策略蒸馏] ${semanticRows.length} 条经验→策略`,
            summary,
            crypto.createHash("sha256").update(summary, "utf8").digest("hex"),
            "minhash:16@1", minhash, sourceIds, maxGen + 1, 0.9,
          ],
        );
        const targetId = String(insertRes.rows[0]?.id);
        if (targetId) distilledEntryIds.push(targetId);

        await params.pool.query(
          `UPDATE memory_entries SET distilled_to = $2, resolution_status = 'distilled', updated_at = now() WHERE tenant_id = $1 AND id = ANY($3::uuid[]) AND deleted_at IS NULL`,
          [params.tenantId, targetId, sourceIds],
        );

        await params.pool.query(
          `INSERT INTO memory_distillation_log (tenant_id, space_id, distillation_type, source_memory_ids, target_memory_id, reasoning, quality_score)
           VALUES ($1,$2,'semantic_to_procedural',$3,$4,$5,$6)`,
          [params.tenantId, params.spaceId, sourceIds, targetId, `蒸馏 ${semanticRows.length} 条 semantic 经验为 procedural 策略`, 0.85],
        );

        affected += semanticRows.length;
        details.push({ id: targetId, action: "distill_semantic_to_procedural", reason: `count=${semanticRows.length}` });
      }
    }

    console.log(
      `[memory-lifecycle] distill_upgrade: processed=${processed}, affected=${affected}, dryRun=${config.dryRun}, durationMs=${Date.now() - startTime}`,
    );
  } catch (err) {
    errors++;
    console.error("[memory-lifecycle] distill_upgrade error:", err);
  }

  return { operation: "distill_upgrade", processed, affected, errors, details, durationMs: Date.now() - startTime, distilledEntryIds: distilledEntryIds.length > 0 ? distilledEntryIds : undefined };
}

/* ── P1-3 Memory OS: 差异化衰减策略 ── */

/**
 * 按 memory_class 执行不同衰减公式：
 * - episodic: 指数衰减，半衰期 7 天，访问可延缓
 * - semantic: 线性衰减，半衰期 90 天，置信度加成
 * - procedural: 几乎不衰减，半衰期 365 天
 *
 * decay_score 降到 0 的记忆将在下次 purge 中清理
 */
export async function updateMemoryDecayScores(params: {
  pool: Pool;
  tenantId?: string;
  config?: Partial<LifecycleWorkerConfig>;
}): Promise<LifecycleWorkerResult> {
  const config = { ...DEFAULT_CONFIG, ...params.config };
  const startTime = Date.now();
  const details: LifecycleWorkerResult["details"] = [];
  let processed = 0;
  let affected = 0;
  let errors = 0;

  try {
    const tenantFilter = params.tenantId ? "AND tenant_id = $2" : "";
    const args: any[] = [config.batchSize];
    if (params.tenantId) args.push(params.tenantId);

    // 批量获取需要更新衰减的记忆（距离上次衰减更新超过 1 小时，排除 pinned=true 的记忆）
    const res = await params.pool.query(
      `SELECT id, memory_class, access_count, last_accessed_at, decay_score, decay_updated_at, created_at, confidence
       FROM memory_entries
       WHERE deleted_at IS NULL
         AND pinned = FALSE
         AND decay_score > 0
         AND decay_updated_at < now() - interval '1 hour'
         ${tenantFilter}
       ORDER BY decay_updated_at ASC
       LIMIT $1`,
      args,
    );

    const rows = res.rows as any[];
    processed = rows.length;

    if (processed === 0) {
      return { operation: "decay_update", processed: 0, affected: 0, errors: 0, details: [], durationMs: Date.now() - startTime };
    }

    const nowMs = Date.now();
    const updates: Array<{ id: string; newScore: number }> = [];

    for (const r of rows) {
      const memClass = String(r.memory_class ?? "semantic");
      const createdAtMs = Date.parse(String(r.created_at ?? ""));
      const ageDays = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) / (24 * 60 * 60 * 1000) : 0;
      const accessCount = typeof r.access_count === "number" ? r.access_count : 0;
      const confidence = typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0.5;

      let newScore: number;

      switch (memClass) {
        case "episodic": {
          // 指数衰减，半衰期 7 天，访问可延缓
          const halfLifeDays = 7;
          const accessSlowdown = 1 + accessCount * 0.1; // 访问越多衰减越慢
          newScore = Math.exp(-0.693 * ageDays / (halfLifeDays * accessSlowdown));
          break;
        }
        case "semantic": {
          // 线性衰减，半衰期 90 天，置信度加成
          const halfLifeDays = 90;
          const confidenceBonus = confidence * 0.3; // 高置信度衰减更慢
          newScore = Math.max(0, 1 - (ageDays / (halfLifeDays * 2)) * (1 - confidenceBonus));
          break;
        }
        case "procedural": {
          // 几乎不衰减，半衰期 365 天
          const halfLifeDays = 365;
          newScore = Math.exp(-0.693 * ageDays / halfLifeDays);
          newScore = Math.max(0.1, newScore); // procedural 最低保留 0.1
          break;
        }
        default:
          newScore = Math.exp(-0.693 * ageDays / 30); // 默认 30 天半衰期
      }

      newScore = Math.max(0, Math.min(1, newScore));
      updates.push({ id: String(r.id), newScore });
    }

    // 批量更新
    if (!config.dryRun && updates.length > 0) {
      // 使用 unnest 批量更新
      const ids = updates.map(u => u.id);
      const scores = updates.map(u => u.newScore);
      await params.pool.query(
        `UPDATE memory_entries AS m
         SET decay_score = u.score, decay_updated_at = now(), updated_at = now()
         FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::real[]) AS score) AS u
         WHERE m.id = u.id AND m.deleted_at IS NULL`,
        [ids, scores],
      );
      affected = updates.length;

      // 标记衰减到 0 的记忆为过期（下次 purge 时清理）
      const fullyDecayed = updates.filter(u => u.newScore <= 0.01).map(u => u.id);
      if (fullyDecayed.length > 0) {
        await params.pool.query(
          `UPDATE memory_entries SET expires_at = now(), updated_at = now() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND expires_at IS NULL`,
          [fullyDecayed],
        );
        details.push({ id: "-", action: "mark_expired", reason: `${fullyDecayed.length} memories fully decayed` });
      }
    }

    // 统计
    const byClass: Record<string, number> = {};
    for (const r of rows) {
      const cls = String(r.memory_class ?? "semantic");
      byClass[cls] = (byClass[cls] ?? 0) + 1;
    }
    details.push({ id: "-", action: "decay_stats", reason: JSON.stringify(byClass) });

    console.log(
      `[memory-lifecycle] decay_update: processed=${processed}, affected=${affected}, dryRun=${config.dryRun}, durationMs=${Date.now() - startTime}`,
    );
  } catch (err) {
    errors++;
    console.error("[memory-lifecycle] decay_update error:", err);
  }

  return { operation: "decay_update", processed, affected, errors, details, durationMs: Date.now() - startTime };
}
