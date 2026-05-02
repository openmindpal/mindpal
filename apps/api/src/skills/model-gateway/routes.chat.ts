import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { isAppError } from "../../lib/errors";
import { requirePermission } from "../../modules/auth/guard";
import { PERM } from "@mindpal/shared";
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
            ? { promptTokens: (usageFromStream as Record<string, unknown>).prompt_tokens ?? null, completionTokens: (usageFromStream as Record<string, unknown>).completion_tokens ?? null, totalTokens: (usageFromStream as Record<string, unknown>).total_tokens ?? null }
            : out.usage && typeof out.usage === "object"
              ? { promptTokens: (out.usage as Record<string, unknown>).prompt_tokens ?? null, completionTokens: (out.usage as Record<string, unknown>).completion_tokens ?? null, totalTokens: (out.usage as Record<string, unknown>).total_tokens ?? null }
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
    } catch (err: unknown) {
      const appErr = isAppError(err) ? err : null;
      const code = appErr?.errorCode ?? "INTERNAL_ERROR";
      const msg = appErr?.messageI18n ?? (err instanceof Error ? err.message : "Unknown error");
      const retryAfterSec = Number(appErr?.retryAfterSec);
      const details = appErr?.details;
      if (appErr?.audit) {
        const a = appErr.audit;
        if (a.errorCategory) req.ctx.audit!.errorCategory = String(a.errorCategory);
        if (a.outputDigest) req.ctx.audit!.outputDigest = a.outputDigest;
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
    } catch (err: unknown) {
      const appErr2 = isAppError(err) ? err : null;
      if (appErr2?.audit) {
        const a = appErr2.audit;
        if (a.errorCategory) req.ctx.audit!.errorCategory = String(a.errorCategory);
        if (a.outputDigest) req.ctx.audit!.outputDigest = a.outputDigest;
      }
      const details = appErr2?.details;
      if (appErr2?.errorCode === "OUTPUT_SCHEMA_VALIDATION_FAILED") {
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
          ? { promptTokens: (out.usage as Record<string, unknown>).prompt_tokens ?? null, completionTokens: (out.usage as Record<string, unknown>).completion_tokens ?? null, totalTokens: (out.usage as Record<string, unknown>).total_tokens ?? null }
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

};
