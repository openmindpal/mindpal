import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission } from "../modules/auth/guard";
import { authorize } from "../modules/auth/authz";
import { getPolicySnapshot, listPolicySnapshots } from "../modules/auth/policySnapshotRepo";
import { bumpPolicyCacheEpoch, getPolicyCacheEpoch } from "../modules/auth/policyCacheEpochRepo";
import { createDraftPolicyVersion, getPolicyVersion, listPolicyVersions, setPolicyVersionStatus } from "../modules/auth/policyVersionRepo";
import { addChangeSetItem, approveChangeSet, createChangeSet, getChangeSet, listChangeSetItems, listChangeSets, preflightChangeSet, promoteChangeSet, releaseChangeSet, rollbackChangeSet, submitChangeSet } from "../modules/governance/changeSetRepo";
import { createEvalRun, createEvalSuite, getEvalRun, getEvalSuite, listChangeSetEvalBindings, listEvalRuns, listEvalSuites, replaceChangeSetEvalBindings, setEvalRunFinished, updateEvalSuite } from "../modules/governance/evalRepo";
import { computeEvalSummary } from "../modules/governance/evalLogic";
import { getQuotaLimit, getToolLimit, listToolLimits, upsertQuotaLimit, upsertToolLimit } from "../modules/governance/limitsRepo";
import { getArtifactPolicy, upsertArtifactPolicy } from "../modules/governance/artifactPolicyRepo";
import { getToolNetworkPolicy, listToolNetworkPolicies, upsertToolNetworkPolicy } from "../modules/governance/toolNetworkPolicyRepo";
import { createSkillRuntimeRunner, listSkillRuntimeRunners, listSkillTrustedKeys, rotateSkillTrustedKey, setSkillRuntimeRunnerEnabled, upsertSkillTrustedKey } from "../modules/governance/skillRuntimeRepo";
import { getObservabilitySummary } from "../modules/governance/observabilityRepo";
import { getToolVersionByRef, listToolVersions } from "../modules/tools/toolRepo";
import { toolScanOk, toolTrustOk } from "../modules/tools/supplyGate";
import { getActiveToolRef, listActiveToolRefs, listToolRollouts, setActiveToolRef, setToolRollout } from "../modules/governance/toolGovernanceRepo";
import { getLatestReleasedUiComponentRegistry, getUiComponentRegistryDraft, publishUiComponentRegistryFromDraft, rollbackUiComponentRegistryToPreviousReleased, upsertUiComponentRegistryDraft } from "../modules/governance/uiComponentRegistryRepo";
import { listUiComponentRegistryComponentIds } from "../modules/uiConfig/componentRegistry";
import { disableRoutingPolicy, getRoutingPolicy, listRoutingPolicies, upsertRoutingPolicy } from "../modules/modelGateway/routingPolicyRepo";
import { getEffectiveModelBudget, listModelBudgets, upsertModelBudget } from "../modules/modelGateway/budgetRepo";
import { getTokenBudgetUsed, tokenBudgetKey } from "../modules/modelGateway/budget";
import { queryModelUsageAgg } from "../modules/modelGateway/usageRepo";
import { sha256Hex } from "../modules/notifications/digest";
import { stableStringify } from "../modules/channels/ingressDigest";
import { schemaDefSchema } from "../modules/metadata/schemaModel";
import { createSchemaMigration, createSchemaMigrationRun, getSchemaMigrationRun, listSchemaMigrations, setSchemaMigrationRunCanceled, setSchemaMigrationStatus } from "../modules/metadata/schemaMigrationRepo";
import { createJobRunStepWithoutToolRef } from "../modules/workflow/jobRepo";
import { getEmbeddingJob, getIngestJob, getIndexJob, getRetrievalLog, listEmbeddingJobs, listIngestJobs, listIndexJobs, listRetrievalLogs, searchChunksHybrid } from "../modules/knowledge/repo";
import { createRetrievalEvalRun, createRetrievalEvalSet, getRetrievalEvalRun, getRetrievalEvalSet, listRetrievalEvalRuns, listRetrievalEvalSets, setRetrievalEvalRunFinished } from "../modules/knowledge/qualityRepo";
import { getCollabRun } from "../modules/agentRuntime/collabRepo";
import { SUPPORTED_SCHEMA_MIGRATION_KINDS, validatePolicyExpr } from "@openslin/shared";

