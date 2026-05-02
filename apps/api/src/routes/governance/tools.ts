import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "routes:governance:tools" });
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { sha256Hex } from "../../lib/digest";
import { getToolNetworkPolicy, listToolNetworkPolicies, upsertToolNetworkPolicy } from "../../modules/governance/toolNetworkPolicyRepo";
import { deriveToolVisibility, getToolVersionByRef, listToolDefinitions, listToolVersions } from "../../modules/tools/toolRepo";
import { resolveSupplyChainPolicy, checkTrust, checkDependencyScan, PERM } from "@mindpal/shared";
import { enableToolForScope, disableToolForScope, getActiveToolRef, listActiveToolRefs, listToolRollouts, setActiveToolRef } from "../../modules/governance/toolGovernanceRepo";
import { autoDiscoverAndRegisterTools, invalidateToolDiscoveryCache } from "../../modules/tools/toolAutoDiscovery";

async function refreshToolDiscovery(pool: any) {
  try {
    await autoDiscoverAndRegisterTools(pool);
  } catch (err) {
        _logger.error("on-demand tool discovery failed (non-fatal)", { err: (err as Error)?.message });
  }
}

const TOOL_DISCOVERY_REFRESH_INTERVAL_MS = 60_000;
let toolDiscoveryRefreshInFlight: Promise<void> | null = null;
let lastToolDiscoveryRefreshAt = 0;

function scheduleToolDiscoveryRefresh(pool: any) {
  const now = Date.now();
  if (toolDiscoveryRefreshInFlight) return;
  if (now - lastToolDiscoveryRefreshAt < TOOL_DISCOVERY_REFRESH_INTERVAL_MS) return;
  toolDiscoveryRefreshInFlight = refreshToolDiscovery(pool).finally(() => {
    lastToolDiscoveryRefreshAt = Date.now();
    toolDiscoveryRefreshInFlight = null;
  });
}

