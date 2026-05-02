import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../modules/auth/guard";
import { PERM } from "@mindpal/shared";
import { setAuditContext } from "../../modules/audit/context";
import { modelCatalog, openaiCompatibleProviders } from "./modules/catalog";
import {
  listModelCatalogFromDb,
  findCatalogByRefFromDb,
  upsertModelCatalog,
  updateModelStatus,
  type ModelStatus,
} from "../../modules/modelGateway/catalog";

export const modelCatalogRoutes: FastifyPluginAsync = async (app) => {
  // ── 原有端点：静态目录 + 模板 ───────────────────────────
  app.get("/models/catalog", async (req) => {
    setAuditContext(req, { resourceType: "model", action: "read" });
    const decision = await requirePermission({ req, ...PERM.MODEL_READ });
    req.ctx.audit!.policyDecision = decision;
    const tenantId = req.ctx.subject!.tenantId;
    const openaiCompatibleProvidersOut = [...openaiCompatibleProviders];

    // P2-模型: 优先返回 DB 模型目录，静态目录作为补充
    let dbCatalog: any[] = [];
    try {
      dbCatalog = await listModelCatalogFromDb({ pool: app.db, tenantId });
    } catch { /* DB 查询失败时回退静态目录 */ }

    return {
      catalog: dbCatalog.length > 0 ? dbCatalog : modelCatalog,
      dbCatalogCount: dbCatalog.length,
      templates: {
        openaiCompatible: {
          providers: openaiCompatibleProvidersOut,
          modelRefPattern: "{provider}:{modelName}",
          baseUrlRules: {
            normalize: "trim; ensure http/https; strip trailing /v1; strip query/hash; strip trailing slashes",
            endpointHost: "hostname(baseUrl) must be in allowedDomains",
          },
        },
      },
    };
  });

  // ── P2-模型: DB 模型目录 CRUD ─────────────────────────────

  /** GET /models/catalog/db — 查询 DB 模型目录（支持按状态过滤） */
  app.get("/models/catalog/db", async (req) => {
    setAuditContext(req, { resourceType: "model", action: "read" });
    await requirePermission({ req, ...PERM.MODEL_READ });
    const tenantId = req.ctx.subject!.tenantId;
    const query = req.query as Record<string, string>;
    const status = ["active", "degraded", "unavailable", "probing"].includes(query.status ?? "")
      ? (query.status as ModelStatus)
      : undefined;
    const entries = await listModelCatalogFromDb({ pool: app.db, tenantId, status });
    return { entries, count: entries.length };
  });

  /** GET /models/catalog/db/:modelRef — 查询单个模型详情 */
  app.get("/models/catalog/db/:modelRef", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "read" });
    await requirePermission({ req, ...PERM.MODEL_READ });
    const tenantId = req.ctx.subject!.tenantId;
    const modelRef = decodeURIComponent((req.params as any).modelRef as string);
    const entry = await findCatalogByRefFromDb({ pool: app.db, tenantId, modelRef });
    if (!entry) return reply.status(404).send({ errorCode: "MODEL_NOT_FOUND", message: { "zh-CN": "模型未找到", "en-US": "Model not found" } });
    return { entry };
  });

  const upsertModelSchema = z.object({
    modelRef: z.string().min(3),
    provider: z.string().min(1),
    modelName: z.string().min(1),
    displayName: z.string().optional(),
    capabilities: z.object({
      supportedModalities: z.array(z.string()).optional(),
      contextWindow: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      reasoningDepth: z.enum(["low", "medium", "high"]).optional(),
      toolCallAbility: z.enum(["none", "basic", "native", "advanced"]).optional(),
      structuredOutputAbility: z.enum(["none", "json", "json_schema"]).optional(),
      streamingSupport: z.boolean().optional(),
      visionSupport: z.boolean().optional(),
      codeGenQuality: z.enum(["none", "low", "medium", "high"]).optional(),
      multilingualSupport: z.array(z.string()).optional(),
    }).optional(),
    performanceStats: z.object({
      latencyP50Ms: z.number().optional(),
      latencyP95Ms: z.number().optional(),
      latencyP99Ms: z.number().optional(),
      successRate: z.number().min(0).max(1).optional(),
      avgOutputTokensPerSec: z.number().optional(),
      costPer1kInputTokens: z.number().optional(),
      costPer1kOutputTokens: z.number().optional(),
    }).optional(),
    endpointHost: z.string().optional(),
    status: z.enum(["active", "degraded", "unavailable", "probing"]).optional(),
  });

  /** PUT /models/catalog/db — 注册或更新模型能力画像 */
  app.put("/models/catalog/db", async (req) => {
    setAuditContext(req, { resourceType: "model", action: "write" });
    await requirePermission({ req, ...PERM.MODEL_WRITE });
    const tenantId = req.ctx.subject!.tenantId;
    const body = upsertModelSchema.parse(req.body);
    const entry = await upsertModelCatalog({
      pool: app.db,
      tenantId,
      modelRef: body.modelRef,
      provider: body.provider,
      modelName: body.modelName,
      displayName: body.displayName,
      capabilities: body.capabilities,
      performanceStats: body.performanceStats as any,
      endpointHost: body.endpointHost,
      status: body.status,
    });
    return { entry };
  });

  const statusUpdateSchema = z.object({
    status: z.enum(["active", "degraded", "unavailable", "probing"]),
    degradationScore: z.number().min(0).max(1).optional(),
  });

  /** PATCH /models/catalog/db/:modelRef/status — 更新模型状态 */
  app.patch("/models/catalog/db/:modelRef/status", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "write" });
    await requirePermission({ req, ...PERM.MODEL_WRITE });
    const tenantId = req.ctx.subject!.tenantId;
    const modelRef = decodeURIComponent((req.params as any).modelRef as string);
    const body = statusUpdateSchema.parse(req.body);
    await updateModelStatus({
      pool: app.db,
      tenantId,
      modelRef,
      status: body.status,
      degradationScore: body.degradationScore,
    });
    return { success: true, modelRef, status: body.status };
  });

  /** DELETE /models/catalog/db/:modelRef — 删除模型注册 */
  app.delete("/models/catalog/db/:modelRef", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "write" });
    await requirePermission({ req, ...PERM.MODEL_WRITE });
    const tenantId = req.ctx.subject!.tenantId;
    const modelRef = decodeURIComponent((req.params as any).modelRef as string);
    const res = await app.db.query(
      `DELETE FROM model_catalog WHERE tenant_id = $1 AND model_ref = $2 RETURNING id`,
      [tenantId, modelRef],
    );
    if (!res.rowCount) return reply.status(404).send({ errorCode: "MODEL_NOT_FOUND", message: { "zh-CN": "模型未找到", "en-US": "Model not found" } });
    return { success: true, deleted: modelRef };
  });
};
