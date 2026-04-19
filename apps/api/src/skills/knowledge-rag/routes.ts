import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { z } from "zod";
import { redactValue, parseDocument, StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:knowledgeRoutes" });
import { Errors } from "../../lib/errors";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { createDocument, createIndexJob, createRetrievalLog, getRetrievalLog, resolveEvidenceRef, resolveEvidenceRefByChunkId, searchChunksHybrid, listDocuments, getDocument, updateDocument, deleteDocument, getDocumentChunkCount } from "./modules/repo";
import { runAgenticSearch, determineSearchStrategy } from "./modules/agenticSearch";
import { getEvidenceRetentionPolicy, insertEvidenceAccessEvent } from "./modules/evidenceGovernanceRepo";
import { getActiveRetrievalStrategy } from "./modules/strategyRepo";

const MAX_FETCH_URL_RESPONSE_BYTES = 1_000_000;
const MAX_FETCH_URL_REDIRECTS = 3;
const FETCH_URL_ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const BLOCKED_FETCH_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string) {
  const normalized = ip.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function isBlockedIpAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return false;
}

function assertSafeFetchHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) throw Errors.badRequest("URL 主机不能为空");
  if (BLOCKED_FETCH_HOSTNAMES.has(normalized) || normalized.endsWith(".local")) {
    throw Errors.badRequest("禁止抓取本地或内部地址");
  }
}

async function assertSafeFetchUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw Errors.badRequest("URL 非法");
  }

  if (!FETCH_URL_ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw Errors.badRequest("仅支持 http/https URL");
  }
  if (parsed.username || parsed.password) {
    throw Errors.badRequest("URL 不允许携带用户名或密码");
  }

  assertSafeFetchHostname(parsed.hostname);
  if (isBlockedIpAddress(parsed.hostname)) {
    throw Errors.badRequest("禁止抓取内网或本地地址");
  }

  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true }).catch(() => [] as Array<{ address: string }>);
  if (addresses.some((item) => isBlockedIpAddress(item.address))) {
    throw Errors.badRequest("目标地址解析到内网或本地地址");
  }

  return parsed;
}

async function fetchUrlWithGuards(targetUrl: string, signal: AbortSignal) {
  let currentUrl = targetUrl;
  for (let hop = 0; hop <= MAX_FETCH_URL_REDIRECTS; hop++) {
    const parsed = await assertSafeFetchUrl(currentUrl);
    const res = await fetch(parsed.toString(), {
      headers: { "user-agent": "OpenSlin-KnowledgeBot/1.0", accept: "text/html,text/plain,application/json,*/*" },
      signal,
      redirect: "manual",
    } as any);

    if (res.status >= 300 && res.status < 400) {
      const location = String(res.headers.get("location") ?? "").trim();
      if (!location) throw Errors.badRequest(`抓取失败，HTTP ${res.status}`);
      if (hop === MAX_FETCH_URL_REDIRECTS) throw Errors.badRequest("重定向次数过多");
      currentUrl = new URL(location, parsed).toString();
      continue;
    }

    return { res, finalUrl: parsed.toString() };
  }

  throw Errors.badRequest("重定向次数过多");
}

async function readResponseTextWithLimit(res: Response, maxBytes: number) {
  const contentLength = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw Errors.badRequest("响应体过大，已拒绝抓取");
  }

  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      try { reader.cancel(); } catch {}
      throw Errors.badRequest("响应体过大，已拒绝抓取");
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