export const governanceToolsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/tools/network-policies", async (req) => {
    const q = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.network_policy.read" });
    const decision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_NETWORK_POLICY_READ });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = q.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const list = await listToolNetworkPolicies({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { scopeType, count: list.length };
    return { items: list };
  });

  app.get("/governance/tools/:toolRef/network-policy", async (req, reply) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const q = z.object({ scopeType: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.network_policy.read", toolRef: params.toolRef });
    const decision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_NETWORK_POLICY_READ });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = q.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const pol = await getToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, toolRef: params.toolRef });
    if (!pol) {
      req.ctx.audit!.outputDigest = { scopeType, scopeId, toolRef: params.toolRef, found: false };
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "策略不存在", "en-US": "Policy not found" }, traceId: req.ctx.traceId });
    }
    req.ctx.audit!.outputDigest = { scopeType, scopeId, toolRef: params.toolRef, allowedDomainsCount: pol.allowedDomains.length };
    return pol;
  });

  app.put("/governance/tools/:toolRef/network-policy", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
        allowedDomains: z.array(z.string().min(1)).max(500).optional(),
        rules: z
          .array(
            z.object({
              host: z.string().min(1).max(200),
              pathPrefix: z.string().min(1).max(500).optional(),
              methods: z.array(z.string().min(1).max(20)).max(20).optional(),
            }),
          )
          .max(500)
          .optional(),
      })
      .parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.network_policy.write", toolRef: params.toolRef });
    const decision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_NETWORK_POLICY_WRITE });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const canon = (body.allowedDomains ?? []).map((d) => d.trim()).filter(Boolean).sort();
    const digest = sha256Hex(canon.join("\n")).slice(0, 8);
    const rules = body.rules ?? [];
    const rulesDigest = sha256Hex(JSON.stringify(rules)).slice(0, 8);

    const oldPolicy = await getToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, toolRef: params.toolRef });
    const before = oldPolicy ? { allowedDomains: oldPolicy.allowedDomains, rules: oldPolicy.rules } : null;
    req.ctx.audit!.inputDigest = { scopeType, scopeId, toolRef: params.toolRef, allowedDomainsCount: canon.length, sha256_8: digest, rulesCount: rules.length, rulesSha256_8: rulesDigest, before };
    await upsertToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, toolRef: params.toolRef, allowedDomains: canon, rules });
    req.ctx.audit!.outputDigest = { ok: true };
    return { ok: true };
  });

  app.post("/governance/tools/:toolRef/enable", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const body = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.enable", toolRef: params.toolRef });
    const decision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_ENABLE });
    req.ctx.audit!.policyDecision = decision;

    // Auto-infer scope: prefer space if user has spaceId, otherwise fall back to tenant
    const scopeType = body.scope ?? (subject.spaceId ? "space" : "tenant");
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId，请指定操作范围 (Missing scopeId, please specify scope)");

    const { rollout, previousEnabled } = await enableToolForScope({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      toolRef: params.toolRef,
      subjectId: subject.subjectId,
      traceId: req.ctx.traceId,
      policyDecision: decision,
    });

    req.ctx.audit!.outputDigest = { scopeType, scopeId, toolRef: params.toolRef, enabled: rollout.enabled, previousEnabled };
    // Invalidate tool discovery cache so changes are immediately visible
    invalidateToolDiscoveryCache();
    return { rollout };
  });

  app.post("/governance/tools/:toolRef/disable", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const body = z.object({
      scope: z.enum(["tenant", "space"]).optional(),
      mode: z.enum(["immediate", "graceful"]).optional(),
      graceMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    }).parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.disable", toolRef: params.toolRef });
    const decision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_DISABLE });
    req.ctx.audit!.policyDecision = decision;

    // Auto-infer scope: prefer space if user has spaceId, otherwise fall back to tenant
    const scopeType = body.scope ?? (subject.spaceId ? "space" : "tenant");
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId，请指定操作范围 (Missing scopeId, please specify scope)");

    const { rollout, previousEnabled } = await disableToolForScope({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      toolRef: params.toolRef,
      subjectId: subject.subjectId,
      traceId: req.ctx.traceId,
      policyDecision: decision,
      disableMode: body.mode,
      graceMinutes: body.graceMinutes,
    });

    req.ctx.audit!.outputDigest = {
      scopeType, scopeId, toolRef: params.toolRef,
      enabled: rollout.enabled, previousEnabled,
      disableMode: rollout.disableMode,
      graceDeadline: rollout.graceDeadline,
    };
    // Invalidate tool discovery cache so changes are immediately visible
    invalidateToolDiscoveryCache();
    return { rollout };
  });

  app.post("/governance/tools/:name/active", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const body = z.object({ toolRef: z.string().min(3) }).parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.set_active", toolRef: body.toolRef });
    const decision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_SET_ACTIVE });
    req.ctx.audit!.policyDecision = decision;

    if (!body.toolRef.startsWith(`${params.name}@`)) throw Errors.badRequest("toolRef 与 name 不匹配");
    const ver = await getToolVersionByRef(app.db, subject.tenantId, body.toolRef);
    if (!ver || ver.status !== "released") throw Errors.badRequest("工具版本不存在或未发布");
    if (ver.artifactRef) {
      const policy = resolveSupplyChainPolicy();
      const t = checkTrust(policy, ver.trustSummary);
      const s = checkDependencyScan(policy, ver.scanSummary);
      if (!t.ok) throw Errors.trustNotVerified();
      if (!s.ok) throw Errors.scanNotPassed();
    }

    const active = await setActiveToolRef({ pool: app.db, tenantId: subject.tenantId, name: params.name, toolRef: body.toolRef });
    req.ctx.audit!.outputDigest = { name: params.name, activeToolRef: active.activeToolRef };
    return { active };
  });

  app.post("/governance/tools/:name/rollback", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.rollback" });
    const decision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_SET_ACTIVE });
    req.ctx.audit!.policyDecision = decision;

    const active = await getActiveToolRef({ pool: app.db, tenantId: subject.tenantId, name: params.name });
    if (!active) throw Errors.badRequest("当前未设置 activeToolRef");
    const idx = active.activeToolRef.lastIndexOf("@");
    const activeVersion = idx > 0 ? Number(active.activeToolRef.slice(idx + 1)) : NaN;
    if (!Number.isFinite(activeVersion) || activeVersion <= 0) throw Errors.badRequest("activeToolRef 格式错误");

    const versions = await listToolVersions(app.db, subject.tenantId, params.name);
    const prev = versions
      .filter((v) => v.status === "released" && v.version < activeVersion)
      .sort((a, b) => b.version - a.version)[0];
    if (!prev) throw Errors.badRequest("无可回滚的上一 released 版本");

    const next = await setActiveToolRef({ pool: app.db, tenantId: subject.tenantId, name: params.name, toolRef: prev.toolRef });
    req.ctx.audit!.outputDigest = { name: params.name, from: active.activeToolRef, to: next.activeToolRef };
    return { active: next };
  });

  app.post("/governance/tools/batch", async (req) => {
    const body = z.object({
      toolRefs: z.array(z.string().min(3)).min(1).max(100),
      action: z.enum(["enable", "disable"]),
      scope: z.enum(["tenant", "space"]).optional(),
    }).parse(req.body);
    const subject = req.ctx.subject!;

    const actionLabel = body.action === "enable" ? "tool.batch_enable" : "tool.batch_disable";
    setAuditContext(req, { resourceType: "governance", action: actionLabel });
    const decision = await requirePermission({
      req,
      ...(body.action === "enable" ? PERM.GOVERNANCE_TOOL_ENABLE : PERM.GOVERNANCE_TOOL_DISABLE),
    });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const results: Array<{ toolRef: string; ok: boolean; error?: string }> = [];
    const handler = body.action === "enable" ? enableToolForScope : disableToolForScope;

    for (const toolRef of body.toolRefs) {
      try {
        await handler({
          pool: app.db,
          tenantId: subject.tenantId,
          scopeType,
          scopeId,
          toolRef,
          subjectId: subject.subjectId,
          traceId: req.ctx.traceId,
          policyDecision: decision,
        });
        results.push({ toolRef, ok: true });
      } catch (err: any) {
        results.push({ toolRef, ok: false, error: err?.message ?? String(err) });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    req.ctx.audit!.outputDigest = { action: body.action, scopeType, total: body.toolRefs.length, succeeded, failed };
    return { results, summary: { total: body.toolRefs.length, succeeded, failed } };
  });

  app.get("/governance/tools/:toolRef/impact-analysis", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.impact_analysis", toolRef: params.toolRef });
    const decision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_READ });
    req.ctx.audit!.policyDecision = decision;

    const toolName = params.toolRef.split("@")[0] ?? params.toolRef;

    // 1. 查询当前使用该工具的活跃 runs/steps
    let activeRunCount = 0;
    let activeStepCount = 0;
    try {
      const runRes = await app.db.query<{ count: string }>(
        `SELECT COUNT(DISTINCT r.run_id) as count
         FROM runs r
         JOIN steps s ON r.run_id = s.run_id
         WHERE r.tenant_id = $1
           AND r.status IN ('created', 'running', 'queued')
           AND s.tool_ref LIKE $2`,
        [subject.tenantId, `${toolName}%`]
      );
      activeRunCount = parseInt(runRes.rows[0]?.count ?? "0", 10);

      const stepRes = await app.db.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM steps s
         JOIN runs r ON s.run_id = r.run_id
         WHERE r.tenant_id = $1
           AND s.status IN ('pending', 'running')
           AND s.tool_ref LIKE $2`,
        [subject.tenantId, `${toolName}%`]
      );
      activeStepCount = parseInt(stepRes.rows[0]?.count ?? "0", 10);
    } catch (err: any) {
          _logger.warn("impact-analysis active runs query failed", { err: err?.message });
    }

    // 2. 查询依赖该工具的 Skill 列表
    const dependentSkills: string[] = [];
    try {
      const allTools = await listToolDefinitions(app.db, subject.tenantId);
      // 通过 resourceType 关联：如果工具 A 的 preconditions 包含工具 B 的名称，则 A 依赖 B
      for (const td of allTools) {
        if (td.name === toolName) continue;
        const deps = Array.isArray(td.preconditions) ? td.preconditions : [];
        if (deps.some((d: string) => d === toolName || d.startsWith(`${toolName}.`))) {
          dependentSkills.push(td.name);
        }
      }
    } catch (err: any) {
          _logger.warn("impact-analysis dependentSkills query failed", { err: err?.message });
    }

    // 3. 生成风险摘要
    const riskFactors: string[] = [];
    if (activeRunCount > 0) riskFactors.push(`${activeRunCount} 个活跃任务正在使用此工具`);
    if (activeStepCount > 0) riskFactors.push(`${activeStepCount} 个执行步骤正在运行`);
    if (dependentSkills.length > 0) riskFactors.push(`${dependentSkills.length} 个其他工具/Skill 依赖此工具`);
    const riskLevel = activeRunCount > 0 ? "high" : dependentSkills.length > 0 ? "medium" : "low";

    const result = {
      toolRef: params.toolRef,
      toolName,
      activeRunCount,
      activeStepCount,
      dependentSkills,
      riskSummary: {
        riskLevel,
        riskFactors,
        recommendation: activeRunCount > 0
          ? "建议等待活跃任务完成后再停用，或使用优雅停用模式"
          : "可安全停用",
      },
    };

    req.ctx.audit!.outputDigest = { toolName, activeRunCount, dependentSkillsCount: dependentSkills.length, riskLevel };
    return result;
  });

  app.get("/governance/tools", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "tool.read" });
    const decision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_READ });
    req.ctx.audit!.policyDecision = decision;

    scheduleToolDiscoveryRefresh(app.db);

    const q = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const scopeType = q.scope;
    const scopeId = scopeType === "space" ? subject.spaceId : scopeType === "tenant" ? subject.tenantId : undefined;

    const [tools, rollouts, actives] = await Promise.all([
      listToolDefinitions(app.db, subject.tenantId),
      listToolRollouts({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId }),
      listActiveToolRefs({ pool: app.db, tenantId: subject.tenantId }),
    ]);
    const activeMap = new Map(actives.map((a) => [a.name, a.activeToolRef]));
    const toolsWithActive = tools.map((t) => ({
      ...t,
      visibility: deriveToolVisibility(t),
      activeToolRef: activeMap.get(t.name) ?? null,
    }));
    const visibilitySummary = toolsWithActive.reduce<Record<string, number>>((acc, tool) => {
      acc[tool.visibility] = (acc[tool.visibility] ?? 0) + 1;
      return acc;
    }, {});
    req.ctx.audit!.outputDigest = { tools: tools.length, rollouts: rollouts.length, actives: actives.length, visibilitySummary };
    return { tools: toolsWithActive, rollouts, actives, visibilitySummary };
  });
};