export const governanceRoutes: FastifyPluginAsync = async (app) => {
  function resolveScope(subject: { tenantId: string; spaceId?: string | null }, scopeType: "tenant" | "space") {
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");
    return { scopeType, scopeId };
  }

  function validateUiComponentRegistryComponentIds(componentIds: string[]) {
    const allowed = new Set(listUiComponentRegistryComponentIds());
    for (const id of componentIds) {
      if (!allowed.has(id)) throw Errors.uiComponentRegistryDenied(`非法 componentId：${id}`);
    }
  }

  app.get("/governance/ui/component-registry", async (req) => {
    const subject = req.ctx.subject!;
    const q = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.query ?? {});
    const scope = resolveScope(subject, q.scope ?? "space");

    setAuditContext(req, { resourceType: "governance", action: "ui.component_registry.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "ui.component_registry.read" });

    const key = { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId } as const;
    const [latestReleased, draft] = await Promise.all([getLatestReleasedUiComponentRegistry(app.db, key), getUiComponentRegistryDraft(app.db, key)]);

    req.ctx.audit!.inputDigest = { scopeType: scope.scopeType, scopeId: scope.scopeId };
    req.ctx.audit!.outputDigest = { hasReleased: Boolean(latestReleased), hasDraft: Boolean(draft) };
    return { scope, latestReleased, draft };
  });

  app.put("/governance/ui/component-registry/draft", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        scope: z.enum(["tenant", "space"]).optional(),
        componentIds: z.array(z.string().min(1).max(200)).max(2000),
      })
      .parse(req.body);
    const scope = resolveScope(subject, body.scope ?? "space");

    setAuditContext(req, { resourceType: "governance", action: "ui.component_registry.write" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "ui.component_registry.write" });

    validateUiComponentRegistryComponentIds(body.componentIds);

    const draft = await upsertUiComponentRegistryDraft({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      componentIds: body.componentIds,
      createdBySubjectId: subject.subjectId,
    });
    req.ctx.audit!.inputDigest = { scopeType: scope.scopeType, scopeId: scope.scopeId, componentIdsCount: body.componentIds.length };
    req.ctx.audit!.outputDigest = { version: draft.version, status: draft.status, componentIdsCount: draft.componentIds.length };
    return { scope, draft };
  });

  app.post("/governance/ui/component-registry/publish", async (req) => {
    const subject = req.ctx.subject!;
    const body = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.body ?? {});
    const scope = resolveScope(subject, body.scope ?? "space");

    setAuditContext(req, { resourceType: "governance", action: "ui.component_registry.publish" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "ui.component_registry.publish" });

    const key = { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId } as const;
    const draft = await getUiComponentRegistryDraft(app.db, key);
    if (!draft) throw Errors.uiComponentRegistryDraftMissing();
    validateUiComponentRegistryComponentIds(draft.componentIds);
    const released = await publishUiComponentRegistryFromDraft({ pool: app.db, key, createdBySubjectId: subject.subjectId, draft });
    if (!released) throw Errors.uiComponentRegistryDraftMissing();
    req.ctx.audit!.outputDigest = { version: released.version, status: released.status, componentIdsCount: released.componentIds.length };
    return { scope, released };
  });

  app.post("/governance/ui/component-registry/rollback", async (req) => {
    const subject = req.ctx.subject!;
    const body = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.body ?? {});
    const scope = resolveScope(subject, body.scope ?? "space");

    setAuditContext(req, { resourceType: "governance", action: "ui.component_registry.rollback" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "ui.component_registry.rollback" });

    const key = { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId } as const;
    const released = await rollbackUiComponentRegistryToPreviousReleased({ pool: app.db, key, createdBySubjectId: subject.subjectId });
    if (!released) throw Errors.uiComponentRegistryNoPreviousVersion();
    req.ctx.audit!.outputDigest = { version: released.version, status: released.status, componentIdsCount: released.componentIds.length };
    return { scope, released };
  });

  app.post("/governance/schemas/:name/set-active", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        version: z.number().int().positive(),
        scopeType: z.enum(["tenant", "space"]).optional(),
      })
      .parse(req.body ?? {});
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "schema.set_active" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "schema.set_active" });
    const scopeType = body.scopeType ?? "tenant";
    req.ctx.audit!.inputDigest = { name: params.name, version: body.version, scopeType, requestedBy: subject.subjectId };
    req.ctx.audit!.outputDigest = { ok: false, requiredFlow: "changeset.release", supportedKind: "schema.set_active" };
    throw Errors.schemaChangesetRequired("set_active");
  });

  app.post("/governance/schemas/:name/rollback", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
      })
      .parse(req.body ?? {});
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "schema.rollback" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "schema.rollback" });
    const scopeType = body.scopeType ?? "tenant";
    req.ctx.audit!.inputDigest = { name: params.name, scopeType, requestedBy: subject.subjectId };
    req.ctx.audit!.outputDigest = { ok: false, requiredFlow: "changeset.release", supportedKind: "schema.rollback" };
    throw Errors.schemaChangesetRequired("rollback");
  });

  app.post("/governance/schema-migrations", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "schema.migration.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "schema.migration.write" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]),
        scopeId: z.string().min(1),
        schemaName: z.string().min(1),
        targetVersion: z.number().int().positive(),
        kind: z.enum(SUPPORTED_SCHEMA_MIGRATION_KINDS),
        plan: z.any(),
      })
      .parse(req.body);

    if (body.scopeType === "tenant" && body.scopeId !== subject.tenantId) throw Errors.forbidden();
    if (body.scopeType === "space") {
      const spaceRes = await app.db.query("SELECT tenant_id FROM spaces WHERE id = $1 LIMIT 1", [body.scopeId]);
      if (!spaceRes.rowCount) throw Errors.badRequest("Space 不存在");
      if (String(spaceRes.rows[0].tenant_id) !== subject.tenantId) throw Errors.forbidden();
    }

    const mig = await createSchemaMigration({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      schemaName: body.schemaName,
      targetVersion: body.targetVersion,
      kind: body.kind,
      plan: body.plan,
      createdBySubjectId: subject.subjectId,
    });

    const runToolRef = `schema.migration:${mig.schemaName}:${mig.migrationId}`;
    const { job, run, step } = await createJobRunStepWithoutToolRef({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "schema.migration",
      runToolRef,
      policySnapshotRef: decision.snapshotRef,
      input: {
        kind: "schema.migration",
        migrationId: mig.migrationId,
        tenantId: subject.tenantId,
        scopeType: mig.scopeType,
        scopeId: mig.scopeId,
        schemaName: mig.schemaName,
        targetVersion: mig.targetVersion,
        traceId: req.ctx.traceId,
        subjectId: subject.subjectId,
      },
      createdBySubjectId: subject.subjectId,
      trigger: "manual",
    });

    const migRun = await createSchemaMigrationRun({
      pool: app.db,
      tenantId: subject.tenantId,
      migrationId: mig.migrationId,
      jobId: job.jobId,
      runId: run.runId,
      stepId: step.stepId,
    });

    await setSchemaMigrationStatus({ pool: app.db, tenantId: subject.tenantId, migrationId: mig.migrationId, status: "queued" });
    await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });

    req.ctx.audit!.outputDigest = { migrationId: mig.migrationId, migrationRunId: migRun.migrationRunId, jobId: job.jobId, runId: run.runId, stepId: step.stepId, kind: mig.kind };
    return { migration: mig, migrationRun: migRun, receipt: { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: step.stepId }, status: "queued" as const } };
  });

  app.get("/governance/schema-migrations", async (req) => {
    const subject = req.ctx.subject!;
    const q = z.object({ schemaName: z.string().min(1).optional(), limit: z.coerce.number().int().positive().max(200).optional() }).parse(req.query);
    setAuditContext(req, { resourceType: "governance", action: "schema.migration.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "schema.migration.read" });
    const items = await listSchemaMigrations({ pool: app.db, tenantId: subject.tenantId, schemaName: q.schemaName, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.get("/governance/schema-migration-runs/:id", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "schema.migration.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "schema.migration.read" });
    const run = await getSchemaMigrationRun({ pool: app.db, tenantId: subject.tenantId, migrationRunId: params.id });
    if (!run) throw Errors.notFound("migrationRun");
    req.ctx.audit!.outputDigest = { migrationRunId: run.migrationRunId, status: run.status };
    return { run };
  });

  app.post("/governance/schema-migration-runs/:id/cancel", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "schema.migration.write" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "schema.migration.write" });
    const run = await getSchemaMigrationRun({ pool: app.db, tenantId: subject.tenantId, migrationRunId: params.id });
    if (!run) throw Errors.notFound("migrationRun");
    const updated = await setSchemaMigrationRunCanceled({ pool: app.db, tenantId: subject.tenantId, migrationRunId: params.id });
    await setSchemaMigrationStatus({ pool: app.db, tenantId: subject.tenantId, migrationId: run.migrationId, status: "canceled" });
    req.ctx.audit!.outputDigest = { migrationRunId: params.id, canceled: true };
    return { run: updated };
  });

  app.get("/governance/artifact-policy", async (req, reply) => {
    const q = z.object({ scopeType: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "artifact.policy.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "artifact.policy.read" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = q.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const pol = await getArtifactPolicy({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId });
    if (!pol) {
      req.ctx.audit!.outputDigest = { scopeType, scopeId, found: false };
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "策略不存在", "en-US": "Policy not found" }, traceId: req.ctx.traceId });
    }
    req.ctx.audit!.outputDigest = {
      scopeType,
      scopeId,
      watermarkHeadersEnabled: pol.watermarkHeadersEnabled,
      downloadTokenExpiresInSec: pol.downloadTokenExpiresInSec,
      downloadTokenMaxUses: pol.downloadTokenMaxUses,
    };
    return pol;
  });

  app.put("/governance/artifact-policy", async (req) => {
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
        downloadTokenExpiresInSec: z.number().int().positive().max(3600).optional(),
        downloadTokenMaxUses: z.number().int().positive().max(10).optional(),
        watermarkHeadersEnabled: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "artifact.policy.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "artifact.policy.write" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const expiresInSec = body.downloadTokenExpiresInSec ?? 300;
    const maxUses = body.downloadTokenMaxUses ?? 1;
    const watermarkHeadersEnabled = body.watermarkHeadersEnabled ?? true;
    req.ctx.audit!.inputDigest = { scopeType, scopeId, downloadTokenExpiresInSec: expiresInSec, downloadTokenMaxUses: maxUses, watermarkHeadersEnabled };
    await upsertArtifactPolicy({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      downloadTokenExpiresInSec: expiresInSec,
      downloadTokenMaxUses: maxUses,
      watermarkHeadersEnabled,
    });
    req.ctx.audit!.outputDigest = { ok: true };
    return { ok: true };
  });

  app.get("/governance/tools/network-policies", async (req) => {
    const q = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.network_policy.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.network_policy.read" });
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
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.network_policy.read" });
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
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.network_policy.write" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const canon = (body.allowedDomains ?? []).map((d) => d.trim()).filter(Boolean).sort();
    const digest = sha256Hex(canon.join("\n")).slice(0, 8);
    const rules = body.rules ?? [];
    const rulesDigest = sha256Hex(JSON.stringify(rules)).slice(0, 8);
    req.ctx.audit!.inputDigest = { scopeType, scopeId, toolRef: params.toolRef, allowedDomainsCount: canon.length, sha256_8: digest, rulesCount: rules.length, rulesSha256_8: rulesDigest };
    await upsertToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, toolRef: params.toolRef, allowedDomains: canon, rules });
    req.ctx.audit!.outputDigest = { ok: true };
    return { ok: true };
  });

  app.get("/governance/policy/snapshots", async (req) => {
    const q = z
      .object({
        scope: z.enum(["tenant", "space"]).optional(),
        subjectId: z.string().min(1).optional(),
        resourceType: z.string().min(1).optional(),
        action: z.string().min(1).optional(),
        decision: z.enum(["allow", "deny"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        cursorCreatedAt: z.string().min(10).optional(),
        cursorSnapshotId: z.string().uuid().optional(),
      })
      .parse(req.query);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "policy_snapshot", action: "list" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "policy_snapshot.read" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = q.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    req.ctx.audit!.inputDigest = {
      scopeType,
      subjectId: q.subjectId ?? null,
      resourceType: q.resourceType ?? null,
      action: q.action ?? null,
      decision: q.decision ?? null,
      limit: q.limit ?? 50,
    };

    const res = await listPolicySnapshots({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      subjectId: q.subjectId,
      resourceType: q.resourceType,
      action: q.action,
      decision: q.decision,
      limit: q.limit ?? 50,
      cursor: q.cursorCreatedAt && q.cursorSnapshotId ? { createdAt: q.cursorCreatedAt, snapshotId: q.cursorSnapshotId } : undefined,
    });

    req.ctx.audit!.outputDigest = { count: res.items.length, nextCursor: res.nextCursor ?? null };
    return {
      items: res.items.map((s) => ({
        snapshotId: s.snapshotId,
        tenantId: s.tenantId,
        spaceId: s.spaceId,
        subjectId: s.subjectId,
        resourceType: s.resourceType,
        action: s.action,
        decision: s.decision,
        reason: s.reason,
        rowFilters: s.rowFilters,
        fieldRules: s.fieldRules,
        policyRef: s.policyRef,
        policyCacheEpoch: s.policyCacheEpoch,
        createdAt: s.createdAt,
      })),
      nextCursor: res.nextCursor,
    };
  });

  app.get("/governance/policy/snapshots/:snapshotId/explain", async (req, reply) => {
    const params = z.object({ snapshotId: z.string().uuid() }).parse(req.params);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "policy_snapshot", action: "explain" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "policy_snapshot.explain" });
    req.ctx.audit!.policyDecision = decision;

    const snap = await getPolicySnapshot({ pool: app.db, tenantId: subject.tenantId, snapshotId: params.snapshotId });
    if (!snap) {
      req.ctx.audit!.outputDigest = { snapshotId: params.snapshotId, found: false };
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "Policy Snapshot 不存在", "en-US": "Policy snapshot not found" },
        traceId: req.ctx.traceId,
      });
    }
    if (snap.spaceId && subject.spaceId && snap.spaceId !== subject.spaceId) {
      req.ctx.audit!.outputDigest = { snapshotId: params.snapshotId, found: false };
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "Policy Snapshot 不存在", "en-US": "Policy snapshot not found" },
        traceId: req.ctx.traceId,
      });
    }

    req.ctx.audit!.outputDigest = { snapshotId: snap.snapshotId, decision: snap.decision, resourceType: snap.resourceType, action: snap.action };
    return {
      snapshotId: snap.snapshotId,
      tenantId: snap.tenantId,
      spaceId: snap.spaceId,
      resourceType: snap.resourceType,
      action: snap.action,
      decision: snap.decision,
      reason: snap.reason,
      matchedRules: snap.matchedRules,
      rowFilters: snap.rowFilters,
      fieldRules: snap.fieldRules,
      policyRef: snap.policyRef,
      policyCacheEpoch: snap.policyCacheEpoch,
      explainV1: snap.explainV1,
      createdAt: snap.createdAt,
    };
  });

  app.post("/governance/policy/debug/evaluate", async (req) => {
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]),
        scopeId: z.string().min(1),
        subjectId: z.string().min(1),
        resourceType: z.string().min(1),
        action: z.string().min(1),
        context: z.unknown().optional(),
        mode: z.enum(["read", "write"]).optional(),
      })
      .parse(req.body);
    const actor = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_debug", action: "evaluate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy_debug.evaluate" });

    if (body.scopeType === "tenant" && body.scopeId !== actor.tenantId) throw Errors.policyDebugInvalidInput("scopeId 必须等于 tenantId");
    if (body.scopeType === "space") {
      const r = await app.db.query("SELECT 1 FROM spaces WHERE id = $1 AND tenant_id = $2 LIMIT 1", [body.scopeId, actor.tenantId]);
      if (!r.rowCount) throw Errors.policyDebugInvalidInput("space 不存在或不属于当前 tenant");
    }
    const sub = await app.db.query("SELECT tenant_id FROM subjects WHERE id = $1 LIMIT 1", [body.subjectId]);
    if (!sub.rowCount) throw Errors.policyDebugInvalidInput("subject 不存在");
    if (String(sub.rows[0].tenant_id) !== actor.tenantId) throw Errors.policyDebugInvalidInput("subject 不属于当前 tenant");

    req.ctx.audit!.inputDigest = {
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      subjectId: body.subjectId,
      resourceType: body.resourceType,
      action: body.action,
      hasContext: body.context !== undefined,
      mode: body.mode ?? null,
    };

    const decision = await authorize({
      pool: app.db,
      tenantId: actor.tenantId,
      spaceId: body.scopeType === "space" ? body.scopeId : undefined,
      subjectId: body.subjectId,
      resourceType: body.resourceType,
      action: body.action,
    });
    const snapRef = String((decision as any).snapshotRef ?? "");
    const snapshotId = snapRef.startsWith("policy_snapshot:") ? snapRef.slice("policy_snapshot:".length) : "";
    if (!snapshotId) throw Errors.internal();
    const matchedRules: any = (decision as any).matchedRules ?? null;
    const roleIds = Array.isArray(matchedRules?.roleIds) ? matchedRules.roleIds : [];
    const perms = Array.isArray(matchedRules?.permissions) ? matchedRules.permissions : [];
    const warnings: string[] = [];
    const reason = typeof decision.reason === "string" ? decision.reason : null;
    if (reason === "unsupported_policy_expr") warnings.push("unsupported_policy_expr");
    if (reason === "unsupported_row_filters") warnings.push("unsupported_row_filters");

    req.ctx.audit!.outputDigest = { decision: decision.decision, snapshotId, roleCount: roleIds.length, permissionCount: perms.length, warningsCount: warnings.length };
    return {
      decision: decision.decision,
      reason: reason,
      policyRef: (decision as any).policyRef ?? null,
      policyCacheEpoch: (decision as any).policyCacheEpoch ?? null,
      policySnapshotId: snapshotId,
      matchedRulesSummary: { roleCount: roleIds.length, permissionCount: perms.length },
      fieldRulesEffective: (decision as any).fieldRules ?? null,
      rowFiltersEffective: (decision as any).rowFilters ?? null,
      explainV1: (decision as any).explainV1 ?? null,
      warnings,
    };
  });

  app.get("/governance/policy/cache/epoch", async (req) => {
    const q = z.object({ scopeType: z.enum(["tenant", "space"]).optional(), scopeId: z.string().min(1).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_cache", action: "epoch.get" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy_cache.read" });
    const scopeType = q.scopeType ?? "space";
    const scopeId = q.scopeId ?? (scopeType === "tenant" ? subject.tenantId : subject.spaceId);
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");
    const epoch = await getPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType, scopeId });
    req.ctx.audit!.outputDigest = { scopeType, scopeId, epoch };
    return { scopeType, scopeId, epoch };
  });

  app.post("/governance/policy/cache/invalidate", async (req) => {
    const body = z.object({ scopeType: z.enum(["tenant", "space"]), scopeId: z.string().min(1), reason: z.string().min(1).max(500) }).parse(req.body);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_cache", action: "invalidate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy_cache.invalidate" });
    const out = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: body.scopeType, scopeId: body.scopeId });
    req.ctx.audit!.inputDigest = { scopeType: body.scopeType, scopeId: body.scopeId, reasonLen: body.reason.length };
    req.ctx.audit!.outputDigest = { ...out };
    return out;
  });

  app.get("/governance/policy/versions", async (req) => {
    const q = z
      .object({
        name: z.string().min(1).optional(),
        status: z.enum(["draft", "released", "deprecated"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_version", action: "list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy.read" });
    const items = await listPolicyVersions({ pool: app.db as any, tenantId: subject.tenantId, name: q.name, status: q.status, limit: q.limit ?? 50 });
    req.ctx.audit!.inputDigest = { name: q.name ?? null, status: q.status ?? null, limit: q.limit ?? 50 };
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.get("/governance/policy/versions/:name/:version", async (req, reply) => {
    const params = z.object({ name: z.string().min(1), version: z.coerce.number().int().positive() }).parse(req.params);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_version", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy.read" });
    const ver = await getPolicyVersion({ pool: app.db as any, tenantId: subject.tenantId, name: params.name, version: params.version });
    if (!ver) {
      req.ctx.audit!.outputDigest = { found: false, name: params.name, version: params.version };
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "PolicyVersion 不存在", "en-US": "PolicyVersion not found" }, traceId: req.ctx.traceId });
    }
    req.ctx.audit!.outputDigest = { found: true, name: ver.name, version: ver.version, status: ver.status };
    return { item: ver, policyRef: { name: ver.name, version: ver.version } };
  });

  app.post("/governance/policy/versions", async (req) => {
    const body = z.object({ name: z.string().min(1).max(200), policyJson: z.unknown() }).parse(req.body);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_version", action: "create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy.write" });
    req.ctx.audit!.inputDigest = { name: body.name, hasPolicyJson: body.policyJson !== undefined };
    const ver = await createDraftPolicyVersion({ pool: app.db as any, tenantId: subject.tenantId, name: body.name, policyJson: body.policyJson });
    req.ctx.audit!.outputDigest = { name: ver.name, version: ver.version, status: ver.status, digest: ver.digest };
    return { item: ver, policyRef: { name: ver.name, version: ver.version } };
  });

  app.post("/governance/policy/versions/:name/:version/release", async (req) => {
    const params = z.object({ name: z.string().min(1), version: z.coerce.number().int().positive() }).parse(req.params);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_version", action: "release" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy.release" });
    const cur = await getPolicyVersion({ pool: app.db as any, tenantId: subject.tenantId, name: params.name, version: params.version });
    if (!cur) throw Errors.badRequest("PolicyVersion 不存在");
    if (cur.status !== "draft") throw Errors.badRequest("PolicyVersion 非 draft，无法发布");
    const policyJson = cur.policyJson;
    if (!policyJson || typeof policyJson !== "object") throw Errors.contractNotCompatible("policyJson 非对象");
    const expr = (policyJson as any).rowFiltersExpr ?? (policyJson as any).policyExpr ?? null;
    if (expr !== null && expr !== undefined) {
      const v = validatePolicyExpr(expr);
      if (!v.ok) throw Errors.contractNotCompatible(v.message);
    }
    const ver = await setPolicyVersionStatus({ pool: app.db as any, tenantId: subject.tenantId, name: params.name, version: params.version, status: "released" });
    if (!ver) throw Errors.badRequest("PolicyVersion 不存在");
    req.ctx.audit!.outputDigest = { name: ver.name, version: ver.version, status: ver.status, digest: ver.digest };
    return { item: ver, policyRef: { name: ver.name, version: ver.version } };
  });

  app.post("/governance/policy/versions/:name/:version/deprecate", async (req) => {
    const params = z.object({ name: z.string().min(1), version: z.coerce.number().int().positive() }).parse(req.params);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_version", action: "deprecate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy.write" });
    const ver = await setPolicyVersionStatus({ pool: app.db as any, tenantId: subject.tenantId, name: params.name, version: params.version, status: "deprecated" });
    if (!ver) throw Errors.badRequest("PolicyVersion 不存在");
    req.ctx.audit!.outputDigest = { name: ver.name, version: ver.version, status: ver.status, digest: ver.digest };
    return { item: ver, policyRef: { name: ver.name, version: ver.version } };
  });

  app.get("/governance/observability/summary", async (req) => {
    const q = z.object({ window: z.enum(["1h", "24h"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "observability", action: "summary" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    const window = q.window ?? "1h";
    const out = await getObservabilitySummary({ pool: app.db as any, tenantId: subject.tenantId, window });
    req.ctx.audit!.outputDigest = { window, routes: out.routes.length, sync: out.sync.length, topErrors: out.topErrors.length };
    return out;
  });

  app.post("/governance/tools/:toolRef/enable", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const body = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.enable", toolRef: params.toolRef });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.enable" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const ver = await getToolVersionByRef(app.db, subject.tenantId, params.toolRef);
    if (!ver || ver.status !== "released") throw Errors.badRequest("工具版本不存在或未发布");
    if (ver.artifactRef) {
      const t = toolTrustOk(ver.trustSummary);
      const s = toolScanOk(ver.scanSummary);
      if (!t.ok) throw Errors.trustNotVerified();
      if (!s.ok) throw Errors.scanNotPassed();
    }

    const rollout = await setToolRollout({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      toolRef: params.toolRef,
      enabled: true,
    });

    req.ctx.audit!.outputDigest = { scopeType, scopeId, toolRef: params.toolRef, enabled: rollout.enabled };
    return { rollout };
  });

  app.post("/governance/tools/:toolRef/disable", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const body = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.disable", toolRef: params.toolRef });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.disable" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const rollout = await setToolRollout({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      toolRef: params.toolRef,
      enabled: false,
    });

    req.ctx.audit!.outputDigest = { scopeType, scopeId, toolRef: params.toolRef, enabled: rollout.enabled };
    return { rollout };
  });

  app.post("/governance/tools/:name/active", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const body = z.object({ toolRef: z.string().min(3) }).parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.set_active", toolRef: body.toolRef });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.set_active" });
    req.ctx.audit!.policyDecision = decision;

    if (!body.toolRef.startsWith(`${params.name}@`)) throw Errors.badRequest("toolRef 与 name 不匹配");
    const ver = await getToolVersionByRef(app.db, subject.tenantId, body.toolRef);
    if (!ver || ver.status !== "released") throw Errors.badRequest("工具版本不存在或未发布");
    if (ver.artifactRef) {
      const t = toolTrustOk(ver.trustSummary);
      const s = toolScanOk(ver.scanSummary);
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
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.set_active" });
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

  app.get("/governance/tools", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "tool.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const scopeType = q.scope;
    const scopeId = scopeType === "space" ? subject.spaceId : scopeType === "tenant" ? subject.tenantId : undefined;

    const rollouts = await listToolRollouts({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId });
    const actives = await listActiveToolRefs({ pool: app.db, tenantId: subject.tenantId });
    req.ctx.audit!.outputDigest = { rollouts: rollouts.length, actives: actives.length };
    return { rollouts, actives };
  });

  app.get("/governance/skill-runtime/runners", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.runner.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.read" });
    const items = await listSkillRuntimeRunners({ pool: app.db as any, tenantId: subject.tenantId });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.post("/governance/skill-runtime/runners", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        endpoint: z.string().url(),
        enabled: z.boolean().optional(),
        authSecretId: z.string().min(3).optional(),
        capabilities: z.any().optional(),
      })
      .parse(req.body ?? {});
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.runner.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.enable" });
    const runnerId = crypto.randomUUID();
    const created = await createSkillRuntimeRunner({
      pool: app.db as any,
      tenantId: subject.tenantId,
      runnerId,
      endpoint: body.endpoint,
      enabled: body.enabled ?? true,
      authSecretId: body.authSecretId ?? null,
      capabilities: body.capabilities ?? null,
    });
    req.ctx.audit!.outputDigest = { runnerId: created.runnerId, enabled: created.enabled };
    return { runner: created };
  });

  app.post("/governance/skill-runtime/runners/:runnerId/enable", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ runnerId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.runner.enable" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.enable" });
    const runner = await setSkillRuntimeRunnerEnabled({ pool: app.db as any, tenantId: subject.tenantId, runnerId: params.runnerId, enabled: true });
    if (!runner) throw Errors.notFound("runner");
    req.ctx.audit!.outputDigest = { runnerId: runner.runnerId, enabled: runner.enabled };
    return { runner };
  });

  app.post("/governance/skill-runtime/runners/:runnerId/disable", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ runnerId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.runner.disable" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.disable" });
    const runner = await setSkillRuntimeRunnerEnabled({ pool: app.db as any, tenantId: subject.tenantId, runnerId: params.runnerId, enabled: false });
    if (!runner) throw Errors.notFound("runner");
    req.ctx.audit!.outputDigest = { runnerId: runner.runnerId, enabled: runner.enabled };
    return { runner };
  });

  app.get("/governance/skill-runtime/trusted-keys", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.trusted_key.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.read" });
    const items = await listSkillTrustedKeys({ pool: app.db as any, tenantId: subject.tenantId });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.post("/governance/skill-runtime/trusted-keys", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        keyId: z.string().min(1).max(128),
        publicKeyPem: z.string().min(16),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .parse(req.body ?? {});
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.trusted_key.upsert" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.enable" });
    const key = await upsertSkillTrustedKey({
      pool: app.db as any,
      tenantId: subject.tenantId,
      keyId: body.keyId,
      publicKeyPem: body.publicKeyPem,
      status: body.status ?? "active",
    });
    req.ctx.audit!.outputDigest = { keyId: key.keyId, status: key.status };
    return { key };
  });

  app.post("/governance/skill-runtime/trusted-keys/:keyId/rotate", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ keyId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.trusted_key.rotate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.enable" });
    const key = await rotateSkillTrustedKey({ pool: app.db as any, tenantId: subject.tenantId, keyId: params.keyId });
    if (!key) throw Errors.notFound("key");
    req.ctx.audit!.outputDigest = { keyId: key.keyId, status: key.status, rotatedAt: key.rotatedAt };
    return { key };
  });

  app.get("/governance/model-gateway/routing", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "model_routing.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "model_routing.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ purpose: z.string().min(1).optional(), limit: z.coerce.number().int().positive().max(500).optional() }).parse(req.query);
    if (q.purpose) {
      const policy = await getRoutingPolicy({ pool: app.db, tenantId: subject.tenantId, purpose: q.purpose });
      req.ctx.audit!.outputDigest = { purpose: q.purpose, found: Boolean(policy) };
      return { policies: policy ? [policy] : [] };
    }
    const policies = await listRoutingPolicies({ pool: app.db, tenantId: subject.tenantId, limit: q.limit ?? 200 });
    req.ctx.audit!.outputDigest = { count: policies.length };
    return { policies };
  });

  app.put("/governance/model-gateway/routing/:purpose", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ purpose: z.string().min(1).max(100) }).parse(req.params);
    const body = z
      .object({
        primaryModelRef: z.string().min(3),
        fallbackModelRefs: z.array(z.string().min(3)).max(10).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "model_routing.update" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "model_routing.update" });
    req.ctx.audit!.policyDecision = decision;

    const policy = await upsertRoutingPolicy({
      pool: app.db,
      tenantId: subject.tenantId,
      purpose: params.purpose,
      primaryModelRef: body.primaryModelRef,
      fallbackModelRefs: body.fallbackModelRefs ?? [],
      enabled: body.enabled ?? true,
    });
    req.ctx.audit!.outputDigest = { purpose: policy.purpose, primaryModelRef: policy.primaryModelRef, fallbackCount: policy.fallbackModelRefs.length, enabled: policy.enabled };
    return { policy };
  });

  app.post("/governance/model-gateway/routing/:purpose/disable", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ purpose: z.string().min(1).max(100) }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "model_routing.disable" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "model_routing.disable" });
    req.ctx.audit!.policyDecision = decision;

    const policy = await disableRoutingPolicy({ pool: app.db, tenantId: subject.tenantId, purpose: params.purpose });
    if (!policy) throw Errors.badRequest("policy 不存在");
    req.ctx.audit!.outputDigest = { purpose: policy.purpose, enabled: policy.enabled };
    return { policy };
  });

  app.get("/governance/model-gateway/limits", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "limits.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "limits.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const scopeType = q.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const quota = await getQuotaLimit({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId });
    const fallback = scopeType === "space" && !quota ? await getQuotaLimit({ pool: app.db, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId }) : null;
    const effectiveModelChatRpm = quota?.modelChatRpm ?? fallback?.modelChatRpm ?? null;
    const effectiveSource = quota ? `${scopeType}` : fallback ? "tenant_fallback" : "default";
    req.ctx.audit!.outputDigest = { scopeType, scopeId, hasQuota: Boolean(quota), effectiveSource };
    return { scopeType, scopeId, quota, effective: { modelChatRpm: effectiveModelChatRpm, source: effectiveSource } };
  });

  app.put("/governance/model-gateway/limits", async (req) => {
    const subject = req.ctx.subject!;
    const body = z.object({ scope: z.enum(["tenant", "space"]).optional(), modelChatRpm: z.number().int().positive().max(100000) }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "limits.update" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "limits.update" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const quota = await upsertQuotaLimit({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, modelChatRpm: body.modelChatRpm });
    req.ctx.audit!.outputDigest = { scopeType, scopeId, modelChatRpm: quota.modelChatRpm };
    return { quota };
  });

  app.get("/governance/model-gateway/budgets", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "model_budget.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "model_budget.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        scope: z.enum(["tenant", "space"]).optional(),
        purpose: z.string().min(1).optional(),
        scopeId: z.string().min(1).optional(),
      })
      .parse(req.query);
    const scopeType = q.scope;
    const scopeId = q.scopeId ?? (scopeType === "tenant" ? subject.tenantId : scopeType === "space" ? subject.spaceId ?? undefined : undefined);
    const items = await listModelBudgets({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, purpose: q.purpose });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.put("/governance/model-gateway/budgets", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "model_budget.update" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "model_budget.update" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        scope: z.enum(["tenant", "space"]).optional(),
        purpose: z.string().min(1).max(100),
        softDailyTokens: z.number().int().positive().max(1_000_000_000).nullable().optional(),
        hardDailyTokens: z.number().int().positive().max(1_000_000_000).nullable().optional(),
      })
      .parse(req.body ?? {});
    const scopeType = body.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");
    const softDailyTokens = body.softDailyTokens === undefined ? null : body.softDailyTokens;
    const hardDailyTokens = body.hardDailyTokens === undefined ? null : body.hardDailyTokens;
    const budget = await upsertModelBudget({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, purpose: body.purpose, softDailyTokens, hardDailyTokens });
    req.ctx.audit!.outputDigest = { scopeType, scopeId, purpose: budget.purpose, softDailyTokens: budget.softDailyTokens, hardDailyTokens: budget.hardDailyTokens };
    return { budget };
  });

  app.get("/governance/model-gateway/budgets/status", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "model_budget.status" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "model_budget.status" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ purpose: z.string().min(1).max(100) }).parse(req.query);
    const eff = await getEffectiveModelBudget({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, purpose: q.purpose });
    if (!eff) {
      req.ctx.audit!.outputDigest = { purpose: q.purpose, found: false };
      return { purpose: q.purpose, found: false, usedTokens: 0, budget: null };
    }
    const key = tokenBudgetKey({ tenantId: subject.tenantId, scopeType: eff.scopeType, scopeId: eff.scopeId, purpose: eff.purpose });
    const usedTokens = await getTokenBudgetUsed({ redis: app.redis, key });
    req.ctx.audit!.outputDigest = { purpose: q.purpose, found: true, usedTokens, softDailyTokens: eff.softDailyTokens, hardDailyTokens: eff.hardDailyTokens };
    return { purpose: q.purpose, found: true, usedTokens, budget: eff };
  });

  app.get("/governance/models/usage", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "model_usage.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "model_usage.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        scope: z.enum(["tenant", "space"]).optional(),
        range: z.string().optional(),
        since: z.string().min(10).optional(),
        until: z.string().min(10).optional(),
        purpose: z.string().min(1).optional(),
        modelRef: z.string().min(3).optional(),
      })
      .parse(req.query);

    const now = new Date();
    const rangeRaw = (q.range ?? "24h").trim().toLowerCase();
    const rangeMs =
      rangeRaw.endsWith("h") && Number.isFinite(Number(rangeRaw.slice(0, -1)))
        ? Number(rangeRaw.slice(0, -1)) * 60 * 60 * 1000
        : rangeRaw.endsWith("d") && Number.isFinite(Number(rangeRaw.slice(0, -1)))
          ? Number(rangeRaw.slice(0, -1)) * 24 * 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
    const since = q.since ? new Date(q.since) : new Date(now.getTime() - rangeMs);
    const until = q.until ? new Date(q.until) : now;
    if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until) throw Errors.badRequest("时间范围无效");

    const scopeType = q.scope ?? "space";
    const spaceId = scopeType === "space" ? subject.spaceId ?? null : null;

    const items = await queryModelUsageAgg({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId,
      since: since.toISOString(),
      until: until.toISOString(),
      purpose: q.purpose,
      modelRef: q.modelRef,
    });
    req.ctx.audit!.outputDigest = { scopeType, since: since.toISOString(), until: until.toISOString(), count: items.length };
    return { scopeType, since: since.toISOString(), until: until.toISOString(), items };
  });

  app.get("/governance/tool-limits", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "limits.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "limits.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ toolRef: z.string().min(3).optional(), limit: z.coerce.number().int().positive().max(500).optional() }).parse(req.query);
    if (q.toolRef) {
      const tl = await getToolLimit({ pool: app.db, tenantId: subject.tenantId, toolRef: q.toolRef });
      req.ctx.audit!.outputDigest = { toolRef: q.toolRef, found: Boolean(tl) };
      return { toolLimits: tl ? [tl] : [] };
    }
    const toolLimits = await listToolLimits({ pool: app.db, tenantId: subject.tenantId, limit: q.limit ?? 200 });
    req.ctx.audit!.outputDigest = { count: toolLimits.length };
    return { toolLimits };
  });

  app.put("/governance/tool-limits/:toolRef", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const body = z.object({ defaultMaxConcurrency: z.number().int().positive().max(1000) }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "limits.update", toolRef: params.toolRef });
    const decision = await requirePermission({ req, resourceType: "governance", action: "limits.update" });
    req.ctx.audit!.policyDecision = decision;

    const toolLimit = await upsertToolLimit({ pool: app.db, tenantId: subject.tenantId, toolRef: params.toolRef, defaultMaxConcurrency: body.defaultMaxConcurrency });
    req.ctx.audit!.outputDigest = { toolRef: toolLimit.toolRef, defaultMaxConcurrency: toolLimit.defaultMaxConcurrency };
    return { toolLimit };
  });

  app.post("/governance/changesets", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "changeset.create" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.create" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        title: z.string().min(1),
        scope: z.enum(["tenant", "space"]).optional(),
        canaryTargets: z.array(z.string().min(1)).max(50).optional(),
      })
      .parse(req.body);
    const scopeType = body.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const cs = await createChangeSet({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      title: body.title,
      createdBy: subject.subjectId,
      canaryTargets: body.canaryTargets ?? null,
    });
    req.ctx.audit!.outputDigest = { id: cs.id, scopeType, scopeId, status: cs.status };
    return { changeset: cs };
  });

  app.post("/governance/changesets/:id/evals/bind", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ suiteIds: z.array(z.string().uuid()).max(20) }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "changeset.bind_evals" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.update" });
    req.ctx.audit!.policyDecision = decision;

    await replaceChangeSetEvalBindings({ pool: app.db, tenantId: subject.tenantId, changesetId: params.id, suiteIds: body.suiteIds });
    req.ctx.audit!.outputDigest = { changesetId: params.id, suiteIdsCount: body.suiteIds.length };
    return { changesetId: params.id, suiteIds: body.suiteIds };
  });

  app.get("/governance/changesets/:id/evals", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const suiteIds = await listChangeSetEvalBindings({ pool: app.db, tenantId: subject.tenantId, changesetId: params.id });
    const suites = await Promise.all(suiteIds.map((id) => getEvalSuite({ pool: app.db, tenantId: subject.tenantId, id })));
    return { suiteIds, suites: suites.filter(Boolean) };
  });

  app.post("/governance/evals/suites", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        name: z.string().min(1),
        description: z.string().max(2000).optional(),
        cases: z.array(z.any()).max(200).optional(),
        thresholds: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "evalsuite.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalsuite.write" });
    req.ctx.audit!.policyDecision = decision;

    const suite = await createEvalSuite({
      pool: app.db,
      tenantId: subject.tenantId,
      name: body.name,
      description: body.description ?? null,
      casesJson: body.cases ?? [],
      thresholds: body.thresholds ?? {},
    });
    req.ctx.audit!.outputDigest = { suiteId: suite.id, name: suite.name };
    return { suite };
  });

  app.put("/governance/evals/suites/:id", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        description: z.string().max(2000).nullable().optional(),
        cases: z.array(z.any()).max(200).optional(),
        thresholds: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "evalsuite.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalsuite.write" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const suite = await updateEvalSuite({
        pool: app.db,
        tenantId: subject.tenantId,
        id: params.id,
        description: body.description,
        casesJson: body.cases,
        thresholds: body.thresholds,
      });
      return { suite };
    } catch (e: any) {
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.get("/governance/evals/suites", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "evalsuite.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalsuite.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ limit: z.coerce.number().int().positive().max(50).optional() }).parse(req.query);
    const suites = await listEvalSuites({ pool: app.db, tenantId: subject.tenantId, limit: q.limit ?? 20 });
    return { suites };
  });

  app.get("/governance/evals/suites/:id", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "evalsuite.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalsuite.read" });
    req.ctx.audit!.policyDecision = decision;

    const suite = await getEvalSuite({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!suite) throw Errors.badRequest("suite 不存在");
    return { suite };
  });

  app.post("/governance/evals/suites/:id/cases/from-replay", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ runId: z.string().min(3), stepId: z.string().min(3) }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "evalsuite.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalsuite.write" });
    req.ctx.audit!.policyDecision = decision;

    const suite = await getEvalSuite({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!suite) throw Errors.badRequest("suite 不存在");

    const src = await app.db.query(
      `
        SELECT r.run_id, r.policy_snapshot_ref, r.created_at, s.step_id, s.tool_ref, s.input_digest, s.output_digest, s.sealed_at, s.sealed_input_digest, s.sealed_output_digest
        FROM runs r
        JOIN steps s ON s.run_id = r.run_id
        WHERE r.tenant_id = $1 AND r.run_id = $2 AND s.step_id = $3
        LIMIT 1
      `,
      [subject.tenantId, body.runId, body.stepId],
    );
    if (!src.rowCount) throw Errors.badRequest("回放来源不存在");

    const r = src.rows[0] as any;
    const sealModeRaw = String(process.env.WORKFLOW_SEAL_MODE ?? "").trim().toLowerCase();
    const sealMode = sealModeRaw === "deny" ? "deny" : sealModeRaw === "off" || sealModeRaw === "0" || sealModeRaw === "false" || sealModeRaw === "no" ? "off" : "audit_only";
    if (sealMode === "deny" && !r.sealed_at) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.sealNotPresent();
    }
    const isSealedDigest = (v: any) => v && typeof v === "object" && typeof (v as any).len === "number" && typeof (v as any).sha256_8 === "string";
    const fallbackSealedInputDigest = () => {
      const s = stableStringify(r.input_digest ?? null);
      return { len: Buffer.byteLength(s, "utf8"), sha256_8: sha256Hex(s).slice(0, 8) };
    };
    const sealedInputDigest = isSealedDigest(r.sealed_input_digest) ? r.sealed_input_digest : fallbackSealedInputDigest();
    const caseId = sha256Hex(`${String(r.run_id)}:${String(r.step_id)}`).slice(0, 12);
    const nextCase = {
      caseId,
      source: { type: "replay", runId: String(r.run_id), stepId: String(r.step_id), createdAt: String(r.created_at) },
      toolRef: String(r.tool_ref ?? ""),
      policySnapshotRef: String(r.policy_snapshot_ref ?? ""),
      inputDigest: r.input_digest ?? null,
      outputDigest: r.output_digest ?? null,
      sealStatus: r.sealed_at ? "sealed" : "legacy",
      sealedInputDigest,
      sealedOutputDigest: r.sealed_output_digest ?? null,
      evidenceCount: Number(r.output_digest?.evidenceCount ?? 0) || 0,
      evidenceDigest: r.output_digest?.evidenceDigest ?? null,
      retrievalLogId: typeof r.output_digest?.retrievalLogId === "string" ? String(r.output_digest.retrievalLogId) : "",
    };

    const existing = Array.isArray(suite.casesJson) ? suite.casesJson : [];
    const deduped = existing.some((c: any) => String(c?.caseId ?? "") === caseId || (c?.source?.runId === nextCase.source.runId && c?.source?.stepId === nextCase.source.stepId));
    const nextCases = deduped ? existing : [...existing, nextCase].slice(0, 200);

    const updated = await updateEvalSuite({ pool: app.db, tenantId: subject.tenantId, id: suite.id, casesJson: nextCases });
    req.ctx.audit!.outputDigest = { suiteId: suite.id, caseId, totalCases: updated.casesJson.length };
    return { suite: updated, added: !deduped, caseId };
  });

  app.post("/governance/evals/suites/:id/runs", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        changesetId: z.string().uuid().optional(),
        execute: z.boolean().optional(),
        status: z.enum(["queued", "running", "succeeded", "failed"]).optional(),
        summary: z.record(z.string(), z.any()).optional(),
        evidenceDigest: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "evalrun.execute" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalrun.execute" });
    req.ctx.audit!.policyDecision = decision;

    const suite = await getEvalSuite({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!suite) throw Errors.badRequest("suite 不存在");

    const shouldExecute =
      body.execute === true ||
      (body.execute !== false && body.status === undefined && body.summary === undefined && body.evidenceDigest === undefined);

    if (!shouldExecute) {
      const run = await createEvalRun({
        pool: app.db,
        tenantId: subject.tenantId,
        suiteId: suite.id,
        changesetId: body.changesetId ?? null,
        status: body.status ?? "succeeded",
        summary: body.summary ?? { totalCases: (suite.casesJson ?? []).length, passedCases: (suite.casesJson ?? []).length, passRate: 1, denyRate: 0 },
        evidenceDigest: body.evidenceDigest ?? null,
      });
      req.ctx.audit!.outputDigest = { runId: run.id, suiteId: suite.id, changesetId: run.changesetId, status: run.status, result: String(run.summary?.result ?? "") || null };
      return { run };
    }

    if (body.changesetId) {
      const bound = await listChangeSetEvalBindings({ pool: app.db, tenantId: subject.tenantId, changesetId: body.changesetId });
      if (!bound.includes(suite.id)) {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.badRequest("suite 未绑定 changeset");
      }
    }

    const casesJson = Array.isArray(suite.casesJson) ? suite.casesJson : [];
    const digestInput = casesJson.map((c: any) => ({
      caseId: c?.caseId ?? null,
      sourceType: c?.source?.type ?? null,
      toolRef: c?.toolRef ?? null,
      sealStatus: c?.sealStatus ?? null,
      sealedInputDigest: c?.sealedInputDigest ?? null,
      sealedOutputDigest: c?.sealedOutputDigest ?? null,
    }));
    const reportDigest8 = sha256Hex(stableStringify(digestInput)).slice(0, 8);

    const created = await createEvalRun({
      pool: app.db,
      tenantId: subject.tenantId,
      suiteId: suite.id,
      changesetId: body.changesetId ?? null,
      status: "running",
      summary: { totalCases: casesJson.length, reportDigest8 },
      evidenceDigest: { caseCount: casesJson.length, reportDigest8 },
    });

    let run = created;
    try {
      const summary = computeEvalSummary({ casesJson, thresholds: suite.thresholds ?? {}, reportDigest8 });
      const sealed = casesJson.filter((c: any) => String(c?.sealStatus ?? "") === "sealed").length;
      const legacy = casesJson.filter((c: any) => String(c?.sealStatus ?? "") === "legacy").length;
      const evidenceDigest = { caseCount: casesJson.length, sealed, legacy, reportDigest8 };
      const updated = await setEvalRunFinished({
        pool: app.db,
        tenantId: subject.tenantId,
        id: created.id,
        status: "succeeded",
        summary,
        evidenceDigest,
      });
      if (updated) run = updated;
    } catch (e: any) {
      const digest8 = sha256Hex(String(e?.message ?? e)).slice(0, 8);
      const updated = await setEvalRunFinished({
        pool: app.db,
        tenantId: subject.tenantId,
        id: created.id,
        status: "failed",
        summary: { totalCases: casesJson.length, reportDigest8, result: "fail", errorDigest8: digest8 },
        evidenceDigest: { caseCount: casesJson.length, reportDigest8, errorDigest8: digest8 },
      });
      if (updated) run = updated;
    }

    req.ctx.audit!.outputDigest = { runId: run.id, suiteId: suite.id, changesetId: run.changesetId, status: run.status, result: String(run.summary?.result ?? "") || null };
    return { run };
  });

  app.get("/governance/evals/runs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "evalrun.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalrun.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        suiteId: z.string().uuid().optional(),
        changesetId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(50).optional(),
      })
      .parse(req.query);
    const runs = await listEvalRuns({ pool: app.db, tenantId: subject.tenantId, suiteId: q.suiteId, changesetId: q.changesetId, limit: q.limit ?? 20 });
    return { runs };
  });

  app.get("/governance/evals/runs/:id", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "evalrun.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalrun.read" });
    req.ctx.audit!.policyDecision = decision;

    const run = await getEvalRun({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!run) throw Errors.badRequest("run 不存在");
    return { run };
  });

  app.get("/governance/changesets", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "changeset.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        scope: z.enum(["tenant", "space"]).optional(),
        limit: z.coerce.number().int().positive().max(50).optional(),
      })
      .parse(req.query);
    const scopeType = q.scope;
    const scopeId = scopeType === "space" ? subject.spaceId : scopeType === "tenant" ? subject.tenantId : undefined;

    const list = await listChangeSets({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, limit: q.limit ?? 20 });
    return { changesets: list };
  });

  app.get("/governance/changesets/pipelines", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "changeset.pipeline.list" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        scope: z.enum(["tenant", "space"]).optional(),
        limit: z.coerce.number().int().positive().max(50).optional(),
        mode: z.enum(["full", "canary"]).optional(),
      })
      .parse(req.query);
    const scopeType = q.scope;
    const scopeId = scopeType === "space" ? subject.spaceId : scopeType === "tenant" ? subject.tenantId : undefined;
    const mode = q.mode ?? "full";

    const list = await listChangeSets({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, limit: q.limit ?? 20 });
    const pipelines = await Promise.all(
      list.map(async (cs) => {
        const out = await preflightChangeSet({ pool: app.db, tenantId: subject.tenantId, id: cs.id, mode });
        const isHighRisk = cs.riskLevel === "high" || cs.requiredApprovals >= 2;
        const evalRequiredSuiteIds = Array.isArray((out as any)?.evalGate?.requiredSuiteIds) ? ((out as any).evalGate.requiredSuiteIds as any[]) : [];
        const evalSuites = Array.isArray((out as any)?.evalGate?.suites) ? ((out as any).evalGate.suites as any[]) : [];
        const evalRequired = evalRequiredSuiteIds.length > 0 && isHighRisk;
        const evalAllPassed = evalSuites.every((e: any) => Boolean(e?.passed));
        const approvalsOk = out.gate.approvalsCount >= out.gate.requiredApprovals;
        const gates = [
          { gateType: "eval_admission", required: evalRequired, status: evalAllPassed ? "pass" : evalRequired ? "fail" : evalSuites.length > 0 ? "warn" : "pass" },
          { gateType: "approval", required: out.gate.requiredApprovals > 0, status: approvalsOk ? "pass" : "fail" },
          { gateType: "risk", required: false, status: cs.riskLevel === "low" ? "pass" : "warn" },
        ];
        return { changesetId: cs.id, mode, gates, warningsCount: out.warnings.length };
      }),
    );
    req.ctx.audit!.outputDigest = { count: pipelines.length, limit: q.limit ?? 20, mode, scope: q.scope ?? "all" };
    return { pipelines };
  });

  app.get("/governance/changesets/:id", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const cs = await getChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!cs) throw Errors.badRequest("changeset 不存在");
    const items = await listChangeSetItems({ pool: app.db, tenantId: subject.tenantId, changesetId: cs.id });
    return { changeset: cs, items };
  });

  app.get("/governance/changesets/:id/pipeline", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ mode: z.enum(["full", "canary"]).optional() }).parse(req.query);
    const mode = q.mode ?? "full";
    setAuditContext(req, { resourceType: "governance", action: "changeset.pipeline.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const cs = await getChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!cs) throw Errors.badRequest("changeset 不存在");
    const out = await preflightChangeSet({ pool: app.db, tenantId: subject.tenantId, id: cs.id, mode });

    function computeQuotaGate(preflight: any) {
      const plan: any[] = Array.isArray(preflight?.plan) ? preflight.plan : [];
      const current: any[] = Array.isArray(preflight?.currentStateDigest) ? preflight.currentStateDigest : [];
      const modelLimits = plan.filter((p) => p?.kind === "model_limits.set");
      const toolLimits = plan.filter((p) => p?.kind === "tool_limits.set");

      const modelPrev = new Map<string, number | null>();
      const toolPrev = new Map<string, number | null>();
      for (const c of current) {
        if (c?.kind === "model.quota_limit") {
          const k = `${String(c.scopeType ?? "")}:${String(c.scopeId ?? "")}`;
          const prevRpm = c?.prev && typeof c.prev === "object" ? Number((c.prev as any).modelChatRpm) : null;
          modelPrev.set(k, Number.isFinite(prevRpm as any) ? (prevRpm as any) : null);
        }
        if (c?.kind === "tool.limit") {
          const k = String(c.toolRef ?? "");
          const prevC = c?.prev && typeof c.prev === "object" ? Number((c.prev as any).defaultMaxConcurrency) : null;
          toolPrev.set(k, Number.isFinite(prevC as any) ? (prevC as any) : null);
        }
      }

      let modelIncreases = 0;
      let modelDecreases = 0;
      let toolIncreases = 0;
      let toolDecreases = 0;
      let modelMaxNextRpm = 0;
      let modelMaxPrevRpm = 0;
      let toolMaxNextC = 0;
      let toolMaxPrevC = 0;
      const deltaSummary: any[] = [];

      for (const p of modelLimits) {
        const scopeType = String(p.scopeType ?? "");
        const scopeId = String(p.scopeId ?? "");
        const next = Number(p.modelChatRpm);
        const k = `${scopeType}:${scopeId}`;
        const prev = modelPrev.has(k) ? modelPrev.get(k)! : null;
        if (Number.isFinite(next)) {
          modelMaxNextRpm = Math.max(modelMaxNextRpm, next);
          if (typeof prev === "number" && Number.isFinite(prev)) modelMaxPrevRpm = Math.max(modelMaxPrevRpm, prev);
        }
        if (typeof prev === "number" && Number.isFinite(prev) && Number.isFinite(next)) {
          if (next > prev) modelIncreases += 1;
          else if (next < prev) modelDecreases += 1;
        } else if (Number.isFinite(next)) {
          modelIncreases += 1;
        }
        deltaSummary.push({ kind: "model_limits.set", scopeType, scopeId, next: Number.isFinite(next) ? next : null, prev });
      }

      for (const p of toolLimits) {
        const toolRef = String(p.toolRef ?? "");
        const next = Number(p.defaultMaxConcurrency);
        const prev = toolPrev.has(toolRef) ? toolPrev.get(toolRef)! : null;
        if (Number.isFinite(next)) {
          toolMaxNextC = Math.max(toolMaxNextC, next);
          if (typeof prev === "number" && Number.isFinite(prev)) toolMaxPrevC = Math.max(toolMaxPrevC, prev);
        }
        if (typeof prev === "number" && Number.isFinite(prev) && Number.isFinite(next)) {
          if (next > prev) toolIncreases += 1;
          else if (next < prev) toolDecreases += 1;
        } else if (Number.isFinite(next)) {
          toolIncreases += 1;
        }
        deltaSummary.push({ kind: "tool_limits.set", toolRef, next: Number.isFinite(next) ? next : null, prev });
      }

      const increaseCount = modelIncreases + toolIncreases;
      const status = increaseCount > 0 ? "warn" : "pass";
      const digest8 = sha256Hex(JSON.stringify(deltaSummary.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).slice(0, 8);
      return {
        gateType: "quota",
        required: false,
        status,
        detailsDigest: {
          modelLimitsCount: modelLimits.length,
          toolLimitsCount: toolLimits.length,
          modelIncreases,
          modelDecreases,
          toolIncreases,
          toolDecreases,
          modelMaxNextRpm: modelMaxNextRpm || null,
          modelMaxPrevRpm: modelMaxPrevRpm || null,
          toolMaxNextConcurrency: toolMaxNextC || null,
          toolMaxPrevConcurrency: toolMaxPrevC || null,
          deltaDigest8: digest8,
        },
      };
    }

    function computeGates(params2: { cs: any; preflight: any }) {
      const cs2 = params2.cs;
      const preflight = params2.preflight;
      const isHighRisk = cs2.riskLevel === "high" || cs2.requiredApprovals >= 2;
      const evalRequiredSuiteIds = Array.isArray(preflight?.evalGate?.requiredSuiteIds) ? (preflight.evalGate.requiredSuiteIds as any[]) : [];
      const evalSuites = Array.isArray(preflight?.evalGate?.suites) ? (preflight.evalGate.suites as any[]) : [];
      const evalRequired = evalRequiredSuiteIds.length > 0 && isHighRisk;
      const evalAllPassed = evalSuites.every((e: any) => Boolean(e?.passed));
      const approvalsOk = preflight.gate.approvalsCount >= preflight.gate.requiredApprovals;
      const quotaGate = computeQuotaGate(preflight as any);
      const gates = [
        {
          gateType: "eval_admission",
          required: evalRequired,
          status: evalAllPassed ? "pass" : evalRequired ? "fail" : evalSuites.length > 0 ? "warn" : "pass",
          detailsDigest: {
            requiredSuites: evalRequiredSuiteIds.length,
            suites: evalSuites.length,
            failedSuites: evalSuites.filter((e: any) => !e?.passed).length,
            latestRunIdsDigest8: sha256Hex(JSON.stringify(evalSuites.map((e: any) => e.latestRunId ?? null))).slice(0, 8),
          },
        },
        {
          gateType: "approval",
          required: preflight.gate.requiredApprovals > 0,
          status: approvalsOk ? "pass" : "fail",
          detailsDigest: { requiredApprovals: preflight.gate.requiredApprovals, approvalsCount: preflight.gate.approvalsCount },
        },
        {
          gateType: "risk",
          required: false,
          status: cs2.riskLevel === "low" ? "pass" : "warn",
          detailsDigest: { riskLevel: cs2.riskLevel },
        },
        quotaGate,
      ];
      return { gates };
    }

    const gates = computeGates({ cs, preflight: out }).gates;

    const rollbackPreviewDigest8 = sha256Hex(JSON.stringify(out.rollbackPreview)).slice(0, 8);
    const pipeline = {
      changeset: {
        id: cs.id,
        title: cs.title ?? null,
        status: cs.status,
        riskLevel: cs.riskLevel,
        requiredApprovals: cs.requiredApprovals,
        scopeType: cs.scopeType,
        scopeId: cs.scopeId,
        createdAt: cs.createdAt,
        createdBy: cs.createdBy,
      },
      gates,
      rollout: {
        mode,
        canaryTargets: cs.canaryTargets ?? null,
        canaryReleasedAt: cs.canaryReleasedAt,
        releasedAt: cs.releasedAt,
        promotedAt: cs.promotedAt,
        rolledBackAt: cs.status === "rolled_back" ? cs.updatedAt : null,
      },
      warnings: out.warnings,
      rollbackPreviewDigest: { actionCount: out.rollbackPreview.length, sha256_8: rollbackPreviewDigest8 },
    };

    req.ctx.audit!.outputDigest = {
      changesetId: cs.id,
      mode,
      gateStatuses: gates.map((g: any) => ({ gateType: g.gateType, status: g.status })),
      warnings: out.warnings.slice(0, 10),
    };
    app.metrics.incGovernancePipelineAction({ action: "pipeline.read", result: "ok" });
    return { pipeline, preflight: out };
  });

  app.post("/governance/changesets/:id/items", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.update" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.update" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .union([
        z.object({ kind: z.literal("tool.enable"), toolRef: z.string().min(3) }),
        z.object({ kind: z.literal("tool.disable"), toolRef: z.string().min(3) }),
        z.object({ kind: z.literal("tool.set_active"), name: z.string().min(1), toolRef: z.string().min(3) }),
        z.object({ kind: z.literal("ui.page.publish"), pageName: z.string().min(1) }),
        z.object({ kind: z.literal("ui.page.rollback"), pageName: z.string().min(1) }),
        z.object({ kind: z.literal("policy.cache.invalidate"), scopeType: z.enum(["tenant", "space"]), scopeId: z.string().min(1), reason: z.string().min(1).max(500) }),
        z.object({ kind: z.literal("policy.version.release"), name: z.string().min(1).max(200), version: z.number().int().positive() }),
        z.object({ kind: z.literal("workbench.plugin.publish"), workbenchKey: z.string().min(1) }),
        z.object({ kind: z.literal("workbench.plugin.rollback"), workbenchKey: z.string().min(1) }),
        z.object({
          kind: z.literal("workbench.plugin.canary"),
          workbenchKey: z.string().min(1),
          canaryVersion: z.number().int().positive(),
          subjectIds: z.array(z.string().min(1)).max(500),
        }),
        z.object({ kind: z.literal("schema.publish"), name: z.string().min(1), schemaDef: schemaDefSchema, migrationRunId: z.string().uuid().optional() }),
        z.object({ kind: z.literal("schema.set_active"), name: z.string().min(1), version: z.number().int().positive() }),
        z.object({ kind: z.literal("schema.rollback"), name: z.string().min(1) }),
        z.object({
          kind: z.literal("model_routing.upsert"),
          purpose: z.string().min(1).max(100),
          primaryModelRef: z.string().min(3),
          fallbackModelRefs: z.array(z.string().min(3)).max(10).optional(),
          enabled: z.boolean().optional(),
        }),
        z.object({ kind: z.literal("model_routing.disable"), purpose: z.string().min(1).max(100) }),
        z.object({
          kind: z.literal("model_limits.set"),
          scopeType: z.enum(["tenant", "space"]),
          scopeId: z.string().min(1),
          modelChatRpm: z.number().int().positive().max(100000),
        }),
        z.object({
          kind: z.literal("tool_limits.set"),
          toolRef: z.string().min(3),
          defaultMaxConcurrency: z.number().int().positive().max(1000),
        }),
        z.object({
          kind: z.literal("artifact_policy.upsert"),
          scopeType: z.enum(["tenant", "space"]),
          scopeId: z.string().min(1),
          downloadTokenExpiresInSec: z.number().int().positive().max(3600),
          downloadTokenMaxUses: z.number().int().positive().max(10),
          watermarkHeadersEnabled: z.boolean(),
        }),
      ])
      .parse(req.body);

    const payload =
      body.kind === "tool.set_active"
        ? { name: body.name, toolRef: body.toolRef }
        : body.kind === "tool.enable" || body.kind === "tool.disable"
          ? { toolRef: body.toolRef }
          : body.kind === "policy.cache.invalidate"
            ? { scopeType: (body as any).scopeType, scopeId: (body as any).scopeId, reason: (body as any).reason }
            : body.kind === "policy.version.release"
              ? { name: (body as any).name, version: (body as any).version }
          : body.kind === "workbench.plugin.publish" || body.kind === "workbench.plugin.rollback"
            ? { workbenchKey: (body as any).workbenchKey }
            : body.kind === "workbench.plugin.canary"
              ? { workbenchKey: (body as any).workbenchKey, canaryVersion: (body as any).canaryVersion, subjectIds: (body as any).subjectIds }
          : body.kind === "schema.publish"
            ? body.migrationRunId
              ? { name: body.name, schemaDef: body.schemaDef, migrationRunId: body.migrationRunId }
              : { name: body.name, schemaDef: body.schemaDef }
            : body.kind === "schema.set_active"
              ? { name: body.name, version: body.version }
              : body.kind === "schema.rollback"
                ? { name: body.name }
                : body.kind === "ui.page.publish" || body.kind === "ui.page.rollback"
                  ? { pageName: body.pageName }
          : body.kind === "model_routing.upsert"
            ? { purpose: body.purpose, primaryModelRef: body.primaryModelRef, fallbackModelRefs: body.fallbackModelRefs ?? [], enabled: body.enabled ?? true }
            : body.kind === "model_routing.disable"
              ? { purpose: body.purpose }
              : body.kind === "model_limits.set"
                ? { scopeType: body.scopeType, scopeId: body.scopeId, modelChatRpm: body.modelChatRpm }
                : body.kind === "tool_limits.set"
                  ? { toolRef: body.toolRef, defaultMaxConcurrency: body.defaultMaxConcurrency }
                  : {
                      scopeType: body.scopeType,
                      scopeId: body.scopeId,
                      downloadTokenExpiresInSec: body.downloadTokenExpiresInSec,
                      downloadTokenMaxUses: body.downloadTokenMaxUses,
                      watermarkHeadersEnabled: body.watermarkHeadersEnabled,
                    };

    try {
      const item = await addChangeSetItem({ pool: app.db, tenantId: subject.tenantId, changesetId: params.id, kind: body.kind, payload });
      req.ctx.audit!.outputDigest = { changesetId: params.id, itemId: item.id, kind: item.kind };
      return { item };
    } catch (e: any) {
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/submit", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.submit" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.submit" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const cs = await submitChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id });
      return { changeset: cs };
    } catch (e: any) {
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/approve", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.approve" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.approve" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const r = await approveChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, approvedBy: subject.subjectId });
      return r;
    } catch (e: any) {
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/release", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ mode: z.enum(["full", "canary"]).optional() }).parse(req.query);
    const mode = q.mode ?? "full";
    setAuditContext(req, { resourceType: "governance", action: mode === "canary" ? "changeset.release_canary" : "changeset.release" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.release" });
    req.ctx.audit!.policyDecision = decision;

    let preflightOut: any | null = null;
    let preflightGates: any[] | null = null;
    try {
      try {
        preflightOut = await preflightChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, mode });
        const csForGates = preflightOut?.changeset ?? null;
        if (csForGates) {
          const isHighRisk = csForGates.riskLevel === "high" || csForGates.requiredApprovals >= 2;
          const evalRequiredSuiteIds = Array.isArray(preflightOut?.evalGate?.requiredSuiteIds) ? (preflightOut.evalGate.requiredSuiteIds as any[]) : [];
          const evalSuites = Array.isArray(preflightOut?.evalGate?.suites) ? (preflightOut.evalGate.suites as any[]) : [];
          const evalRequired = evalRequiredSuiteIds.length > 0 && isHighRisk;
          const evalAllPassed = evalSuites.every((e: any) => Boolean(e?.passed));
          const approvalsOk = preflightOut.gate.approvalsCount >= preflightOut.gate.requiredApprovals;
          const plan: any[] = Array.isArray(preflightOut?.plan) ? preflightOut.plan : [];
          const current: any[] = Array.isArray(preflightOut?.currentStateDigest) ? preflightOut.currentStateDigest : [];
          const modelLimits = plan.filter((p) => p?.kind === "model_limits.set");
          const toolLimits = plan.filter((p) => p?.kind === "tool_limits.set");
          const modelPrev = new Map<string, number | null>();
          const toolPrev = new Map<string, number | null>();
          for (const c of current) {
            if (c?.kind === "model.quota_limit") {
              const k = `${String(c.scopeType ?? "")}:${String(c.scopeId ?? "")}`;
              const prevRpm = c?.prev && typeof c.prev === "object" ? Number((c.prev as any).modelChatRpm) : null;
              modelPrev.set(k, Number.isFinite(prevRpm as any) ? (prevRpm as any) : null);
            }
            if (c?.kind === "tool.limit") {
              const k = String(c.toolRef ?? "");
              const prevC = c?.prev && typeof c.prev === "object" ? Number((c.prev as any).defaultMaxConcurrency) : null;
              toolPrev.set(k, Number.isFinite(prevC as any) ? (prevC as any) : null);
            }
          }
          let modelIncreases = 0;
          let modelDecreases = 0;
          let toolIncreases = 0;
          let toolDecreases = 0;
          let modelMaxNextRpm = 0;
          let modelMaxPrevRpm = 0;
          let toolMaxNextC = 0;
          let toolMaxPrevC = 0;
          const deltaSummary: any[] = [];
          for (const p of modelLimits) {
            const scopeType = String(p.scopeType ?? "");
            const scopeId = String(p.scopeId ?? "");
            const next = Number(p.modelChatRpm);
            const k = `${scopeType}:${scopeId}`;
            const prev = modelPrev.has(k) ? modelPrev.get(k)! : null;
            if (Number.isFinite(next)) {
              modelMaxNextRpm = Math.max(modelMaxNextRpm, next);
              if (typeof prev === "number" && Number.isFinite(prev)) modelMaxPrevRpm = Math.max(modelMaxPrevRpm, prev);
            }
            if (typeof prev === "number" && Number.isFinite(prev) && Number.isFinite(next)) {
              if (next > prev) modelIncreases += 1;
              else if (next < prev) modelDecreases += 1;
            } else if (Number.isFinite(next)) {
              modelIncreases += 1;
            }
            deltaSummary.push({ kind: "model_limits.set", scopeType, scopeId, next: Number.isFinite(next) ? next : null, prev });
          }
          for (const p of toolLimits) {
            const toolRef = String(p.toolRef ?? "");
            const next = Number(p.defaultMaxConcurrency);
            const prev = toolPrev.has(toolRef) ? toolPrev.get(toolRef)! : null;
            if (Number.isFinite(next)) {
              toolMaxNextC = Math.max(toolMaxNextC, next);
              if (typeof prev === "number" && Number.isFinite(prev)) toolMaxPrevC = Math.max(toolMaxPrevC, prev);
            }
            if (typeof prev === "number" && Number.isFinite(prev) && Number.isFinite(next)) {
              if (next > prev) toolIncreases += 1;
              else if (next < prev) toolDecreases += 1;
            } else if (Number.isFinite(next)) {
              toolIncreases += 1;
            }
            deltaSummary.push({ kind: "tool_limits.set", toolRef, next: Number.isFinite(next) ? next : null, prev });
          }
          const increaseCount = modelIncreases + toolIncreases;
          const quotaStatus = increaseCount > 0 ? "warn" : "pass";
          const deltaDigest8 = sha256Hex(JSON.stringify(deltaSummary.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).slice(0, 8);
          preflightGates = [
            {
              gateType: "eval_admission",
              required: evalRequired,
              status: evalAllPassed ? "pass" : evalRequired ? "fail" : evalSuites.length > 0 ? "warn" : "pass",
              detailsDigest: {
                requiredSuites: evalRequiredSuiteIds.length,
                suites: evalSuites.length,
                failedSuites: evalSuites.filter((e: any) => !e?.passed).length,
                latestRunIdsDigest8: sha256Hex(JSON.stringify(evalSuites.map((e: any) => e.latestRunId ?? null))).slice(0, 8),
              },
            },
            {
              gateType: "approval",
              required: preflightOut.gate.requiredApprovals > 0,
              status: approvalsOk ? "pass" : "fail",
              detailsDigest: { requiredApprovals: preflightOut.gate.requiredApprovals, approvalsCount: preflightOut.gate.approvalsCount },
            },
            {
              gateType: "risk",
              required: false,
              status: csForGates.riskLevel === "low" ? "pass" : "warn",
              detailsDigest: { riskLevel: csForGates.riskLevel },
            },
            {
              gateType: "quota",
              required: false,
              status: quotaStatus,
              detailsDigest: {
                modelLimitsCount: modelLimits.length,
                toolLimitsCount: toolLimits.length,
                modelIncreases,
                modelDecreases,
                toolIncreases,
                toolDecreases,
                modelMaxNextRpm: modelMaxNextRpm || null,
                modelMaxPrevRpm: modelMaxPrevRpm || null,
                toolMaxNextConcurrency: toolMaxNextC || null,
                toolMaxPrevConcurrency: toolMaxPrevC || null,
                deltaDigest8,
              },
            },
          ];
        }
      } catch {
      }

      const cs = await releaseChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, releasedBy: subject.subjectId, mode });
      req.ctx.audit!.outputDigest = {
        changesetId: cs.id,
        mode,
        gateStatuses: Array.isArray(preflightGates) ? preflightGates.map((g: any) => ({ gateType: g.gateType, status: g.status })) : null,
      };
      app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "ok" });
      return { changeset: cs };
    } catch (e: any) {
      if (String(e?.message ?? e) === "eval_not_passed") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "eval_admission" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = {
          changesetId: params.id,
          mode,
          gateFailed: { gateType: "eval_admission" },
          gateStatuses: Array.isArray(preflightGates) ? preflightGates.map((g: any) => ({ gateType: g.gateType, status: g.status })) : null,
          warnings: Array.isArray(preflightOut?.warnings) ? preflightOut.warnings.slice(0, 10) : null,
        };
        throw Errors.evalNotPassed();
      }
      if (String(e?.message ?? e) === "trust_not_verified") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "trust" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "trust" } };
        throw Errors.trustNotVerified();
      }
      if (String(e?.message ?? e) === "scan_not_passed") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "scan" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "scan" } };
        throw Errors.scanNotPassed();
      }
      if (String(e?.message ?? e) === "sbom_not_present") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "sbom" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "sbom" } };
        throw Errors.sbomNotPresent();
      }
      if (String(e?.message ?? e) === "isolation_required") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "isolation" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "isolation" } };
        throw Errors.isolationRequired();
      }
      if (String(e?.message ?? e) === "changeset_mode_not_supported") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "mode" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "mode" } };
        throw Errors.changeSetModeNotSupported();
      }
      if (String(e?.message ?? e) === "migration_required") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "migration" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "migration" } };
        throw Errors.migrationRequired();
      }
      if (String(e?.message ?? e) === "contract_not_compatible") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "contract" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "contract" } };
        throw Errors.contractNotCompatible();
      }
      app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "error" });
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/preflight", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ mode: z.enum(["full", "canary"]).optional() }).parse(req.query);
    setAuditContext(req, { resourceType: "governance", action: "changeset.preflight" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const out = await preflightChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, mode: q.mode });
      app.metrics.incGovernancePipelineAction({ action: "preflight", result: "ok" });
      const mode = q.mode ?? "full";
      const cs = (out as any).changeset ?? null;
      const isHighRisk = cs?.riskLevel === "high" || Number(cs?.requiredApprovals ?? 0) >= 2;
      const evalRequiredSuiteIds = Array.isArray((out as any)?.evalGate?.requiredSuiteIds) ? ((out as any).evalGate.requiredSuiteIds as any[]) : [];
      const evalSuites = Array.isArray((out as any)?.evalGate?.suites) ? ((out as any).evalGate.suites as any[]) : [];
      const evalRequired = evalRequiredSuiteIds.length > 0 && isHighRisk;
      const evalAllPassed = evalSuites.every((e: any) => Boolean(e?.passed));
      const approvalsOk = out.gate.approvalsCount >= out.gate.requiredApprovals;
      const gates = [
        {
          gateType: "eval_admission",
          required: evalRequired,
          status: evalAllPassed ? "pass" : evalRequired ? "fail" : evalSuites.length > 0 ? "warn" : "pass",
          detailsDigest: {
            requiredSuites: evalRequiredSuiteIds.length,
            suites: evalSuites.length,
            failedSuites: evalSuites.filter((e: any) => !e?.passed).length,
            latestRunIdsDigest8: sha256Hex(JSON.stringify(evalSuites.map((e: any) => e.latestRunId ?? null))).slice(0, 8),
          },
        },
        {
          gateType: "approval",
          required: out.gate.requiredApprovals > 0,
          status: approvalsOk ? "pass" : "fail",
          detailsDigest: { requiredApprovals: out.gate.requiredApprovals, approvalsCount: out.gate.approvalsCount },
        },
        {
          gateType: "risk",
          required: false,
          status: cs?.riskLevel === "low" ? "pass" : "warn",
          detailsDigest: { riskLevel: cs?.riskLevel ?? null },
        },
      ];
      req.ctx.audit!.outputDigest = {
        changesetId: cs?.id ?? params.id,
        mode,
        planCount: out.plan.length,
        gateStatuses: gates.map((g: any) => ({ gateType: g.gateType, status: g.status })),
        warnings: out.warnings.slice(0, 10),
      };
      return { ...(out as any), gates };
    } catch (e: any) {
      app.metrics.incGovernancePipelineAction({ action: "preflight", result: "error" });
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/promote", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.promote" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.release" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const cs = await promoteChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, promotedBy: subject.subjectId });
      req.ctx.audit!.outputDigest = { changesetId: cs.id, status: cs.status, canaryReleasedAt: cs.canaryReleasedAt, promotedAt: cs.promotedAt };
      app.metrics.incGovernancePipelineAction({ action: "promote", result: "ok" });
      return { changeset: cs };
    } catch (e: any) {
      app.metrics.incGovernancePipelineAction({ action: "promote", result: "error" });
      req.ctx.audit!.outputDigest = { changesetId: params.id };
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/rollback", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.rollback" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.rollback" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const rb = await rollbackChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, createdBy: subject.subjectId });
      req.ctx.audit!.outputDigest = { changesetId: params.id, rollbackChangeSetId: rb.id, rollbackOf: rb.rollbackOf, status: rb.status };
      app.metrics.incGovernancePipelineAction({ action: "rollback", result: "ok" });
      return { rollback: rb };
    } catch (e: any) {
      app.metrics.incGovernancePipelineAction({ action: "rollback", result: "error" });
      req.ctx.audit!.outputDigest = { changesetId: params.id };
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

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

  app.get("/governance/integrations", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "changeset.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;
    const q = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);

    const scopeType = q.scopeType ?? (subject.spaceId ? "space" : "tenant");
    const scopeId = scopeType === "space" ? subject.spaceId : subject.tenantId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    const oauth =
      scopeType === "space"
        ? await app.db.query(
            `
              SELECT g.grant_id, g.provider, g.status, g.created_at, g.updated_at, ci.id AS connector_instance_id, ci.name AS connector_name, ci.type_name AS connector_type
              FROM oauth_grants g
              JOIN connector_instances ci ON ci.id = g.connector_instance_id
              WHERE g.tenant_id = $1 AND g.space_id = $2
              ORDER BY g.updated_at DESC
              LIMIT $3 OFFSET $4
            `,
            [subject.tenantId, scopeId, limit, offset],
          )
        : await app.db.query(
            `
              SELECT g.grant_id, g.provider, g.status, g.created_at, g.updated_at, ci.id AS connector_instance_id, ci.name AS connector_name, ci.type_name AS connector_type
              FROM oauth_grants g
              JOIN connector_instances ci ON ci.id = g.connector_instance_id
              WHERE g.tenant_id = $1
              ORDER BY g.updated_at DESC
              LIMIT $2 OFFSET $3
            `,
            [subject.tenantId, limit, offset],
          );

    const subs =
      scopeType === "space"
        ? await app.db.query(
            `
              SELECT s.subscription_id, s.provider, s.status, s.last_run_at, s.updated_at, s.space_id, s.connector_instance_id,
                     ci.name AS connector_name,
                     (SELECT r.status FROM subscription_runs r WHERE r.subscription_id = s.subscription_id ORDER BY r.started_at DESC LIMIT 1) AS last_run_status,
                     (SELECT r.error_category FROM subscription_runs r WHERE r.subscription_id = s.subscription_id ORDER BY r.started_at DESC LIMIT 1) AS last_error_category
              FROM subscriptions s
              LEFT JOIN connector_instances ci ON ci.id = s.connector_instance_id
              WHERE s.tenant_id = $1 AND s.space_id = $2
              ORDER BY s.updated_at DESC
              LIMIT $3 OFFSET $4
            `,
            [subject.tenantId, scopeId, limit, offset],
          )
        : await app.db.query(
            `
              SELECT s.subscription_id, s.provider, s.status, s.last_run_at, s.updated_at, s.space_id, s.connector_instance_id,
                     ci.name AS connector_name,
                     (SELECT r.status FROM subscription_runs r WHERE r.subscription_id = s.subscription_id ORDER BY r.started_at DESC LIMIT 1) AS last_run_status,
                     (SELECT r.error_category FROM subscription_runs r WHERE r.subscription_id = s.subscription_id ORDER BY r.started_at DESC LIMIT 1) AS last_error_category
              FROM subscriptions s
              LEFT JOIN connector_instances ci ON ci.id = s.connector_instance_id
              WHERE s.tenant_id = $1
              ORDER BY s.updated_at DESC
              LIMIT $2 OFFSET $3
            `,
            [subject.tenantId, limit, offset],
          );
    const siem = await app.db.query(
      `
        SELECT d.id, d.name, d.enabled, d.updated_at,
               COALESCE((SELECT COUNT(1) FROM audit_siem_dlq q WHERE q.tenant_id = d.tenant_id AND q.destination_id = d.id), 0) AS dlq_count
        FROM audit_siem_destinations d
        WHERE d.tenant_id = $1
        ORDER BY d.updated_at DESC
        LIMIT $2 OFFSET $3
      `,
      [subject.tenantId, limit, offset],
    );

    const items: any[] = [];
    for (const r of oauth.rows as any[]) {
      items.push({
        integrationId: `oauth_grant:${r.grant_id}`,
        kind: "oauth_grant",
        name: `${String(r.provider)}@${String(r.connector_name ?? r.connector_instance_id)}`,
        status: String(r.status ?? ""),
        scopeType,
        scopeId,
        updatedAt: r.updated_at,
        links: { connectorInstanceId: String(r.connector_instance_id), provider: String(r.provider) },
      });
    }
    for (const r of subs.rows as any[]) {
      items.push({
        integrationId: `subscription:${r.subscription_id}`,
        kind: "subscription",
        name: `${String(r.provider)}${r.connector_name ? `@${String(r.connector_name)}` : ""}`,
        status: String(r.status ?? ""),
        lastRunAt: r.last_run_at,
        lastRunStatus: r.last_run_status ?? null,
        lastErrorCategory: r.last_error_category ?? null,
        scopeType,
        scopeId,
        updatedAt: r.updated_at,
        links: { subscriptionId: String(r.subscription_id), connectorInstanceId: r.connector_instance_id ? String(r.connector_instance_id) : null },
      });
    }
    for (const r of siem.rows as any[]) {
      items.push({
        integrationId: `siem_destination:${r.id}`,
        kind: "siem_destination",
        name: String(r.name ?? ""),
        status: r.enabled ? "enabled" : "disabled",
        dlqCount: Number(r.dlq_count ?? 0),
        scopeType: "tenant",
        scopeId: subject.tenantId,
        updatedAt: r.updated_at,
        links: { destinationId: String(r.id) },
      });
    }

    items.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    req.ctx.audit!.outputDigest = { count: items.length, scopeType, scopeId };
    return { scopeType, scopeId, items };
  });

  app.get("/governance/integrations/:integrationId", async (req, reply) => {
    const subject = req.ctx.subject!;
    const params = z.object({ integrationId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const raw = params.integrationId;
    const idx = raw.indexOf(":");
    if (idx < 0) throw Errors.badRequest("integrationId 无效");
    const kind = raw.slice(0, idx);
    const id = raw.slice(idx + 1);

    if (kind === "subscription") {
      const sRes = await app.db.query(
        `
          SELECT s.*, ci.name AS connector_name
          FROM subscriptions s
          LEFT JOIN connector_instances ci ON ci.id = s.connector_instance_id
          WHERE s.tenant_id = $1 AND s.subscription_id = $2::uuid
          LIMIT 1
        `,
        [subject.tenantId, id],
      );
      if (!sRes.rowCount) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Integration 不存在", "en-US": "Integration not found" }, traceId: req.ctx.traceId });
      const rRes = await app.db.query(
        `
          SELECT *
          FROM subscription_runs
          WHERE tenant_id = $1 AND subscription_id = $2::uuid
          ORDER BY started_at DESC
          LIMIT 50
        `,
        [subject.tenantId, id],
      );
      return { kind, integrationId: raw, integration: sRes.rows[0], runs: rRes.rows };
    }
    if (kind === "oauth_grant") {
      const gRes = await app.db.query(
        `
          SELECT g.*, ci.name AS connector_name, ci.type_name AS connector_type
          FROM oauth_grants g
          JOIN connector_instances ci ON ci.id = g.connector_instance_id
          WHERE g.tenant_id = $1 AND g.grant_id = $2::uuid
          LIMIT 1
        `,
        [subject.tenantId, id],
      );
      if (!gRes.rowCount) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Integration 不存在", "en-US": "Integration not found" }, traceId: req.ctx.traceId });
      const g: any = gRes.rows[0];
      const sRes = await app.db.query(
        `
          SELECT *
          FROM oauth_states
          WHERE tenant_id = $1 AND connector_instance_id = $2::uuid AND provider = $3
          ORDER BY created_at DESC
          LIMIT 50
        `,
        [subject.tenantId, g.connector_instance_id, g.provider],
      );
      return { kind, integrationId: raw, integration: g, states: sRes.rows };
    }
    if (kind === "siem_destination") {
      const dRes = await app.db.query(`SELECT * FROM audit_siem_destinations WHERE tenant_id = $1 AND id = $2::uuid LIMIT 1`, [subject.tenantId, id]);
      if (!dRes.rowCount) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Integration 不存在", "en-US": "Integration not found" }, traceId: req.ctx.traceId });
      const dlq = await app.db.query(
        `
          SELECT id, event_id, event_ts, attempts, last_error_digest, created_at
          FROM audit_siem_dlq
          WHERE tenant_id = $1 AND destination_id = $2::uuid
          ORDER BY created_at DESC
          LIMIT 50
        `,
        [subject.tenantId, id],
      );
      const outbox = await app.db.query(
        `
          SELECT id, event_id, event_ts, attempts, next_attempt_at, last_error_digest, created_at, updated_at
          FROM audit_siem_outbox
          WHERE tenant_id = $1 AND destination_id = $2::uuid
          ORDER BY next_attempt_at ASC, event_ts ASC
          LIMIT 50
        `,
        [subject.tenantId, id],
      );
      return { kind, integrationId: raw, integration: dRes.rows[0], outbox: outbox.rows, dlq: dlq.rows };
    }
    throw Errors.badRequest("integrationId kind 不支持");
  });

  app.get("/governance/collab-runs/:collabRunId/diagnostics", async (req, reply) => {
    const params = z.object({ collabRunId: z.string().uuid() }).parse(req.params);
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    setAuditContext(req, { resourceType: "agent_runtime", action: "collab.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "agent_runtime", action: "collab.read" });

    const collab = await getCollabRun({ pool: app.db, tenantId: subject.tenantId, collabRunId: params.collabRunId });
    if (!collab) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "CollabRun 不存在", "en-US": "CollabRun not found" }, traceId: req.ctx.traceId });
    if (collab.spaceId && collab.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const q = req.query as any;
    const correlationId = z.string().min(1).max(200).optional().parse(q?.correlationId) ?? null;

    const agg = await app.db.query(
      `
        SELECT COALESCE(actor_role,'') AS actor_role, type, COUNT(*)::int AS c
        FROM collab_run_events
        WHERE tenant_id = $1 AND collab_run_id = $2
        GROUP BY COALESCE(actor_role,''), type
      `,
      [subject.tenantId, collab.collabRunId],
    );

    const byRole = new Map<string, any>();
    function ensureRole(roleName: string) {
      const k = roleName || "(none)";
      const cur = byRole.get(k);
      if (cur) return cur;
      const v = { roleName: k, stepsStarted: 0, stepsCompleted: 0, stepsFailed: 0, blocked: 0, needsApproval: 0, singleWriterViolations: 0 };
      byRole.set(k, v);
      return v;
    }

    for (const r of agg.rows as any[]) {
      const role = String(r.actor_role ?? "");
      const type = String(r.type ?? "");
      const c = Number(r.c ?? 0);
      const slot = ensureRole(role);
      if (type === "collab.step.started") slot.stepsStarted += c;
      if (type === "collab.step.completed") slot.stepsCompleted += c;
      if (type === "collab.step.failed") slot.stepsFailed += c;
      if (type === "collab.policy.denied" || type === "collab.budget.exceeded") slot.blocked += c;
      if (type === "collab.run.needs_approval") slot.needsApproval += c;
      if (type === "collab.single_writer.violation") slot.singleWriterViolations += c;
    }

    const issues = await app.db.query(
      `
        SELECT type, actor_role, payload_digest, policy_snapshot_ref, correlation_id, created_at
        FROM collab_run_events
        WHERE tenant_id = $1 AND collab_run_id = $2
          AND type IN ('collab.step.failed','collab.policy.denied','collab.budget.exceeded','collab.single_writer.violation')
        ORDER BY created_at DESC
        LIMIT 20
      `,
      [subject.tenantId, collab.collabRunId],
    );

    const recentIssues = (issues.rows as any[]).map((x) => ({
      type: String(x.type ?? ""),
      actorRole: x.actor_role ? String(x.actor_role) : null,
      payloadDigest: x.payload_digest ?? null,
      policySnapshotRef: x.policy_snapshot_ref ? String(x.policy_snapshot_ref) : null,
      correlationId: x.correlation_id ? String(x.correlation_id) : null,
      createdAt: String(x.created_at ?? ""),
    }));

    const roles = Array.from(byRole.values()).sort((a, b) => String(a.roleName).localeCompare(String(b.roleName)));
    req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, roleCount: roles.length, issueCount: recentIssues.length };

    if (correlationId) {
      const corrEvents = await app.db.query(
        `
          SELECT type, actor_role, run_id, step_id, payload_digest, policy_snapshot_ref, correlation_id, created_at
          FROM collab_run_events
          WHERE tenant_id = $1 AND collab_run_id = $2 AND correlation_id = $3
          ORDER BY created_at DESC
          LIMIT 50
        `,
        [subject.tenantId, collab.collabRunId, correlationId],
      );
      const correlatedEvents = (corrEvents.rows as any[]).map((x) => ({
        type: String(x.type ?? ""),
        actorRole: x.actor_role ? String(x.actor_role) : null,
        runId: x.run_id ? String(x.run_id) : null,
        stepId: x.step_id ? String(x.step_id) : null,
        payloadDigest: x.payload_digest ?? null,
        policySnapshotRef: x.policy_snapshot_ref ? String(x.policy_snapshot_ref) : null,
        correlationId: x.correlation_id ? String(x.correlation_id) : null,
        createdAt: String(x.created_at ?? ""),
      }));

      const corrEnvs = await app.db.query(
        `
          SELECT envelope_id, task_id, from_role, to_role, broadcast, kind, payload_digest, policy_snapshot_ref, correlation_id, created_at
          FROM collab_envelopes
          WHERE tenant_id = $1 AND collab_run_id = $2 AND correlation_id = $3
          ORDER BY created_at DESC
          LIMIT 50
        `,
        [subject.tenantId, collab.collabRunId, correlationId],
      );
      const correlatedEnvelopes = (corrEnvs.rows as any[]).map((x) => ({
        envelopeId: String(x.envelope_id ?? ""),
        taskId: String(x.task_id ?? ""),
        fromRole: String(x.from_role ?? ""),
        toRole: x.to_role ? String(x.to_role) : null,
        broadcast: Boolean(x.broadcast),
        kind: String(x.kind ?? ""),
        payloadDigest: x.payload_digest ?? null,
        policySnapshotRef: x.policy_snapshot_ref ? String(x.policy_snapshot_ref) : null,
        correlationId: x.correlation_id ? String(x.correlation_id) : null,
        createdAt: String(x.created_at ?? ""),
      }));

      return {
        collabRunId: collab.collabRunId,
        status: collab.status,
        roles,
        recentIssues,
        correlation: { correlationId, correlatedEnvelopeCount: correlatedEnvelopes.length, correlatedEventCount: correlatedEvents.length },
        correlatedEnvelopes,
        correlatedEvents,
      };
    }

    return { collabRunId: collab.collabRunId, status: collab.status, roles, recentIssues };
  });
};
