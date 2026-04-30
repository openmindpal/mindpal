import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { getLatestReleasedToolVersion, getToolDefinition, getToolVersionByRef } from "../../modules/tools/toolRepo";
import { shouldRequireApproval } from "@openslin/shared/approvalDecision";
import { buildEffectiveEntitySchema } from "../../modules/metadata/effectiveSchema";
import { getEffectiveSchema, resolveSchemaNameForEntity } from "../../modules/metadata/schemaRepo";
import { pageDraftSchema, pageViewPrefsSchema } from "./modules/pageModel";
import { validateUiAgainstRegistry } from "./modules/componentRegistry";
import { deletePage, getDraft, getLatestReleased, listPages, upsertDraft } from "./modules/pageRepo";
import { getUserPageViewPrefs, resetUserPageViewPrefs, setUserPageViewPrefs } from "../../modules/memory/userPreferencesRepo";
import { getLatestReleasedUiComponentRegistry } from "../../modules/governance/uiComponentRegistryRepo";

/** DataBinding.target 白名单 —— 动态加载，带缓存，改配置即生效 */
const SEED_ALLOWED_TARGETS = ["entities.list", "entities.query", "entities.get", "schema.effective"];
let _allowedTargetsCache: { targets: Set<string>; ts: number } | null = null;

async function loadAllowedDataBindingTargets(pool: Pool, tenantId: string): Promise<Set<string>> {
  const now = Date.now();
  if (_allowedTargetsCache && now - _allowedTargetsCache.ts < 60_000) {
    return _allowedTargetsCache.targets;
  }
  try {
    const res = await pool.query(
      "SELECT config_value FROM runtime_config_overrides WHERE tenant_id = $1 AND config_key = 'ui.allowedDataBindingTargets'",
      [tenantId],
    );
    if (res.rowCount && res.rows[0]?.config_value) {
      const parsed = JSON.parse(res.rows[0].config_value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const targets = new Set(parsed.map((x: any) => String(x)));
        _allowedTargetsCache = { targets, ts: now };
        return targets;
      }
    }
  } catch { /* DB 查询失败时降级为种子默认值 */ }
  const targets = new Set(SEED_ALLOWED_TARGETS);
  _allowedTargetsCache = { targets, ts: now };
  return targets;
}

function resolveScope(subject: { tenantId: string; spaceId?: string | null }) {
  if (subject.spaceId) return { scopeType: "space" as const, scopeId: subject.spaceId };
  return { scopeType: "tenant" as const, scopeId: subject.tenantId };
}

function hrefForPage(pageType: string, params: any) {
  if (pageType === "entity.list") return `/entities/${encodeURIComponent(String(params?.entityName ?? ""))}`;
  if (pageType === "entity.new") return `/entities/${encodeURIComponent(String(params?.entityName ?? ""))}/new`;
  return "/";
}

function extractComponentIdsFromUi(ui: any): string[] {
  const u = ui && typeof ui === "object" ? ui : {};
  const blocks = Array.isArray((u as any).blocks) ? (u as any).blocks : [];
  const ids: string[] = blocks.map((b: any) => (typeof b?.componentId === "string" ? b.componentId : "")).filter((x: any) => typeof x === "string" && x.length > 0);
  return Array.from(new Set(ids));
}

