import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { sha256Hex } from "../../lib/digest";
import { getEmbeddingJob, getIngestJob, getIndexJob, getRetrievalLog, listEmbeddingJobs, listIngestJobs, listIndexJobs, listRetrievalLogs, searchChunksHybrid, listDocuments, getDocument, getDocumentChunkCount } from "../../skills/knowledge-rag/modules/repo";
import { upsertEvidenceRetentionPolicy, listEvidenceRetentionPolicies, deleteEvidenceRetentionPolicy } from "../../skills/knowledge-rag/modules/evidenceGovernanceRepo";
import { activateRetrievalStrategy, createRetrievalStrategy, createStrategyEvalRun, getLatestStrategyEvalSummary, getRetrievalStrategy, getStrategyEvalRun, listRetrievalStrategies, listStrategyEvalRuns, setStrategyEvalRunFinished } from "../../skills/knowledge-rag/modules/strategyRepo";
import { createRetrievalEvalRun, createRetrievalEvalSet, getRetrievalEvalRun, getRetrievalEvalSet, listRetrievalEvalRuns, listRetrievalEvalSets, setRetrievalEvalRunFinished } from "../../skills/knowledge-rag/modules/qualityRepo";

export const governanceKnowledgeRoutes: FastifyPluginAsync = async (app) => {
  /* ── 文档管理 governance ────────────────────────────────────────── */

  app.get("/governance/knowledge/documents", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        status: z.string().min(1).optional(),
        sourceType: z.string().min(1).optional(),
        search: z.string().min(1).optional(),
      })
      .parse(req.query);
    const result = await listDocuments({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
      status: q.status,
      sourceType: q.sourceType,
      search: q.search,
    });
    req.ctx.audit!.outputDigest = { count: result.documents.length, total: result.total };
    return result;
  });

  app.get("/governance/knowledge/documents/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const doc = await getDocument({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!doc) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "文档不存在", "en-US": "Document not found" }, traceId: req.ctx.traceId });
    const chunkCount = await getDocumentChunkCount({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, documentId: params.id });
    req.ctx.audit!.outputDigest = { documentId: doc.id, version: doc.version, chunkCount };
    return { document: doc, chunkCount };
  });

  /* ── 检索日志 ────────────────────────────────────────────────── */

  app.get("/governance/knowledge/retrieval-logs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        rankPolicy: z.string().min(1).optional(),
        degraded: z.coerce.boolean().optional(),
        runId: z.string().uuid().optional(),
        source: z.string().min(1).optional(),
      })
      .parse(req.query);
    const rows = await listRetrievalLogs({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
      rankPolicy: q.rankPolicy,
      degraded: q.degraded,
      runId: q.runId,
      source: q.source,
    });
    req.ctx.audit!.outputDigest = { count: rows.length, limit: q.limit ?? 50, offset: q.offset ?? 0 };
    return { logs: rows };
  });

  app.get("/governance/knowledge/retrieval-logs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await getRetrievalLog({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!row) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "RetrievalLog 不存在", "en-US": "RetrievalLog not found" }, traceId: req.ctx.traceId });
    req.ctx.audit!.outputDigest = { retrievalLogId: row.id, candidateCount: row.candidateCount, returnedCount: row.returnedCount };
    return { log: row };
  });

  app.get("/governance/knowledge/retrieval-strategies", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);
    const rows = await listRetrievalStrategies({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    return { strategies: rows };
  });

  app.post("/governance/knowledge/retrieval-strategies", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z
      .object({
        name: z.string().min(2).max(64),
        config: z.any().optional(),
      })
      .parse(req.body);
    const config =
      body.config && typeof body.config === "object"
        ? body.config
        : {
            kind: "knowledge.retrievalStrategy.v1",
            rankPolicy: "hybrid_minhash_rerank_v2",
            weights: { lex: 1.2, vec: 1, recency: 0.05, metaBoost: 0.08 },
            limits: { lexicalLimit: 80, embedLimit: 120, metaLimit: 40 },
            gate: { minHitAtK: 0.5, minMrrAtK: 0.2 },
          };
    const row = await createRetrievalStrategy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: body.name, config, createdBySubjectId: subject.subjectId ?? null });
    req.ctx.audit!.outputDigest = { id: row.id, name: row.name, version: row.version };
    return { strategy: row };
  });

  app.post("/governance/knowledge/retrieval-strategies/:id/activate", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const strategy = await getRetrievalStrategy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!strategy) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Strategy 不存在", "en-US": "Strategy not found" }, traceId: req.ctx.traceId });
    const gate = (strategy.config as any)?.gate ?? { minHitAtK: 0.5, minMrrAtK: 0.2, minAvgReturnedCount: 1, maxEvalAgeDays: 7 };
    const needsEval = Boolean(gate && (gate.minHitAtK !== undefined || gate.minMrrAtK !== undefined || gate.minAvgReturnedCount !== undefined));
    if (needsEval) {
      const latest = await getLatestStrategyEvalSummary({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, strategyId: strategy.id });
      if (!latest) return reply.status(403).send({ errorCode: "GATE_MISSING_EVAL", message: { "zh-CN": "缺少最近评测结果，禁止激活", "en-US": "Missing eval results" }, traceId: req.ctx.traceId });
      const metrics = latest.metrics ?? null;
      const m = metrics && typeof metrics === "object" ? (metrics as any)[String(strategy.id)] ?? null : null;
      const hitAtK = Number(m?.hitAtK ?? 0);
      const mrrAtK = Number(m?.mrrAtK ?? 0);
      const avgReturnedCount = Number(m?.avgReturnedCount ?? 0);
      const maxAgeDays = gate.maxEvalAgeDays !== undefined ? Number(gate.maxEvalAgeDays) : 7;
      const createdAtMs = Date.parse(String(latest.createdAt ?? ""));
      const ageDays = Number.isFinite(createdAtMs) ? (Date.now() - createdAtMs) / (24 * 60 * 60 * 1000) : Number.POSITIVE_INFINITY;
      if (Number.isFinite(maxAgeDays) && ageDays > maxAgeDays) {
        return reply.status(403).send({
          errorCode: "GATE_MISSING_EVAL",
          message: { "zh-CN": "最近评测结果已过期，禁止激活", "en-US": "Eval results too old" },
          traceId: req.ctx.traceId,
          details: { evalCreatedAt: latest.createdAt, ageDays, maxAgeDays },
        });
      }
      if (
        (gate.minHitAtK !== undefined && hitAtK < Number(gate.minHitAtK)) ||
        (gate.minMrrAtK !== undefined && mrrAtK < Number(gate.minMrrAtK)) ||
        (gate.minAvgReturnedCount !== undefined && avgReturnedCount < Number(gate.minAvgReturnedCount))
      ) {
        return reply.status(403).send({
          errorCode: "GATE_FAILED",
          message: { "zh-CN": "评测指标回归，禁止激活", "en-US": "Gate failed" },
          traceId: req.ctx.traceId,
          details: {
            hitAtK,
            mrrAtK,
            avgReturnedCount,
            minHitAtK: gate.minHitAtK ?? null,
            minMrrAtK: gate.minMrrAtK ?? null,
            minAvgReturnedCount: gate.minAvgReturnedCount ?? null,
            evalCreatedAt: latest.createdAt,
          },
        });
      }
    }
    await activateRetrievalStrategy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: strategy.id });
    req.ctx.audit!.outputDigest = { ok: true, id: strategy.id, name: strategy.name, version: strategy.version };
    return { ok: true };
  });

  app.post("/governance/knowledge/retrieval-strategy-eval-runs", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z
      .object({
        evalSetId: z.string().uuid(),
        strategyIds: z.array(z.string().uuid()).min(1).max(5),
      })
      .parse(req.body);
    const set = await getRetrievalEvalSet({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: body.evalSetId });
    if (!set) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "EvalSet 不存在", "en-US": "EvalSet not found" }, traceId: req.ctx.traceId });

    const run = await createStrategyEvalRun({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, evalSetId: set.id, strategyIds: body.strategyIds, createdBySubjectId: subject.subjectId ?? null });

    const strategies: any[] = [];
    for (const id of body.strategyIds) {
      const s = await getRetrievalStrategy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id });
      if (s) strategies.push(s);
    }
    if (strategies.length === 0) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "没有可用 strategy", "en-US": "No strategies" }, traceId: req.ctx.traceId });

    const queries = Array.isArray(set.queries) ? (set.queries as any[]) : [];
    const results: any[] = [];
    const failures: any[] = [];
    const metricsByStrategy: Record<string, any> = {};
    try {
      for (const s of strategies) {
        let total = 0;
        let hit = 0;
        let mrrSum = 0;
        let candidateSum = 0;
        let returnedSum = 0;
        for (const q of queries) {
          const queryText = String(q?.query ?? "");
          const k = Number(q?.k ?? 5);
          const expected = Array.isArray(q?.expectedDocumentIds) ? (q.expectedDocumentIds as string[]).map(String) : [];
          if (!queryText.trim() || expected.length === 0) continue;
          total++;
          const out = await searchChunksHybrid({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            query: queryText,
            limit: Math.max(1, Math.min(50, k)),
            strategyRef: `${s.name}@${s.version}`,
            strategyConfig: s.config,
          });
          const docs = (out.hits as any[]).map((h) => String(h.document_id ?? "")).filter(Boolean);
          const firstIdx = docs.findIndex((d) => expected.includes(d));
          const ok = firstIdx >= 0;
          if (ok) {
            hit++;
            mrrSum += 1 / (1 + firstIdx);
          }
          candidateSum += Number(out.stageStats?.merged?.candidateCount ?? 0);
          returnedSum += docs.length;
          results.push({
            strategyId: s.id,
            strategyRef: `${s.name}@${s.version}`,
            queryDigest8: sha256Hex(queryText).slice(0, 8),
            k,
            hit: ok,
            firstRank: ok ? firstIdx + 1 : null,
            candidateCount: Number(out.stageStats?.merged?.candidateCount ?? 0),
            returnedCount: docs.length,
            rankPolicy: out.rankPolicy,
          });
        }
        metricsByStrategy[s.id] = {
          strategyRef: `${s.name}@${s.version}`,
          total,
          hitAtK: total ? hit / total : 0,
          mrrAtK: total ? mrrSum / total : 0,
          avgCandidateCount: total ? candidateSum / total : 0,
          avgReturnedCount: total ? returnedSum / total : 0,
        };
      }
      const done = await setStrategyEvalRunFinished({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: run.id, status: "succeeded", metrics: metricsByStrategy, results, failures });
      return { run: done ?? run };
    } catch (e: any) {
      failures.push({ kind: "error", message: String(e?.message ?? e) });
      const done = await setStrategyEvalRunFinished({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: run.id, status: "failed", metrics: metricsByStrategy, results, failures });
      return reply.status(500).send({ run: done ?? run });
    }
  });

  app.get("/governance/knowledge/retrieval-strategy-eval-runs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        evalSetId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);
    const rows = await listStrategyEvalRuns({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, evalSetId: q.evalSetId, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    return { runs: rows };
  });

  app.get("/governance/knowledge/retrieval-strategy-eval-runs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const run = await getStrategyEvalRun({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
    return { run };
  });

  app.get("/governance/knowledge/ingest-jobs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z.object({ status: z.string().min(1).optional(), limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const rows = await listIngestJobs({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, status: q.status, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    req.ctx.audit!.outputDigest = { count: rows.length, limit: q.limit ?? 50, offset: q.offset ?? 0, status: q.status ?? null };
    return { jobs: rows };
  });

  app.get("/governance/knowledge/ingest-jobs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await getIngestJob({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!row) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "IngestJob 不存在", "en-US": "IngestJob not found" }, traceId: req.ctx.traceId });
    return { job: row };
  });

  app.get("/governance/knowledge/embedding-jobs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z.object({ status: z.string().min(1).optional(), limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const rows = await listEmbeddingJobs({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, status: q.status, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    req.ctx.audit!.outputDigest = { count: rows.length, limit: q.limit ?? 50, offset: q.offset ?? 0, status: q.status ?? null };
    return { jobs: rows };
  });

  app.get("/governance/knowledge/embedding-jobs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await getEmbeddingJob({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!row) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "EmbeddingJob 不存在", "en-US": "EmbeddingJob not found" }, traceId: req.ctx.traceId });
    return { job: row };
  });

  app.get("/governance/knowledge/index-jobs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z.object({ status: z.string().min(1).optional(), limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const rows = await listIndexJobs({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, status: q.status, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    req.ctx.audit!.outputDigest = { count: rows.length, limit: q.limit ?? 50, offset: q.offset ?? 0, status: q.status ?? null };
    return { jobs: rows };
  });

  app.get("/governance/knowledge/index-jobs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await getIndexJob({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!row) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "IndexJob 不存在", "en-US": "IndexJob not found" }, traceId: req.ctx.traceId });
    return { job: row };
  });

  app.post("/governance/knowledge/quality/eval-sets", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        queries: z
          .array(
            z.object({
              query: z.string().min(1).max(2000),
              expectedDocumentIds: z.array(z.string().uuid()).min(1).max(50),
              k: z.number().int().positive().max(50).optional(),
            }),
          )
          .min(1)
          .max(2000),
      })
      .parse(req.body);
    const set = await createRetrievalEvalSet({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      name: body.name,
      description: body.description ?? null,
      queries: body.queries,
      createdBySubjectId: subject.subjectId,
    });
    req.ctx.audit!.outputDigest = { evalSetId: set.id, queryCount: Array.isArray(body.queries) ? body.queries.length : 0 };
    return { set };
  });

  app.get("/governance/knowledge/quality/eval-sets", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z.object({ limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const sets = await listRetrievalEvalSets({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    return { sets };
  });

  app.get("/governance/knowledge/quality/eval-sets/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const set = await getRetrievalEvalSet({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!set) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "EvalSet 不存在", "en-US": "EvalSet not found" }, traceId: req.ctx.traceId });
    return { set };
  });

  app.post("/governance/knowledge/quality/eval-sets/:id/runs", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const set = await getRetrievalEvalSet({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!set) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "EvalSet 不存在", "en-US": "EvalSet not found" }, traceId: req.ctx.traceId });

    const run = await createRetrievalEvalRun({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, evalSetId: set.id });

    const queries = Array.isArray(set.queries) ? (set.queries as any[]) : [];
    const results: any[] = [];
    const failures: any[] = [];
    let total = 0;
    let hit = 0;
    let mrrSum = 0;
    let candidateSum = 0;
    let returnedSum = 0;
    try {
      for (const q of queries) {
        const queryText = String(q?.query ?? "");
        const k = Number(q?.k ?? 5);
        const expected = Array.isArray(q?.expectedDocumentIds) ? (q.expectedDocumentIds as string[]).map(String) : [];
        if (!queryText.trim() || expected.length === 0) continue;
        total++;
        const out = await searchChunksHybrid({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, query: queryText, limit: Math.max(1, Math.min(50, k)) });
        const docs = (out.hits as any[]).map((h) => String(h.document_id ?? "")).filter(Boolean);
        const firstIdx = docs.findIndex((d) => expected.includes(d));
        const ok = firstIdx >= 0;
        if (ok) {
          hit++;
          mrrSum += 1 / (1 + firstIdx);
        }
        candidateSum += Number(out.stageStats?.merged?.candidateCount ?? 0);
        returnedSum += docs.length;
        results.push({
          queryDigest8: sha256Hex(queryText).slice(0, 8),
          queryLen: queryText.length,
          k,
          expectedCount: expected.length,
          returnedCount: docs.length,
          candidateCount: Number(out.stageStats?.merged?.candidateCount ?? 0),
          hit: ok,
          firstRank: ok ? firstIdx + 1 : null,
          rankPolicy: out.rankPolicy,
        });
      }
      const metrics = {
        total,
        hitAtK: total ? hit / total : 0,
        mrrAtK: total ? mrrSum / total : 0,
        avgCandidateCount: total ? candidateSum / total : 0,
        avgReturnedCount: total ? returnedSum / total : 0,
      };
      const done = await setRetrievalEvalRunFinished({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId: run.id,
        status: "succeeded",
        metrics,
        results,
        failures,
      });
      return { run: done ?? run };
    } catch (e: any) {
      failures.push({ kind: "error", message: String(e?.message ?? e) });
      const done = await setRetrievalEvalRunFinished({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId: run.id,
        status: "failed",
        metrics: { total, hitAtK: total ? hit / total : 0, mrrAtK: total ? mrrSum / total : 0 },
        results,
        failures,
      });
      return reply.status(500).send({ run: done ?? run });
    }
  });

  app.get("/governance/knowledge/quality/runs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        evalSetId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);
    const runs = await listRetrievalEvalRuns({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, evalSetId: q.evalSetId, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    return { runs };
  });

  app.get("/governance/knowledge/quality/runs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const run = await getRetrievalEvalRun({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "EvalRun 不存在", "en-US": "EvalRun not found" }, traceId: req.ctx.traceId });
    return { run };
  });

  // ─── Knowledge Rerank Config Management APIs ──────────────────────────────

  app.get("/governance/knowledge/rerank-configs", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "list_rerank_configs" });
    const tenantId = req.ctx.subject!.tenantId;
    try {
      const res = await app.db.query(
        "SELECT * FROM knowledge_rerank_configs WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 100",
        [tenantId],
      );
      const configs = (res.rows as any[]).map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        spaceId: r.space_id,
        enabled: Boolean(r.enabled),
        provider: r.provider ?? "external",
        endpoint: r.endpoint ?? "",
        model: r.model ?? "rerank-v1",
        topN: Number(r.top_n ?? 10),
        timeoutMs: Number(r.timeout_ms ?? 5000),
        fallbackMode: r.fallback_mode ?? "cross_encoder_then_rule",
        crossEncoderModelPath: r.cross_encoder_model_path ?? null,
        crossEncoderModelType: r.cross_encoder_model_type ?? "mock",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      return { configs };
    } catch {
      return { configs: [] };
    }
  });

  const rerankConfigUpsertSchema = z.object({
    spaceId: z.string().min(1),
    enabled: z.boolean().default(true),
    provider: z.string().default("external"),
    endpoint: z.string().default(""),
    apiKey: z.string().optional().default(""),
    model: z.string().default("rerank-v1"),
    topN: z.number().min(1).max(100).default(10),
    timeoutMs: z.number().min(1000).max(30000).default(5000),
    fallbackMode: z.enum(["external_only", "cross_encoder", "rule", "cross_encoder_then_rule", "none"]).default("cross_encoder_then_rule"),
    crossEncoderModelPath: z.string().optional().default(""),
    crossEncoderModelType: z.enum(["onnx", "http_local", "mock"]).default("mock"),
  });

  app.put("/governance/knowledge/rerank-config", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "upsert_rerank_config" });
    const tenantId = req.ctx.subject!.tenantId;
    const body = rerankConfigUpsertSchema.parse(req.body);
    const res = await app.db.query(
      `INSERT INTO knowledge_rerank_configs (
        tenant_id, space_id, enabled, provider, endpoint, api_key, model, top_n, timeout_ms,
        fallback_mode, cross_encoder_model_path, cross_encoder_model_type, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
      ON CONFLICT (tenant_id, space_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        provider = EXCLUDED.provider,
        endpoint = EXCLUDED.endpoint,
        api_key = EXCLUDED.api_key,
        model = EXCLUDED.model,
        top_n = EXCLUDED.top_n,
        timeout_ms = EXCLUDED.timeout_ms,
        fallback_mode = EXCLUDED.fallback_mode,
        cross_encoder_model_path = EXCLUDED.cross_encoder_model_path,
        cross_encoder_model_type = EXCLUDED.cross_encoder_model_type,
        updated_at = now()
      RETURNING *`,
      [
        tenantId, body.spaceId, body.enabled, body.provider, body.endpoint || null,
        body.apiKey || null, body.model, body.topN, body.timeoutMs,
        body.fallbackMode, body.crossEncoderModelPath || null, body.crossEncoderModelType,
      ],
    );
    const r = res.rows[0] as any;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      spaceId: r.space_id,
      enabled: Boolean(r.enabled),
      provider: r.provider,
      endpoint: r.endpoint ?? "",
      model: r.model,
      topN: Number(r.top_n),
      timeoutMs: Number(r.timeout_ms),
      fallbackMode: r.fallback_mode ?? "cross_encoder_then_rule",
      updatedAt: r.updated_at,
    };
  });

  app.delete("/governance/knowledge/rerank-config/:spaceId", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "delete_rerank_config" });
    const tenantId = req.ctx.subject!.tenantId;
    const spaceId = (req.params as any).spaceId as string;
    await app.db.query(
      "DELETE FROM knowledge_rerank_configs WHERE tenant_id = $1 AND space_id = $2",
      [tenantId, spaceId],
    );
    return { success: true };
  });

  // ─── Knowledge Embedding Model Config APIs ──────────────────────────────

  app.get("/governance/knowledge/embedding-configs", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "list_embedding_configs" });
    const tenantId = req.ctx.subject!.tenantId;
    try {
      const res = await app.db.query(
        "SELECT * FROM knowledge_embedding_model_configs WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 100",
        [tenantId],
      );
      const configs = (res.rows as any[]).map((r) => ({
        id: r.id, tenantId: r.tenant_id, spaceId: r.space_id ?? null,
        modelName: r.model_name, provider: r.provider ?? "openai",
        endpoint: r.endpoint ?? "", apiKeyRef: r.api_key_ref ?? "",
        dimensions: Number(r.dimensions ?? 1536), batchSize: Number(r.batch_size ?? 50),
        concurrency: Number(r.concurrency ?? 2), maxRetries: Number(r.max_retries ?? 2),
        timeoutMs: Number(r.timeout_ms ?? 30000),
        isDefault: Boolean(r.is_default), isActive: Boolean(r.is_active),
        createdAt: r.created_at, updatedAt: r.updated_at,
      }));
      return { configs };
    } catch { return { configs: [] }; }
  });

  const embeddingConfigSchema = z.object({
    spaceId: z.string().optional().default(""),
    modelName: z.string().min(1),
    provider: z.string().default("openai"),
    endpoint: z.string().default(""),
    apiKeyRef: z.string().optional().default(""),
    dimensions: z.number().min(64).max(4096).default(1536),
    batchSize: z.number().min(1).max(100).default(50),
    concurrency: z.number().min(1).max(8).default(2),
    maxRetries: z.number().min(0).max(5).default(2),
    timeoutMs: z.number().min(1000).max(120000).default(30000),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
  });

  app.put("/governance/knowledge/embedding-config", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "upsert_embedding_config" });
    const tenantId = req.ctx.subject!.tenantId;
    const body = embeddingConfigSchema.parse(req.body);
    const res = await app.db.query(
      `INSERT INTO knowledge_embedding_model_configs (
        tenant_id, space_id, model_name, provider, endpoint, api_key_ref,
        dimensions, batch_size, concurrency, max_retries, timeout_ms,
        is_default, is_active, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
      ON CONFLICT (tenant_id, space_id, is_active) WHERE space_id IS NOT NULL DO UPDATE SET
        model_name=EXCLUDED.model_name, provider=EXCLUDED.provider,
        endpoint=EXCLUDED.endpoint, api_key_ref=EXCLUDED.api_key_ref,
        dimensions=EXCLUDED.dimensions, batch_size=EXCLUDED.batch_size,
        concurrency=EXCLUDED.concurrency, max_retries=EXCLUDED.max_retries,
        timeout_ms=EXCLUDED.timeout_ms, is_default=EXCLUDED.is_default,
        is_active=EXCLUDED.is_active, updated_at=now()
      RETURNING *`,
      [
        tenantId, body.spaceId || null, body.modelName, body.provider,
        body.endpoint || null, body.apiKeyRef || null,
        body.dimensions, body.batchSize, body.concurrency, body.maxRetries,
        body.timeoutMs, body.isDefault, body.isActive,
      ],
    );
    const r = res.rows[0] as any;
    return { id: r.id, spaceId: r.space_id, modelName: r.model_name, provider: r.provider, updatedAt: r.updated_at };
  });

  app.delete("/governance/knowledge/embedding-config/:id", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "delete_embedding_config" });
    const tenantId = req.ctx.subject!.tenantId;
    const id = (req.params as any).id as string;
    await app.db.query("DELETE FROM knowledge_embedding_model_configs WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return { success: true };
  });

  // ─── Knowledge Chunk Config APIs ────────────────────────────────────────

  app.get("/governance/knowledge/chunk-configs", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "list_chunk_configs" });
    const tenantId = req.ctx.subject!.tenantId;
    try {
      const res = await app.db.query(
        "SELECT * FROM knowledge_chunk_configs WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 100",
        [tenantId],
      );
      const configs = (res.rows as any[]).map((r) => ({
        id: r.id, tenantId: r.tenant_id, spaceId: r.space_id,
        strategy: r.strategy ?? "recursive",
        maxLen: Number(r.max_len ?? 600), overlap: Number(r.overlap ?? 80),
        separators: r.separators, semanticThreshold: Number(r.semantic_threshold ?? 0.5),
        enableParentChild: Boolean(r.enable_parent_child),
        parentMaxLen: Number(r.parent_max_len ?? 2000), childMaxLen: Number(r.child_max_len ?? 300),
        tableAware: Boolean(r.table_aware), codeAware: Boolean(r.code_aware),
        createdAt: r.created_at, updatedAt: r.updated_at,
      }));
      return { configs };
    } catch { return { configs: [] }; }
  });

  const chunkConfigSchema = z.object({
    spaceId: z.string().min(1),
    strategy: z.enum(["fixed","paragraph","recursive","semantic","parent_child","table_aware","code_aware"]).default("recursive"),
    maxLen: z.number().min(50).max(10000).default(600),
    overlap: z.number().min(0).max(5000).default(80),
    semanticThreshold: z.number().min(0).max(1).default(0.5),
    enableParentChild: z.boolean().default(false),
    parentMaxLen: z.number().min(200).max(10000).default(2000),
    childMaxLen: z.number().min(50).max(5000).default(300),
    tableAware: z.boolean().default(true),
    codeAware: z.boolean().default(true),
  });

  app.put("/governance/knowledge/chunk-config", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "upsert_chunk_config" });
    const tenantId = req.ctx.subject!.tenantId;
    const body = chunkConfigSchema.parse(req.body);
    const res = await app.db.query(
      `INSERT INTO knowledge_chunk_configs (
        tenant_id, space_id, strategy, max_len, overlap, semantic_threshold,
        enable_parent_child, parent_max_len, child_max_len, table_aware, code_aware, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
      ON CONFLICT (tenant_id, space_id) DO UPDATE SET
        strategy=EXCLUDED.strategy, max_len=EXCLUDED.max_len, overlap=EXCLUDED.overlap,
        semantic_threshold=EXCLUDED.semantic_threshold, enable_parent_child=EXCLUDED.enable_parent_child,
        parent_max_len=EXCLUDED.parent_max_len, child_max_len=EXCLUDED.child_max_len,
        table_aware=EXCLUDED.table_aware, code_aware=EXCLUDED.code_aware, updated_at=now()
      RETURNING *`,
      [
        tenantId, body.spaceId, body.strategy, body.maxLen, body.overlap,
        body.semanticThreshold, body.enableParentChild, body.parentMaxLen,
        body.childMaxLen, body.tableAware, body.codeAware,
      ],
    );
    const r = res.rows[0] as any;
    return { id: r.id, spaceId: r.space_id, strategy: r.strategy, updatedAt: r.updated_at };
  });

  app.delete("/governance/knowledge/chunk-config/:spaceId", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "delete_chunk_config" });
    const tenantId = req.ctx.subject!.tenantId;
    const spaceId = (req.params as any).spaceId as string;
    await app.db.query("DELETE FROM knowledge_chunk_configs WHERE tenant_id = $1 AND space_id = $2", [tenantId, spaceId]);
    return { success: true };
  });

  // ─── Knowledge Vector Store Config APIs ─────────────────────────────────

  app.get("/governance/knowledge/vector-store-configs", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "list_vector_store_configs" });
    const tenantId = req.ctx.subject!.tenantId;
    try {
      const res = await app.db.query(
        "SELECT * FROM knowledge_vector_store_configs WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 100",
        [tenantId],
      );
      const configs = (res.rows as any[]).map((r) => ({
        id: r.id, tenantId: r.tenant_id, spaceId: r.space_id,
        provider: r.provider ?? "pg_fallback",
        endpoint: r.endpoint ?? "", apiKey: r.api_key ?? "",
        timeoutMs: Number(r.timeout_ms ?? 10000),
        collectionPrefix: r.collection_prefix ?? "",
        dbName: r.db_name ?? "default",
        enabled: Boolean(r.enabled),
        createdAt: r.created_at, updatedAt: r.updated_at,
      }));
      return { configs };
    } catch { return { configs: [] }; }
  });

  const vectorStoreConfigSchema = z.object({
    spaceId: z.string().min(1),
    provider: z.enum(["qdrant","milvus","external","pg_fallback"]).default("pg_fallback"),
    endpoint: z.string().default(""),
    apiKey: z.string().optional().default(""),
    timeoutMs: z.number().min(1000).max(60000).default(10000),
    collectionPrefix: z.string().optional().default(""),
    dbName: z.string().optional().default("default"),
    enabled: z.boolean().default(true),
  });

  app.put("/governance/knowledge/vector-store-config", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "upsert_vector_store_config" });
    const tenantId = req.ctx.subject!.tenantId;
    const body = vectorStoreConfigSchema.parse(req.body);
    const res = await app.db.query(
      `INSERT INTO knowledge_vector_store_configs (
        tenant_id, space_id, provider, endpoint, api_key, timeout_ms,
        collection_prefix, db_name, enabled, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
      ON CONFLICT (tenant_id, space_id) DO UPDATE SET
        provider=EXCLUDED.provider, endpoint=EXCLUDED.endpoint, api_key=EXCLUDED.api_key,
        timeout_ms=EXCLUDED.timeout_ms, collection_prefix=EXCLUDED.collection_prefix,
        db_name=EXCLUDED.db_name, enabled=EXCLUDED.enabled, updated_at=now()
      RETURNING *`,
      [
        tenantId, body.spaceId, body.provider, body.endpoint || null,
        body.apiKey || null, body.timeoutMs, body.collectionPrefix || null,
        body.dbName, body.enabled,
      ],
    );
    const r = res.rows[0] as any;
    return { id: r.id, spaceId: r.space_id, provider: r.provider, updatedAt: r.updated_at };
  });

  app.delete("/governance/knowledge/vector-store-config/:spaceId", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "delete_vector_store_config" });
    const tenantId = req.ctx.subject!.tenantId;
    const spaceId = (req.params as any).spaceId as string;
    await app.db.query("DELETE FROM knowledge_vector_store_configs WHERE tenant_id = $1 AND space_id = $2", [tenantId, spaceId]);
    return { success: true };
  });

  // ─── Knowledge Retrieval Strategy APIs ──────────────────────────────────
  // NOTE: GET /governance/knowledge/retrieval-strategies is registered above in this file

  const retrievalStrategySchema = z.object({
    spaceId: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["draft","active","archived"]).default("draft"),
    enableHyde: z.boolean().default(false),
    hydePromptTemplate: z.string().optional().default(""),
    enableQueryExpansion: z.boolean().default(false),
    queryExpansionMode: z.enum(["synonym","subquery","both"]).default("synonym"),
    enableSparseEmbedding: z.boolean().default(false),
  });

  app.put("/governance/knowledge/retrieval-strategy", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "upsert_retrieval_strategy" });
    const tenantId = req.ctx.subject!.tenantId;
    const body = retrievalStrategySchema.parse(req.body);
    const res = await app.db.query(
      `INSERT INTO knowledge_retrieval_strategies (
        tenant_id, space_id, name, version, status, config,
        enable_hyde, hyde_prompt_template, enable_query_expansion,
        query_expansion_mode, enable_sparse_embedding, updated_at
      ) VALUES ($1,$2,$3,1,$4,'{}'::jsonb,$5,$6,$7,$8,$9,now())
      ON CONFLICT (tenant_id, space_id, name, version) DO UPDATE SET
        status=EXCLUDED.status, enable_hyde=EXCLUDED.enable_hyde,
        hyde_prompt_template=EXCLUDED.hyde_prompt_template,
        enable_query_expansion=EXCLUDED.enable_query_expansion,
        query_expansion_mode=EXCLUDED.query_expansion_mode,
        enable_sparse_embedding=EXCLUDED.enable_sparse_embedding, updated_at=now()
      RETURNING *`,
      [
        tenantId, body.spaceId, body.name, body.status,
        body.enableHyde, body.hydePromptTemplate || null,
        body.enableQueryExpansion, body.queryExpansionMode,
        body.enableSparseEmbedding,
      ],
    );
    const r = res.rows[0] as any;
    return { id: r.id, spaceId: r.space_id, name: r.name, status: r.status, updatedAt: r.updated_at };
  });

  app.delete("/governance/knowledge/retrieval-strategy/:id", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "delete_retrieval_strategy" });
    const tenantId = req.ctx.subject!.tenantId;
    const id = (req.params as any).id as string;
    await app.db.query("DELETE FROM knowledge_retrieval_strategies WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return { success: true };
  });

  // ─── Knowledge Evidence Retention Policy APIs ──────────────────────────

  app.get("/governance/knowledge/retention-policies", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "list_retention_policies" });
    const tenantId = req.ctx.subject!.tenantId;
    const policies = await listEvidenceRetentionPolicies({ pool: app.db, tenantId });
    return { policies };
  });

  app.put("/governance/knowledge/retention-policy", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "upsert_retention_policy" });
    const tenantId = req.ctx.subject!.tenantId;
    const body = z.object({
      spaceId: z.string().min(1),
      allowSnippet: z.boolean().default(true),
      retentionDays: z.number().min(1).max(3650).default(30),
      maxSnippetLen: z.number().min(50).max(5000).default(600),
    }).parse(req.body);
    const row = await upsertEvidenceRetentionPolicy({
      pool: app.db,
      tenantId,
      spaceId: body.spaceId,
      allowSnippet: body.allowSnippet,
      retentionDays: body.retentionDays,
      maxSnippetLen: body.maxSnippetLen,
    });
    return {
      spaceId: row.space_id,
      allowSnippet: Boolean(row.allow_snippet),
      retentionDays: Number(row.retention_days),
      updatedAt: row.updated_at,
    };
  });

  app.delete("/governance/knowledge/retention-policy/:spaceId", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "delete_retention_policy" });
    const tenantId = req.ctx.subject!.tenantId;
    const spaceId = (req.params as any).spaceId as string;
    await deleteEvidenceRetentionPolicy({ pool: app.db, tenantId, spaceId });
    return { success: true };
  });
};
