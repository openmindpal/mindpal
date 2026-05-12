/**
 * P3: 记忆管理路由 — 确认/拒绝待确认记忆 + 图谱可视化 API
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { confirmOrRejectMemory } from "../modules/memory/repo";

const confirmBodySchema = z.object({
  decision: z.enum(["confirm", "reject"]),
});

const memoryClassEnum = z.enum(["episodic", "semantic", "procedural"]);

export const memoryRoutes: FastifyPluginAsync = async (app) => {
  // P3: 确认或拒绝待确认的记忆
  app.post<{
    Params: { id: string };
    Body: { decision: "confirm" | "reject" };
  }>("/memory/:id/confirm", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { decision } = confirmBodySchema.parse(req.body);

    const subject = req.ctx.subject!;
    if (!subject.tenantId) {
      return reply.status(400).send({ error: "Missing tenantId" });
    }

    const result = await confirmOrRejectMemory(
      app.db,
      subject.tenantId,
      id,
      decision,
    );

    return reply.send({ ok: true, updated: result.updated });
  });

  // ── GET /memory/graph — 记忆图谱节点与边 ──
  app.get("/memory/graph", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.tenantId) {
      return reply.status(400).send({ error: "Missing tenantId" });
    }

    const query = z.object({
      class: memoryClassEnum.optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
      minConfidence: z.coerce.number().min(0).max(1).default(0.3),
    }).parse(req.query);

    // Fetch nodes
    const conditions: string[] = [
      "tenant_id = $1",
      "deleted_at IS NULL",
      "confidence >= $2",
    ];
    const params: unknown[] = [subject.tenantId, query.minConfidence];

    if (query.class) {
      params.push(query.class);
      conditions.push(`memory_class = $${params.length}`);
    }

    params.push(query.limit);
    const limitParam = `$${params.length}`;

    const nodesResult = await app.db.query(
      `SELECT id, title, memory_class, confidence, decay_score, distilled_from, created_at
       FROM memory_entries
       WHERE ${conditions.join(" AND ")}
       ORDER BY decay_score DESC, created_at DESC
       LIMIT ${limitParam}`,
      params,
    );

    const nodes = nodesResult.rows.map((r: any) => ({
      id: r.id,
      title: r.title ?? "",
      memoryClass: r.memory_class,
      confidence: r.confidence,
      decayScore: r.decay_score,
      createdAt: r.created_at,
    }));

    // Build edges from distilled_from (distillation type)
    const nodeIds = new Set(nodes.map((n: any) => n.id));
    const edges: { id: string; source: string; target: string; type: string; weight: number }[] = [];

    for (const row of nodesResult.rows) {
      const distilledFrom: string[] | null = row.distilled_from;
      if (distilledFrom && Array.isArray(distilledFrom)) {
        for (const sourceId of distilledFrom) {
          if (nodeIds.has(sourceId)) {
            edges.push({
              id: `dist-${sourceId}-${row.id}`,
              source: sourceId,
              target: row.id,
              type: "distillation",
              weight: row.confidence ?? 0.5,
            });
          }
        }
      }
    }

    // Build edges from memory_task_states.related_run_ids (association type)
    if (nodes.length > 0) {
      const taskStatesResult = await app.db.query(
        `SELECT mts.run_id, mts.related_run_ids
         FROM memory_task_states mts
         WHERE mts.tenant_id = $1 AND mts.deleted_at IS NULL AND mts.related_run_ids IS NOT NULL`,
        [subject.tenantId],
      );

      // Build run_id -> memory_entry mapping via source_ref
      const runToMemory = new Map<string, string>();
      for (const row of nodesResult.rows) {
        const sourceRef = row.source_ref;
        if (sourceRef && typeof sourceRef === "object" && sourceRef.runId) {
          runToMemory.set(sourceRef.runId, row.id);
        }
      }

      for (const ts of taskStatesResult.rows) {
        const sourceMemoryId = runToMemory.get(ts.run_id);
        if (!sourceMemoryId || !nodeIds.has(sourceMemoryId)) continue;
        const relatedRunIds: string[] = ts.related_run_ids ?? [];
        for (const relId of relatedRunIds) {
          const targetMemoryId = runToMemory.get(relId);
          if (targetMemoryId && nodeIds.has(targetMemoryId) && targetMemoryId !== sourceMemoryId) {
            edges.push({
              id: `assoc-${sourceMemoryId}-${targetMemoryId}`,
              source: sourceMemoryId,
              target: targetMemoryId,
              type: "association",
              weight: 0.5,
            });
          }
        }
      }
    }

    return { nodes, edges };
  });

  // NOTE: GET /memory/stats 已迁移至 skills/memory-manager/routes.ts（含权限+审计）

  // ── GET /memory/search — 记忆搜索 ──
  app.get("/memory/search", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.tenantId) {
      return reply.status(400).send({ error: "Missing tenantId" });
    }

    const query = z.object({
      q: z.string().min(1).max(200),
      class: memoryClassEnum.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const keyword = `%${query.q}%`;
    const conditions: string[] = [
      "tenant_id = $1",
      "deleted_at IS NULL",
      "(title ILIKE $2 OR content_text ILIKE $2)",
    ];
    const params: unknown[] = [subject.tenantId, keyword];

    if (query.class) {
      params.push(query.class);
      conditions.push(`memory_class = $${params.length}`);
    }

    const whereClause = conditions.join(" AND ");

    // Count total
    const countResult = await app.db.query(
      `SELECT COUNT(*)::int AS total FROM memory_entries WHERE ${whereClause}`,
      params,
    );
    const total: number = countResult.rows[0]?.total ?? 0;

    // Fetch items
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const itemsResult = await app.db.query(
      `SELECT id, title, LEFT(content_text, 200) AS content_text, memory_class, confidence, decay_score, created_at
       FROM memory_entries
       WHERE ${whereClause}
       ORDER BY confidence DESC, created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, query.limit, query.offset],
    );

    const items = itemsResult.rows.map((r: any) => ({
      id: r.id,
      title: r.title ?? "",
      contentText: r.content_text ?? "",
      memoryClass: r.memory_class,
      confidence: r.confidence,
      decayScore: r.decay_score,
      createdAt: r.created_at,
    }));

    return { items, total };
  });
};
