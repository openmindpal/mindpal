import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../modules/auth/guard";
import { PERM } from "@openslin/shared";
import { setAuditContext } from "../../modules/audit/context";
import { openManagedSse } from "../../lib/streamingPipeline";
import { resolveRequestDlpPolicyContext } from "../../lib/dlpPolicy";
import { finalizeAuditForStream } from "../../plugins/audit";
import { invokeModelChatUpstreamStream } from "./modules/invokeChatUpstreamStream";
import { listRoutingPolicies, upsertRoutingPolicy, disableRoutingPolicy, deleteRoutingPolicy } from "../../modules/modelGateway/routingPolicyRepo";

export const modelChatContentPartSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string().min(0),
  }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z.string().min(1),
      detail: z.enum(["auto", "low", "high"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("input_audio"),
    input_audio: z.object({
      data: z.string().min(1),
      format: z.enum(["wav", "mp3", "ogg", "webm", "flac"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("video_url"),
    video_url: z.object({
      url: z.string().min(1),
    }),
  }),
]);

export const modelChatMessageSchema = z.object({
  role: z.string().min(1),
  content: z.union([z.string().min(0), z.array(modelChatContentPartSchema).min(1)]),
});

export const modelChatBodySchema = z.object({
  purpose: z.string().min(1),
  stream: z.boolean().optional(),
  modelRef: z.string().min(3).optional(),
  constraints: z
    .object({
      candidates: z.array(z.string().min(3)).max(10).optional(),
    })
    .optional(),
  scene: z.string().min(1).max(100).optional(),
  outputSchema: z
    .object({
      fields: z.record(
        z.string().min(1),
        z.object({
          type: z.enum(["string", "number", "boolean", "json", "datetime"]),
          required: z.boolean().optional(),
        }),
      ),
    })
    .optional(),
  messages: z.array(modelChatMessageSchema).min(1),
  timeoutMs: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(32768).optional(),
});

export const modelChatRoutes: FastifyPluginAsync = async (app) => {
  function wantsEventStream(req: any, body: any) {
    return Boolean(body?.stream) || String((req.headers.accept as string | undefined) ?? "").toLowerCase().includes("text/event-stream");
  }

  async function handleChatStream(req: any, reply: any, body: any) {
    setAuditContext(req, { resourceType: "model", action: "invoke.stream" });
    const dlpContext = await resolveRequestDlpPolicyContext({
      db: app.db,
      subject: req.ctx.subject,
    });

    const sse = openManagedSse({
      req,
      reply,
      tenantId: req.ctx.subject!.tenantId,
      dlpContext,
      onClose: () => finalizeAuditForStream(app, { req, reply }),
    });

    let outputTextLen = 0;
    let usageFromStream: any = null;
    try {
      sse.sendEvent("status", { phase: "started" });
      const out = await invokeModelChatUpstreamStream({
        app,
        subject: req.ctx.subject!,
        body,
        locale: req.ctx.locale ?? "zh-CN",
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
        signal: sse.signal,
        onDelta: (t) => {
          outputTextLen += t.length;
          sse.sendEvent("delta", { text: t });
        },
        onUsage: (u) => {
          usageFromStream = u;
        },
      });

      req.ctx.audit!.inputDigest = { purpose: body.purpose, scene: out.scene, modelRef: body.modelRef ?? null, messageCount: body.messages.length, structuredOutputRequested: Boolean(body.outputSchema) };
      req.ctx.audit!.outputDigest = {
        routingDecision: out.routingDecision,
        usage:
          usageFromStream && typeof usageFromStream === "object"
            ? { promptTokens: (usageFromStream as any).prompt_tokens ?? null, completionTokens: (usageFromStream as any).completion_tokens ?? null, totalTokens: (usageFromStream as any).total_tokens ?? null }
            : out.usage && typeof out.usage === "object"
              ? { promptTokens: (out.usage as any).prompt_tokens ?? null, completionTokens: (out.usage as any).completion_tokens ?? null, totalTokens: (out.usage as any).total_tokens ?? null }
              : { tokens: null },
        latencyMs: out.latencyMs ?? null,
        outputTextLen,
        attempts: out.attempts,
        safetySummary: out.safetySummary,
      };

      sse.sendEvent("done", {
        outputTextLen,
        routingDecision: out.routingDecision,
        usage: usageFromStream ?? out.usage ?? { tokens: null },
        latencyMs: out.latencyMs ?? null,
        traceId: req.ctx.traceId,
      });
    } catch (err: any) {
      const code = err?.errorCode ?? "INTERNAL_ERROR";
      const msg = err?.messageI18n ?? err?.message ?? "Unknown error";
      const retryAfterSec = Number(err?.retryAfterSec);
      const details = err && typeof err === "object" && "details" in err ? (err as any).details : undefined;
      if (err && typeof err === "object" && (err as any).audit) {
        const a = (err as any).audit;
        if (a?.errorCategory) req.ctx.audit!.errorCategory = String(a.errorCategory);
        if (a?.outputDigest) req.ctx.audit!.outputDigest = a.outputDigest;
      } else {
        req.ctx.audit!.errorCategory = "internal";
        req.ctx.audit!.outputDigest = { errorCode: code };
      }
      sse.sendEvent("error", { errorCode: code, message: msg, traceId: req.ctx.traceId, ...(details ? { details } : {}), ...(Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? { retryAfterSec } : {}) });
    } finally {
      sse.close();
    }
  }

  app.post("/models/chat", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "invoke" });
    const decision = await requirePermission({ req, ...PERM.MODEL_INVOKE });
    req.ctx.audit!.policyDecision = decision;

    const body = modelChatBodySchema.parse(req.body);

    if (wantsEventStream(req, body)) {
      await handleChatStream(req, reply, {
        purpose: body.purpose,
        modelRef: body.modelRef,
        constraints: body.constraints,
        scene: body.scene,
        outputSchema: body.outputSchema,
        messages: body.messages,
        timeoutMs: body.timeoutMs,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        stream: true,
      });
      return;
    }

    let out: any;
    try {
      out = await invokeModelChatUpstreamStream({
        app,
        subject: req.ctx.subject!,
        body: {
          purpose: body.purpose,
          modelRef: body.modelRef,
          constraints: body.constraints,
          scene: body.scene,
          outputSchema: body.outputSchema,
          messages: body.messages,
          timeoutMs: body.timeoutMs,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
        },
        locale: req.ctx.locale ?? "zh-CN",
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
        onDelta: () => {
        },
      });
    } catch (err: any) {
      if (err && typeof err === "object" && (err as any).audit) {
        const a = (err as any).audit;
        if (a?.errorCategory) req.ctx.audit!.errorCategory = String(a.errorCategory);
        if (a?.outputDigest) req.ctx.audit!.outputDigest = a.outputDigest;
      }
      const details = err && typeof err === "object" && "details" in err ? (err as any).details : undefined;
      if (err?.errorCode === "OUTPUT_SCHEMA_VALIDATION_FAILED") {
        return reply.status(422).send({
          errorCode: "OUTPUT_SCHEMA_VALIDATION_FAILED",
          message: { "zh-CN": "模型输出不满足 outputSchema", "en-US": "Model output does not satisfy outputSchema" },
          details: details ?? null,
          traceId: req.ctx.traceId,
        });
      }
      throw err;
    }

    req.ctx.audit!.inputDigest = { purpose: body.purpose, scene: out.scene, modelRef: body.modelRef ?? null, messageCount: body.messages.length, structuredOutputRequested: Boolean(body.outputSchema) };
    req.ctx.audit!.outputDigest = {
      routingDecision: out.routingDecision,
      usage:
        out.usage && typeof out.usage === "object"
          ? { promptTokens: (out.usage as any).prompt_tokens ?? null, completionTokens: (out.usage as any).completion_tokens ?? null, totalTokens: (out.usage as any).total_tokens ?? null }
          : { tokens: null },
      latencyMs: out.latencyMs ?? null,
      outputTextLen: typeof out.outputText === "string" ? out.outputText.length : null,
      attempts: out.attempts ?? null,
      safetySummary: out.safetySummary ?? null,
    };

    return {
      outputText: out.outputText,
      output: out.output ?? null,
      routingDecision: out.routingDecision,
      usage: out.usage ?? { tokens: null },
      latencyMs: out.latencyMs ?? null,
      traceId: req.ctx.traceId,
    };
  });

  app.post("/models/chat/stream", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "invoke.stream" });
    const decision = await requirePermission({ req, ...PERM.MODEL_INVOKE });
    req.ctx.audit!.policyDecision = decision;
    const body = modelChatBodySchema.parse(req.body);
    await handleChatStream(req, reply, {
      purpose: body.purpose,
      modelRef: body.modelRef,
      constraints: body.constraints,
      scene: body.scene,
      outputSchema: body.outputSchema,
      messages: body.messages,
      timeoutMs: body.timeoutMs,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      stream: true,
    });
  });

  // ─── Routing Policy Management APIs ─────────────────────────────────────

  app.get("/governance/model-gateway/routing", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "list_routing_policies" });
    const tenantId = req.ctx.subject!.tenantId;
    const policies = await listRoutingPolicies({ pool: app.db, tenantId, limit: 200 });
    return { policies };
  });

  const upsertSchema = z.object({
    primaryModelRef: z.string().min(1),
    fallbackModelRefs: z.array(z.string().min(1)).max(10).optional(),
    enabled: z.boolean().default(true),
  });

  app.put("/governance/model-gateway/routing/:purpose", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "upsert_routing_policy" });
    const tenantId = req.ctx.subject!.tenantId;
    const purpose = (req.params as any).purpose as string;
    if (!purpose || purpose.trim().length === 0) {
      return reply.status(400).send({ errorCode: "INVALID_PURPOSE", message: { "zh-CN": "用途不能为空", "en-US": "Purpose is required" } });
    }
    const payload = upsertSchema.parse(req.body);
    const policy = await upsertRoutingPolicy({
      pool: app.db,
      tenantId,
      purpose: purpose.trim(),
      primaryModelRef: payload.primaryModelRef,
      fallbackModelRefs: payload.fallbackModelRefs ?? [],
      enabled: payload.enabled,
    });
    return policy;
  });

  app.post("/governance/model-gateway/routing/:purpose/disable", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "disable_routing_policy" });
    const tenantId = req.ctx.subject!.tenantId;
    const purpose = (req.params as any).purpose as string;
    await disableRoutingPolicy({ pool: app.db, tenantId, purpose });
    return { success: true };
  });

  app.delete("/governance/model-gateway/routing/:purpose", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "delete_routing_policy" });
    const tenantId = req.ctx.subject!.tenantId;
    const purpose = (req.params as any).purpose as string;
    await deleteRoutingPolicy({ pool: app.db, tenantId, purpose });
    return { success: true };
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
  // NOTE: GET /governance/knowledge/retrieval-strategies is registered in routes/governance/knowledge.ts

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
    try {
      const res = await app.db.query(
        "SELECT * FROM knowledge_evidence_retention_policies WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 100",
        [tenantId],
      );
      const policies = (res.rows as any[]).map((r) => ({
        tenantId: r.tenant_id, spaceId: r.space_id,
        allowSnippet: Boolean(r.allow_snippet),
        retentionDays: Number(r.retention_days ?? 30),
        maxSnippetLen: Number(r.max_snippet_len ?? 600),
        updatedAt: r.updated_at,
      }));
      return { policies };
    } catch { return { policies: [] }; }
  });

  const retentionPolicySchema = z.object({
    spaceId: z.string().min(1),
    allowSnippet: z.boolean().default(true),
    retentionDays: z.number().min(1).max(3650).default(30),
    maxSnippetLen: z.number().min(50).max(5000).default(600),
  });

  app.put("/governance/knowledge/retention-policy", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "upsert_retention_policy" });
    const tenantId = req.ctx.subject!.tenantId;
    const body = retentionPolicySchema.parse(req.body);
    const res = await app.db.query(
      `INSERT INTO knowledge_evidence_retention_policies (
        tenant_id, space_id, allow_snippet, retention_days, max_snippet_len, updated_at
      ) VALUES ($1,$2,$3,$4,$5,now())
      ON CONFLICT (tenant_id, space_id) DO UPDATE SET
        allow_snippet=EXCLUDED.allow_snippet, retention_days=EXCLUDED.retention_days,
        max_snippet_len=EXCLUDED.max_snippet_len, updated_at=now()
      RETURNING *`,
      [tenantId, body.spaceId, body.allowSnippet, body.retentionDays, body.maxSnippetLen],
    );
    const r = res.rows[0] as any;
    return { spaceId: r.space_id, allowSnippet: Boolean(r.allow_snippet), retentionDays: Number(r.retention_days), updatedAt: r.updated_at };
  });

  app.delete("/governance/knowledge/retention-policy/:spaceId", async (req, reply) => {
    setAuditContext(req, { resourceType: "knowledge", action: "delete_retention_policy" });
    const tenantId = req.ctx.subject!.tenantId;
    const spaceId = (req.params as any).spaceId as string;
    await app.db.query("DELETE FROM knowledge_evidence_retention_policies WHERE tenant_id = $1 AND space_id = $2", [tenantId, spaceId]);
    return { success: true };
  });
};