export const uiRoutes: FastifyPluginAsync = async (app) => {
  // ⚠️ DEPRECATED: 以下 API 已废弃
  // 旧的 UI 配置管理功能已被移除，改为 AI 驱动的自然语言生成模式
  
  async function validateDraft(
    subject: { tenantId: string },
    scope: { scopeType: "tenant" | "space"; scopeId: string },
    draft: any,
  ) {
    const pageType = draft.pageType as string;
    if (!["entity.list", "entity.detail", "entity.new", "entity.edit"].includes(pageType)) throw Errors.uiConfigDenied("非法 pageType");

    const entityName = draft.params?.entityName as string | undefined;
    if (pageType.startsWith("entity.") && !entityName) {
      throw Errors.uiConfigDenied("缺少 params.entityName");
    }

    // DataBinding.target 白名单：从 runtime_config_overrides 动态加载，允许前端/治理配置扩展
    const allowedTargets = await loadAllowedDataBindingTargets(app.db, subject.tenantId);
    for (const b of draft.dataBindings ?? []) {
      if (!allowedTargets.has(b.target)) throw Errors.uiConfigDenied("非法 DataBinding.target");
    }

    for (const a of draft.actionBindings ?? []) {
      const ver = await getToolVersionByRef(app.db, subject.tenantId, a.toolRef);
      if (!ver || ver.status !== "released") throw Errors.uiConfigDenied("ActionBinding.toolRef 不存在或未发布");
      const rawToolRef = String(a.toolRef ?? "");
      const at = rawToolRef.lastIndexOf("@");
      const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
      const def = await getToolDefinition(app.db, subject.tenantId, toolName);
      if (!def) throw Errors.uiConfigDenied("ActionBinding.toolRef 不存在或未发布");
      const idempotencyRequired = Boolean(def.idempotencyRequired);
      const approvalRequired = shouldRequireApproval(def);
      if (idempotencyRequired && String(a.idempotencyKeyStrategy ?? "") !== "required") {
        throw Errors.uiConfigDenied("ActionBinding 缺少幂等键策略");
      }
      if (approvalRequired && String(a.approval ?? "") !== "required") {
        throw Errors.uiConfigDenied("ActionBinding 缺少审批声明");
      }
      if (approvalRequired) {
        const cm = a.confirmMessage;
        const hasZh = cm && typeof cm === "object" && String((cm as any)["zh-CN"] ?? "").trim().length > 0;
        const hasEn = cm && typeof cm === "object" && String((cm as any)["en-US"] ?? "").trim().length > 0;
        if (!hasZh && !hasEn) throw Errors.uiConfigDenied("高风险 ActionBinding 缺少 confirmMessage");
      }
    }

    if (draft.ui) {
      validateUiAgainstRegistry({ pageType, ui: draft.ui });
      const componentIds = extractComponentIdsFromUi(draft.ui);
      if (componentIds.length > 0) {
        const allowlist = await getLatestReleasedUiComponentRegistry(app.db, { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId });
        if (allowlist) {
          const allowed = new Set(allowlist.componentIds);
          for (const id of componentIds) {
            if (!allowed.has(id)) throw Errors.uiConfigDenied(`componentId 未被治理允许：${id}`);
          }
        }
      }
    }
  }

  app.post("/ui/page-templates/generate", async (req) => {
    setAuditContext(req, { resourceType: "ui_config", action: "generate" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z
      .object({
        schemaName: z.string().min(1).optional(),
        entityName: z.string().min(1),
        pageKinds: z.array(z.enum(["list", "detail", "new", "edit"])).optional(),
        overwriteStrategy: z.enum(["skip_existing", "overwrite_draft"]).optional(),
      })
      .parse(req.body);

    const pageKinds = body.pageKinds ?? ["list", "detail", "new", "edit"];
    const overwriteStrategy = body.overwriteStrategy ?? "skip_existing";

    await requirePermission({ req, resourceType: "schema", action: "read" });
    const entityDecision = await requirePermission({ req, resourceType: "entity", action: "read" });

    const resolvedSchemaName = await resolveSchemaNameForEntity({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      entityName: body.entityName,
      requestedSchemaName: body.schemaName ?? (req.headers["x-schema-name"] as string | undefined),
    });
    if (!resolvedSchemaName.ok) throw Errors.badRequest(resolvedSchemaName.reason);
    const schemaName = resolvedSchemaName.schemaName;
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: schemaName });
    if (!schema) throw Errors.badRequest("schema not found");
    const effective = buildEffectiveEntitySchema({ schema: schema.schema, entityName: body.entityName, decision: entityDecision });
    if (!effective) throw Errors.badRequest("entity not found in schema");

    const fieldKeys = Object.keys(effective.fields ?? {});
    const hasUpdatedAt = fieldKeys.includes("updatedAt");
    const preferred = ["title", "name", "status", "createdAt", "updatedAt"];
    const defaultSelect = Array.from(new Set([...preferred.filter((k) => fieldKeys.includes(k)), ...fieldKeys])).slice(0, 20);
    const writableFields = fieldKeys.filter((k) => {
      const access = (effective.fields as any)?.[k]?.extensions?.["io.openslin.access"];
      return access?.writable !== false;
    });

    const createTool = await getLatestReleasedToolVersion(app.db, subject.tenantId, "entity.create");
    if (!createTool) throw Errors.uiConfigDenied("缺少已发布工具 entity.create");
    const updateTool = await getLatestReleasedToolVersion(app.db, subject.tenantId, "entity.update");
    if (!updateTool) throw Errors.uiConfigDenied("缺少已发布工具 entity.update");

    const drafts: Array<{ name: string; draft: any }> = [];
    for (const k of pageKinds) {
      if (k === "list") {
        drafts.push({
          name: `${body.entityName}.list`,
          draft: {
            name: `${body.entityName}.list`,
            pageType: "entity.list",
            title: effective.displayName ?? body.entityName,
            params: { entityName: body.entityName },
            dataBindings: [
              {
                target: "entities.query",
                entityName: body.entityName,
                schemaName,
                query: {
                  limit: 50,
                  orderBy: hasUpdatedAt ? [{ field: "updatedAt", direction: "desc" }] : undefined,
                  select: defaultSelect,
                },
              },
              { target: "schema.effective", schemaName, entityName: body.entityName },
            ],
            ui: {
              layout: { variant: "table" },
              blocks: [{ slot: "content", componentId: "EntityList.Table", props: {} }],
              list: {
                columns: defaultSelect.slice(0, 8),
                filters: defaultSelect.slice(0, 6),
                sortOptions: hasUpdatedAt ? [{ field: "updatedAt", direction: "desc" }] : undefined,
                pageSize: 50,
              },
            },
            actionBindings: [],
          },
        });
      }
      if (k === "detail") {
        drafts.push({
          name: `${body.entityName}.detail`,
          draft: {
            name: `${body.entityName}.detail`,
            pageType: "entity.detail",
            title: effective.displayName ?? body.entityName,
            params: { entityName: body.entityName },
            dataBindings: [
              { target: "entities.get", entityName: body.entityName, idParam: "id" },
              { target: "schema.effective", schemaName, entityName: body.entityName },
            ],
            ui: {
              layout: { variant: "panel" },
              blocks: [{ slot: "content", componentId: "EntityDetail.Panel", props: {} }],
              detail: {
                fieldOrder: fieldKeys,
              },
            },
            actionBindings: [],
          },
        });
      }
      if (k === "new") {
        drafts.push({
          name: `${body.entityName}.new`,
          draft: {
            name: `${body.entityName}.new`,
            pageType: "entity.new",
            title: typeof effective.displayName === "string" ? `新建 ${effective.displayName}` : effective.displayName ?? body.entityName,
            params: { entityName: body.entityName },
            dataBindings: [{ target: "schema.effective", schemaName, entityName: body.entityName }],
            ui: {
              layout: { variant: "single" },
              blocks: [{ slot: "content", componentId: "EntityForm.Single", props: {} }],
              form: {
                fieldOrder: writableFields,
              },
            },
            actionBindings: [{ action: "create", toolRef: createTool.toolRef, idempotencyKeyStrategy: "required", approval: "required", confirmMessage: { "zh-CN": "确认提交该操作？", "en-US": "Confirm this action?" } }],
          },
        });
      }
      if (k === "edit") {
        drafts.push({
          name: `${body.entityName}.edit`,
          draft: {
            name: `${body.entityName}.edit`,
            pageType: "entity.edit",
            title: typeof effective.displayName === "string" ? `编辑 ${effective.displayName}` : effective.displayName ?? body.entityName,
            params: { entityName: body.entityName },
            dataBindings: [
              { target: "entities.get", entityName: body.entityName, idParam: "id" },
              { target: "schema.effective", schemaName, entityName: body.entityName },
            ],
            ui: {
              layout: { variant: "single" },
              blocks: [{ slot: "content", componentId: "EntityForm.Single", props: {} }],
              form: {
                fieldOrder: writableFields,
              },
            },
            actionBindings: [{ action: "update", toolRef: updateTool.toolRef, idempotencyKeyStrategy: "required", approval: "required", confirmMessage: { "zh-CN": "确认提交该操作？", "en-US": "Confirm this action?" } }],
          },
        });
      }
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const results: Array<{ name: string; outcome: "created" | "updated" | "skipped" }> = [];

    for (const item of drafts) {
      const key = { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId, name: item.name };
      const [existingDraft, existingReleased] = await Promise.all([getDraft(app.db, key), getLatestReleased(app.db, key)]);
      if (overwriteStrategy === "skip_existing" && (existingDraft || existingReleased)) {
        skipped++;
        results.push({ name: item.name, outcome: "skipped" });
        continue;
      }
      if (overwriteStrategy === "overwrite_draft" && existingDraft) updated++;
      else created++;

      await validateDraft(subject, scope, item.draft);
      await upsertDraft(app.db, key, item.draft);
      results.push({ name: item.name, outcome: existingDraft ? "updated" : "created" });
    }

    req.ctx.audit!.inputDigest = { schemaName, entityName: body.entityName, pageKinds, overwriteStrategy };
    req.ctx.audit!.outputDigest = { created, updated, skipped, toolRefs: [createTool.toolRef, updateTool.toolRef], names: results.map((r) => r.name) };

    return { scope, schemaName, entityName: body.entityName, overwriteStrategy, results, counts: { created, updated, skipped } };
  });

  app.get("/ui/pages", async (req) => {
    setAuditContext(req, { resourceType: "ui_config", action: "read" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const pages = await listPages(app.db, subject.tenantId, scope.scopeType, scope.scopeId);
    return { scope, pages };
  });

  app.get("/ui/pages/:name", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "ui_config", action: "read" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const key = { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId, name: params.name };
    const [draft, released] = await Promise.all([getDraft(app.db, key), getLatestReleased(app.db, key)]);
    return { scope, name: params.name, draft, released };
  });

  app.get("/ui/pages/:name/view-prefs", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "ui_config", action: "view_prefs.read" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const prefs = await getUserPageViewPrefs({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, spaceId: subject.spaceId ?? null, pageName: params.name });
    req.ctx.audit!.outputDigest = { hasPrefs: Boolean(prefs) };
    return { name: params.name, prefs };
  });

  app.put("/ui/pages/:name/view-prefs", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "ui_config", action: "view_prefs.write" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const body = z.object({ prefs: pageViewPrefsSchema }).parse(req.body);
    const saved = await setUserPageViewPrefs({
      pool: app.db,
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
      spaceId: subject.spaceId ?? null,
      pageName: params.name,
      prefs: body.prefs,
    });
    req.ctx.audit!.outputDigest = { saved: true };
    return { name: params.name, prefs: saved };
  });

  app.delete("/ui/pages/:name/view-prefs", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "ui_config", action: "view_prefs.reset" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const ok = await resetUserPageViewPrefs({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, spaceId: subject.spaceId ?? null, pageName: params.name });
    req.ctx.audit!.outputDigest = { reset: ok };
    return { ok };
  });

  app.put("/ui/pages/:name/draft", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "ui_config", action: "write" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const draft = pageDraftSchema.parse(req.body);
    await validateDraft(subject, scope, draft);
    const saved = await upsertDraft(app.db, { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId, name: params.name }, draft);
    return { scope, draft: saved };
  });

  app.post("/ui/pages/:name/publish", async (_req, reply) => {
    return reply.status(409).send({
      ok: false,
      error: "UI_PAGE_CHANGESET_REQUIRED",
      message: "直接发布已禁用，请使用 Changeset 工作流",
      requiredFlow: "changeset.release",
      supportedKind: "ui_page.publish",
    });
  });

  app.post("/ui/pages/:name/rollback", async (_req, reply) => {
    return reply.status(409).send({
      ok: false,
      error: "UI_PAGE_CHANGESET_REQUIRED",
      message: "直接回滚已禁用，请使用 Changeset 工作流",
      requiredFlow: "changeset.release",
      supportedKind: "ui_page.rollback",
    });
  });

  app.delete("/ui/pages/:name", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "ui_config", action: "delete" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const key = { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId, name: params.name };
    const ok = await deletePage(app.db, key);
    req.ctx.audit!.outputDigest = { name: params.name, deleted: ok };
    return { ok };
  });

  app.get("/ui/navigation", async (req) => {
    setAuditContext(req, { resourceType: "ui_config", action: "read" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const pages = await listPages(app.db, subject.tenantId, scope.scopeType, scope.scopeId);
    const items = pages
      .map((p) => p.latestReleased)
      .filter(Boolean)
      .map((v: any) => ({
        name: v.name,
        title: v.title,
        pageType: v.pageType,
        href: `/p/${encodeURIComponent(v.name)}`,
        target: hrefForPage(v.pageType, v.params),
      }));
    return { scope, items };
  });
};