export const knowledgeRoutes: FastifyPluginAsync = async (app) => {
  app.post("/knowledge/documents", async (req) => {
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .object({
        title: z.string().min(1),
        sourceType: z.string().min(1),
        tags: z.any().optional(),
        contentText: z.string().min(1),
        visibility: z.enum(["space", "subject"]).optional(),
      })
      .parse(req.body);

    req.ctx.audit!.inputDigest = { title: body.title, sourceType: body.sourceType, contentLen: body.contentText.length };

    const doc = await createDocument({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      title: body.title,
      sourceType: body.sourceType,
      tags: body.tags,
      contentText: body.contentText,
      visibility: body.visibility ?? "space",
      ownerSubjectId: body.visibility === "subject" ? subject.subjectId : null,
    });
    const indexJob = await createIndexJob({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, documentId: doc.id, documentVersion: doc.version });

    await app.queue.add("knowledge.index", { kind: "knowledge.index", indexJobId: indexJob.id }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });

    req.ctx.audit!.outputDigest = { documentId: doc.id, version: doc.version, indexJobId: indexJob.id };
    return { documentId: doc.id, version: doc.version, indexJobId: indexJob.id };
  });

  /* ── 二进制文件上传 → 解析 → 入库 一站式闭环 ───────────────────── */

  app.post("/knowledge/documents/upload", async (req) => {
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .object({
        title: z.string().min(1),
        sourceType: z.string().min(1).optional(),
        tags: z.any().optional(),
        visibility: z.enum(["space", "subject"]).optional(),
        fileName: z.string().min(1),
        mimeType: z.string().min(1),
        fileBase64: z.string().min(1),
      })
      .parse(req.body);

    // 解码 base64 为 Buffer
    const buffer = Buffer.from(body.fileBase64, "base64");
    const byteSize = buffer.length;

    // 调用统一文档解析引擎
    const parseResult = await parseDocument({
      buffer,
      mimeType: body.mimeType,
      fileName: body.fileName,
    });

    const contentText = parseResult.text;
    if (!contentText.trim()) throw Errors.badRequest("文档解析后无文本内容");

    req.ctx.audit!.inputDigest = {
      title: body.title,
      fileName: body.fileName,
      mimeType: body.mimeType,
      byteSize,
      parseMethod: parseResult.stats.parseMethod,
      extractedTextLen: contentText.length,
    };

    // 创建文档（带解析元数据）
    const doc = await createDocument({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      title: body.title,
      sourceType: body.sourceType ?? "file",
      tags: body.tags,
      contentText,
      visibility: body.visibility ?? "space",
      ownerSubjectId: body.visibility === "subject" ? subject.subjectId : null,
    });

    // 写入解析元数据到 knowledge_documents
    try {
      await app.db.query(
        `UPDATE knowledge_documents
         SET original_content_type = $2,
             original_byte_size = $3,
             parse_method = $4,
             parse_stats = $5,
             source_file_name = $6
         WHERE id = $1`,
        [
          doc.id,
          body.mimeType,
          byteSize,
          parseResult.stats.parseMethod,
          JSON.stringify(parseResult.stats),
          body.fileName,
        ],
      );
    } catch { /* migration 未跑时忽略 */ }

    const indexJob = await createIndexJob({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      documentId: doc.id,
      documentVersion: doc.version,
    });

    await app.queue.add(
      "knowledge.index",
      { kind: "knowledge.index", indexJobId: indexJob.id },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
    );

    req.ctx.audit!.outputDigest = {
      documentId: doc.id,
      version: doc.version,
      indexJobId: indexJob.id,
      parseMethod: parseResult.stats.parseMethod,
      parseTimeMs: parseResult.stats.parseTimeMs,
      extractedTextLen: contentText.length,
      pageCount: parseResult.documentMetadata.pageCount,
    };

    return {
      documentId: doc.id,
      version: doc.version,
      indexJobId: indexJob.id,
      parseStats: {
        parseMethod: parseResult.stats.parseMethod,
        parseTimeMs: parseResult.stats.parseTimeMs,
        extractedTextLength: parseResult.stats.extractedTextLength,
        elementCount: parseResult.stats.elementCount,
        pageCount: parseResult.documentMetadata.pageCount,
        warnings: parseResult.stats.warnings,
      },
    };
  });

  /* ── 文档管理 ─────────────────────────────────────────────────── */

  app.get("/knowledge/documents", async (req) => {
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
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

  app.get("/knowledge/documents/:id", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const doc = await getDocument({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!doc) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "文档不存在", "en-US": "Document not found" }, traceId: req.ctx.traceId });

    const chunkCount = await getDocumentChunkCount({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, documentId: params.id });
    req.ctx.audit!.outputDigest = { documentId: doc.id, version: doc.version, chunkCount };
    return { document: doc, chunkCount };
  });

  app.post("/knowledge/documents/:id/update", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        title: z.string().min(1).optional(),
        tags: z.any().optional(),
        status: z.enum(["active", "archived"]).optional(),
      })
      .parse(req.body);

    const doc = await updateDocument({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      id: params.id,
      title: body.title,
      tags: body.tags,
      status: body.status,
    });
    if (!doc) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "文档不存在", "en-US": "Document not found" }, traceId: req.ctx.traceId });

    req.ctx.audit!.outputDigest = { documentId: doc.id, version: doc.version };
    return { document: doc };
  });

  app.post("/knowledge/documents/:id/delete", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const deleted = await deleteDocument({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!deleted) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "文档不存在", "en-US": "Document not found" }, traceId: req.ctx.traceId });

    req.ctx.audit!.outputDigest = { documentId: params.id, deleted: true };
    return { ok: true };
  });

  /* ── URL 抓取代理 ──────────────────────────────────────────────── */

  app.post("/knowledge/fetch-url", async (req) => {
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;

    const body = z.object({ url: z.string().url() }).parse(req.body);
    const targetUrl = body.url;
    req.ctx.audit!.inputDigest = { url: targetUrl };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const { res, finalUrl } = await fetchUrlWithGuards(targetUrl, controller.signal);
      if (!res.ok) {
        _logger.error("fetch-url failed", { status: res.status, url: finalUrl });
        throw Errors.badRequest(`抓取失败，HTTP ${res.status}`);
      }
      const ct = String(res.headers.get("content-type") ?? "");
      const raw = await readResponseTextWithLimit(res, MAX_FETCH_URL_RESPONSE_BYTES);
      /* 简单提取纯文本：如果是 HTML，去标签 */
      let text = raw;
      if (ct.includes("html")) {
        text = raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
      /* 自动提取标题 */
      let title = "";
      const titleMatch = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) title = titleMatch[1]!.trim();
      if (!title) {
        try { const u = new URL(targetUrl); title = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? u.hostname); } catch { title = targetUrl.slice(0, 80); }
      }
      const truncated = text.length > 200000;
      if (truncated) text = text.slice(0, 200000);
      req.ctx.audit!.outputDigest = { contentLen: text.length, truncated, title, finalUrl };
      return { content: text, title, contentType: ct, truncated, charCount: text.length, finalUrl };
    } catch (e: any) {
      if (e?.statusCode) throw e; /* 已经是 Errors */
      _logger.error("fetch-url exception", { error: e?.message ?? e });
      throw Errors.badRequest(`抓取失败: ${e?.message ?? "网络错误"}`);
    } finally {
      clearTimeout(timer);
    }
  });

  /* ── Agentic Search (多轮搜索验证) ───────────────────────────── */

  app.post("/knowledge/agentic-search", async (req) => {
    const startedAt = Date.now();
    try {
      setAuditContext(req, { resourceType: "knowledge", action: "search" });
      const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
      req.ctx.audit!.policyDecision = decision;

      const subject = requireSubject(req);
      if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

      const body = z
        .object({
          query: z.string().min(1).max(10000),
          forceStrategy: z.enum(["simple", "agentic", "hybrid"]).optional(),
          config: z.object({
            maxRounds: z.number().int().min(1).max(10).optional(),
            confidenceThreshold: z.number().min(0.1).max(1.0).optional(),
            enableQueryRewrite: z.boolean().optional(),
            enableCrossCheck: z.boolean().optional(),
          }).optional(),
          context: z.object({
            hasExternalSources: z.boolean().optional(),
            requiresRealtime: z.boolean().optional(),
            sensitiveData: z.boolean().optional(),
          }).optional(),
        })
        .parse(req.body);

      req.ctx.audit!.inputDigest = { queryLen: body.query.length, forceStrategy: body.forceStrategy ?? null };

      const result = await runAgenticSearch({
        app,
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        query: body.query,
        authorization: req.headers.authorization ?? "",
        traceId: req.ctx.traceId,
        forceStrategy: body.forceStrategy,
        config: body.config,
        context: body.context,
      });

      req.ctx.audit!.outputDigest = {
        sessionId: result.sessionId,
        strategy: result.strategy,
        confidence: result.confidence,
        totalRounds: result.totalRounds,
        evidenceCount: result.evidence.length,
        requiresApproval: result.requiresApproval,
      };

      app.metrics.observeKnowledgeSearch({ result: "ok", latencyMs: Date.now() - startedAt });
      return result;
    } catch (e: any) {
      app.metrics.observeKnowledgeSearch({ result: "error", latencyMs: Date.now() - startedAt });
      throw e;
    }
  });

  app.get("/knowledge/agentic-search/strategy", async (req) => {
    const subject = requireSubject(req);
    const q = z.object({ query: z.string().min(1) }).parse(req.query);
    const strategy = determineSearchStrategy(q.query);
    return { query: q.query, strategy };
  });

  /* ── 检索 ─────────────────────────────────────────────────────── */

  app.post("/knowledge/search", async (req) => {
    const startedAt = Date.now();
    try {
      setAuditContext(req, { resourceType: "knowledge", action: "search" });
      const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
      req.ctx.audit!.policyDecision = decision;

      const subject = requireSubject(req);
      if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

      const body = z
        .object({
          query: z.string().min(1),
          limit: z.number().int().positive().max(20).optional(),
          filters: z
            .object({
              documentIds: z.array(z.string().uuid()).max(200).optional(),
              tags: z.array(z.string().min(1)).max(20).optional(),
              sourceTypes: z.array(z.string().min(1)).max(20).optional(),
            })
            .optional(),
        })
        .parse(req.body);

      const limit = body.limit ?? 5;
      req.ctx.audit!.inputDigest = { queryLen: body.query.length, limit };

      const activeStrategy = await getActiveRetrievalStrategy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId });
      const strategyRef = activeStrategy ? `${activeStrategy.name}@${activeStrategy.version}` : null;

      const out = await searchChunksHybrid({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        query: body.query,
        limit,
        documentIds: body.filters?.documentIds,
        tags: body.filters?.tags,
        sourceTypes: body.filters?.sourceTypes,
        strategyRef,
        strategyConfig: activeStrategy?.config ?? null,
      });
      const rankPolicy = out.rankPolicy;
      const evidenceBase = out.hits.map((h: any) => {
        const snippetRaw = String(h.snippet ?? "");
        const clipped = snippetRaw.slice(0, 280);
        const redacted = redactValue(clipped);
        return {
          sourceRef: { documentId: h.document_id, version: h.document_version, chunkId: h.id },
          snippet: String(redacted.value ?? ""),
          location: { chunkIndex: h.chunk_index, startOffset: h.start_offset, endOffset: h.end_offset },
          snippetDigest: { len: snippetRaw.length, sha256_8: crypto.createHash("sha256").update(snippetRaw, "utf8").digest("hex").slice(0, 8) },
          rankReason: h.rank_reason ?? { kind: rankPolicy },
        };
      });

      const retrievalLogId = await createRetrievalLog({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        queryDigest: { queryLen: body.query.length, rankPolicy },
        filtersDigest: { spaceId: subject.spaceId, source: "knowledge.search.http", documentIds: body.filters?.documentIds ?? null, tags: body.filters?.tags ?? null, sourceTypes: body.filters?.sourceTypes ?? null },
        candidateCount: out.stageStats.merged.candidateCount,
        citedRefs: evidenceBase.map((e) => e.sourceRef),
        rankPolicy,
        strategyRef: (out as any).strategyRef ?? strategyRef,
        vectorStoreRef: (out as any).vectorStoreRef ?? null,
        stageStats: out.stageStats,
        rankedEvidenceRefs: evidenceBase.map((e) => ({ sourceRef: e.sourceRef, rankReason: e.rankReason, snippetDigest: e.snippetDigest, location: e.location })),
        returnedCount: evidenceBase.length,
        degraded: Boolean((out as any).degraded ?? false),
        degradeReason: (out as any).degradeReason ?? null,
      });

      const evidence = evidenceBase.map((e) => ({ ...e, retrievalLogId }));
      req.ctx.audit!.outputDigest = {
        retrievalLogId,
        candidateCount: out.stageStats.merged.candidateCount,
        returnedCount: evidenceBase.length,
        citedRefs: evidenceBase.map((e) => e.sourceRef),
        rankPolicy,
        stageStats: out.stageStats,
      };
      app.metrics.observeKnowledgeSearch({ result: "ok", latencyMs: Number(out.stageStats?.latencyMs ?? Date.now() - startedAt) });
      return { retrievalLogId, evidence, candidateCount: out.stageStats.merged.candidateCount, returnedCount: evidenceBase.length, rankSummary: { rankPolicy, stageStats: out.stageStats } };
    } catch (e: any) {
      app.metrics.observeKnowledgeSearch({ result: e?.errorCode ? (String(e.errorCode).includes("DENIED") || String(e.errorCode).includes("FORBIDDEN") ? "denied" : "error") : "error", latencyMs: Date.now() - startedAt });
      throw e;
    }
  });

  async function assertEvidenceBelongsToRetrievalLog(params: { tenantId: string; spaceId: string; retrievalLogId: string; sourceRef: any; log?: any }) {
    const log = params.log ?? (await getRetrievalLog({ pool: app.db, tenantId: params.tenantId, spaceId: params.spaceId, id: params.retrievalLogId }));
    if (!log) throw Errors.notFound("retrievalLogId 不存在");
    const check = (x: any) =>
      x &&
      typeof x === "object" &&
      String((x as any).documentId ?? "") === String(params.sourceRef?.documentId ?? "") &&
      Number((x as any).version ?? NaN) === Number(params.sourceRef?.version ?? NaN) &&
      String((x as any).chunkId ?? "") === String(params.sourceRef?.chunkId ?? "");
    const cited = Array.isArray(log.citedRefs) ? log.citedRefs.some(check) : false;
    const ranked = Array.isArray(log.rankedEvidenceRefs) ? log.rankedEvidenceRefs.some((e: any) => check(e?.sourceRef)) : false;
    if (!cited && !ranked) throw Errors.notFound("Evidence 不存在或无权限");
    return log;
  }

  app.post("/knowledge/evidence/resolve", async (req, reply) => {
    const startedAt = Date.now();
    try {
      setAuditContext(req, { resourceType: "knowledge", action: "search" });
      const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
      req.ctx.audit!.policyDecision = decision;

      const subject = requireSubject(req);
      if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
      const retention = await getEvidenceRetentionPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId });
      const body = z
        .object({
          sourceRef: z.object({ documentId: z.string().uuid(), version: z.number().int().positive(), chunkId: z.string().uuid() }),
          retrievalLogId: z.string().uuid().optional(),
          maxSnippetLen: z.number().int().positive().max(2000).optional(),
        })
        .parse(req.body);

      let log: any = null;
      if (body.retrievalLogId) {
        const boundLog = await getRetrievalLog({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: body.retrievalLogId });
        if (!boundLog) {
          await insertEvidenceAccessEvent({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            retrievalLogId: null,
            documentId: body.sourceRef.documentId,
            documentVersion: body.sourceRef.version,
            chunkId: body.sourceRef.chunkId,
            allowed: false,
            reason: "RETRIEVAL_LOG_NOT_FOUND",
          });
          app.metrics.observeKnowledgeEvidenceResolve({ result: "not_found", latencyMs: Date.now() - startedAt });
          return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Evidence 不存在或无权限", "en-US": "Evidence not found or not allowed" }, traceId: req.ctx.traceId });
        }
        try {
          log = await assertEvidenceBelongsToRetrievalLog({ tenantId: subject.tenantId, spaceId: subject.spaceId, retrievalLogId: body.retrievalLogId, sourceRef: body.sourceRef, log: boundLog });
        } catch (e: any) {
          await insertEvidenceAccessEvent({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            retrievalLogId: body.retrievalLogId,
            documentId: body.sourceRef.documentId,
            documentVersion: body.sourceRef.version,
            chunkId: body.sourceRef.chunkId,
            allowed: false,
            reason: e?.errorCode ? String(e.errorCode) : "NOT_ALLOWED",
          });
          app.metrics.observeKnowledgeEvidenceResolve({ result: "not_found", latencyMs: Date.now() - startedAt });
          return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Evidence 不存在或无权限", "en-US": "Evidence not found or not allowed" }, traceId: req.ctx.traceId });
        }
      }

      const r = body.retrievalLogId
        ? await resolveEvidenceRef({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            sourceRef: body.sourceRef,
          })
        : await resolveEvidenceRefByChunkId({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            chunkId: body.sourceRef.chunkId,
          });
      if (!r) {
        await insertEvidenceAccessEvent({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          subjectId: subject.subjectId,
          retrievalLogId: body.retrievalLogId ?? null,
          documentId: body.sourceRef.documentId,
          documentVersion: body.sourceRef.version,
          chunkId: body.sourceRef.chunkId,
          allowed: false,
          reason: "NOT_FOUND",
        });
        app.metrics.observeKnowledgeEvidenceResolve({ result: "not_found", latencyMs: Date.now() - startedAt });
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Evidence 不存在或无权限", "en-US": "Evidence not found or not allowed" }, traceId: req.ctx.traceId });
      }

      const snippetRaw = String(r.snippet ?? "");
      const createdAtMs = log?.createdAt ? Date.parse(String(log.createdAt)) : NaN;
      const ageDays = Number.isFinite(createdAtMs) ? Math.floor(Math.max(0, Date.now() - createdAtMs) / (24 * 60 * 60 * 1000)) : 0;
      const snippetAllowed = Boolean(retention.allowSnippet) && (!body.retrievalLogId || ageDays <= retention.retentionDays);
      const maxSnippetLen = Math.min(body.maxSnippetLen ?? 600, retention.maxSnippetLen);
      const clipped = snippetAllowed ? snippetRaw.slice(0, maxSnippetLen) : "";
      const redacted = redactValue(clipped);
      const snippet = String(redacted.value ?? "");
      const digest8 = crypto.createHash("sha256").update(snippetRaw, "utf8").digest("hex").slice(0, 8);

      req.ctx.audit!.outputDigest = {
        sourceRef: body.sourceRef,
        snippetLen: snippetRaw.length,
        snippetDigest8: digest8,
        documentId: String(r.document_id),
        version: Number(r.document_version),
        chunkIndex: Number(r.chunk_index),
      };
      await insertEvidenceAccessEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        retrievalLogId: body.retrievalLogId ?? null,
        documentId: body.sourceRef.documentId,
        documentVersion: body.sourceRef.version,
        chunkId: body.sourceRef.chunkId,
        allowed: true,
        reason: snippetAllowed ? null : "snippet_blocked",
      });
      app.metrics.observeKnowledgeEvidenceResolve({ result: "ok", latencyMs: Date.now() - startedAt });
      return {
        evidence: {
          sourceRef: body.sourceRef,
          retrievalLogId: body.retrievalLogId ?? null,
          document: { title: String(r.document_title ?? ""), sourceType: String(r.document_source_type ?? "") },
          location: { chunkIndex: Number(r.chunk_index), startOffset: Number(r.start_offset), endOffset: Number(r.end_offset) },
          snippet,
          snippetDigest: { len: snippetRaw.length, sha256_8: digest8 },
          snippetAllowed,
          policyRef: { strategyRef: log?.strategyRef ?? null, rankPolicy: log?.rankPolicy ?? null, vectorStoreRef: log?.vectorStoreRef ?? null, retrievalLogId: body.retrievalLogId ?? null },
          accessScope: { tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId ?? null },
        },
      };
    } catch (e: any) {
      app.metrics.observeKnowledgeEvidenceResolve({ result: e?.errorCode ? (String(e.errorCode).includes("DENIED") || String(e.errorCode).includes("FORBIDDEN") ? "denied" : "error") : "error", latencyMs: Date.now() - startedAt });
      throw e;
    }
  });

  app.post("/knowledge/evidence/resolveBatch", async (req) => {
    const startedAt = Date.now();
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const retention = await getEvidenceRetentionPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId });
    const body = z
      .object({
        retrievalLogId: z.string().uuid().optional(),
        sourceRefs: z.array(z.object({ documentId: z.string().uuid(), version: z.number().int().positive(), chunkId: z.string().uuid() })).min(1).max(20),
        maxSnippetLen: z.number().int().positive().max(2000).optional(),
      })
      .parse(req.body);

    const out: any[] = [];
    const log = body.retrievalLogId ? await getRetrievalLog({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: body.retrievalLogId }) : null;
    if (body.retrievalLogId && !log) {
      for (const sourceRef of body.sourceRefs) {
        await insertEvidenceAccessEvent({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          subjectId: subject.subjectId,
          retrievalLogId: null,
          documentId: sourceRef.documentId,
          documentVersion: sourceRef.version,
          chunkId: sourceRef.chunkId,
          allowed: false,
          reason: "RETRIEVAL_LOG_NOT_FOUND",
        });
        out.push({ ok: false, status: 404, sourceRef });
      }
      app.metrics.observeKnowledgeEvidenceResolve({ result: "not_found", latencyMs: Date.now() - startedAt });
      return { results: out };
    }
    const createdAtMs = log?.createdAt ? Date.parse(String(log.createdAt)) : NaN;
    const ageDays = Number.isFinite(createdAtMs) ? Math.floor(Math.max(0, Date.now() - createdAtMs) / (24 * 60 * 60 * 1000)) : 0;
    const maxSnippetLen = Math.min(body.maxSnippetLen ?? 600, retention.maxSnippetLen);
    for (const sourceRef of body.sourceRefs) {
      if (body.retrievalLogId) {
        try {
          await assertEvidenceBelongsToRetrievalLog({ tenantId: subject.tenantId, spaceId: subject.spaceId, retrievalLogId: body.retrievalLogId, sourceRef, log });
        } catch {
          await insertEvidenceAccessEvent({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            retrievalLogId: body.retrievalLogId,
            documentId: sourceRef.documentId,
            documentVersion: sourceRef.version,
            chunkId: sourceRef.chunkId,
            allowed: false,
            reason: "NOT_ALLOWED",
          });
          out.push({ ok: false, status: 404, sourceRef });
          continue;
        }
      }
      const r = await resolveEvidenceRef({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        sourceRef,
      });
      if (!r) {
        await insertEvidenceAccessEvent({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          subjectId: subject.subjectId,
          retrievalLogId: body.retrievalLogId ?? null,
          documentId: sourceRef.documentId,
          documentVersion: sourceRef.version,
          chunkId: sourceRef.chunkId,
          allowed: false,
          reason: "NOT_FOUND",
        });
        out.push({ ok: false, status: 404, sourceRef });
        continue;
      }
      const snippetRaw = String(r.snippet ?? "");
      const snippetAllowed = Boolean(retention.allowSnippet) && (!body.retrievalLogId || ageDays <= retention.retentionDays);
      const clipped = snippetAllowed ? snippetRaw.slice(0, maxSnippetLen) : "";
      const redacted = redactValue(clipped);
      const snippet = String(redacted.value ?? "");
      const digest8 = crypto.createHash("sha256").update(snippetRaw, "utf8").digest("hex").slice(0, 8);
      await insertEvidenceAccessEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        retrievalLogId: body.retrievalLogId ?? null,
        documentId: sourceRef.documentId,
        documentVersion: sourceRef.version,
        chunkId: sourceRef.chunkId,
        allowed: true,
        reason: snippetAllowed ? null : "snippet_blocked",
      });
      out.push({
        ok: true,
        evidence: {
          sourceRef,
          retrievalLogId: body.retrievalLogId ?? null,
          document: { title: String(r.document_title ?? ""), sourceType: String(r.document_source_type ?? "") },
          location: { chunkIndex: Number(r.chunk_index), startOffset: Number(r.start_offset), endOffset: Number(r.end_offset) },
          snippet,
          snippetDigest: { len: snippetRaw.length, sha256_8: digest8 },
          snippetAllowed,
          policyRef: { strategyRef: log?.strategyRef ?? null, rankPolicy: log?.rankPolicy ?? null, vectorStoreRef: log?.vectorStoreRef ?? null, retrievalLogId: body.retrievalLogId ?? null },
          accessScope: { tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId ?? null },
        },
      });
    }

    req.ctx.audit!.outputDigest = { count: out.length, retrievalLogId: body.retrievalLogId ?? null };
    app.metrics.observeKnowledgeEvidenceResolve({ result: "ok", latencyMs: Date.now() - startedAt });
    return { items: out };
  });
};
