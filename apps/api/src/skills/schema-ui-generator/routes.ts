/**
 * Schema-UI Generator — HTTP 路由
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { schemaUiRequestSchema, schemaUiSavePageSchema } from "./modules/types";
import { generateSchemaUi } from "./modules/generator";
import { upsertDraft } from "../ui-page-config/modules/pageRepo";

export const schemaUiRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /schema-ui/generate — 核心生成端点
   * 接收自然语言输入，返回 SchemaUiConfig
   */
  app.post("/schema-ui/generate", async (req) => {
    setAuditContext(req, { resourceType: "schema_ui", action: "generate" });
    const decision = await requirePermission({ req, resourceType: "schema", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const body = schemaUiRequestSchema.parse(req.body);
    const subject = req.ctx.subject!;

    const config = await generateSchemaUi({
      userInput: body.userInput,
      tenantId: body.tenantId || subject.tenantId,
      userId: body.userId ?? subject.subjectId,
      modelRef: body.modelRef,
      app,
    });

    if (!config) {
      return {
        ok: false,
        intent: "chat",
        message: "置信度不足，降级到对话模式",
      };
    }

    req.ctx.audit!.outputDigest = {
      intent: config.intent,
      confidence: config.confidence,
      layout: config.uiHints?.layout,
    };

    return { ok: true, config };
  });

  /**
   * POST /schema-ui/save-page — 保存为页面配置
   * 将 Schema-UI 生成结果持久化为页面草稿
   */
  app.post("/schema-ui/save-page", async (req) => {
    setAuditContext(req, { resourceType: "schema_ui", action: "save_page" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const body = schemaUiSavePageSchema.parse(req.body);
    const subject = req.ctx.subject!;

    const scope = subject.spaceId
      ? { scopeType: "space" as const, scopeId: subject.spaceId }
      : { scopeType: "tenant" as const, scopeId: subject.tenantId };

    const key = {
      tenantId: subject.tenantId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      name: body.name,
    };

    // 从 config 构建简化的页面草稿
    const draft = {
      name: body.name,
      pageType: "entity.list" as const,
      title: (body.config as any)?.uiHints?.title ?? body.name,
      params: {},
      dataBindings: Array.isArray((body.config as any)?.dataBindings)
        ? (body.config as any).dataBindings.map((b: any) => ({
            target: "entities.query",
            entityName: b.entity ?? "",
          }))
        : [],
      ui: body.config,
      actionBindings: [],
    };

    const saved = await upsertDraft((app as any).db, key, draft as any);
    req.ctx.audit!.outputDigest = { name: body.name, saved: true };

    return { ok: true, scope, draft: saved };
  });
};
