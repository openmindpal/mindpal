import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { checkCapabilityEnvelopeNotExceedV1, normalizeNetworkPolicyV1, normalizeRuntimeLimitsV1, validateCapabilityEnvelopeV1 } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { insertAuditEvent } from "../modules/audit/auditRepo";
import { enqueueAuditOutboxForRequest } from "../modules/audit/requestOutbox";
import { toolPublishSchema } from "../modules/tools/toolModel";
import { getToolDefinition, getToolVersionByRef, listToolDefinitions, listToolVersions, publishToolVersion } from "../modules/tools/toolRepo";
import { resolveEffectiveToolRef } from "../modules/tools/resolve";
import { assertManifestConsistent, computeDepsDigest, loadSkillManifest, parseTrustedSkillPublicKeys, resolveArtifactDir, verifySkillManifestTrustWithKeys } from "../modules/tools/skillPackage";
import { computeSkillSbomV1, resolveSkillArtifactDir, scanSkillDependencies } from "../modules/tools/skillArtifactRegistry";
import { toolSbomOk, toolScanOk, toolTrustOk } from "../modules/tools/supplyGate";
import { validateToolInput } from "../modules/tools/validate";
import { createJobRunStep, getRunForSpace, listSteps } from "../modules/workflow/jobRepo";
import { createApproval } from "../modules/workflow/approvalRepo";
import { getActiveToolOverride, getActiveToolRef, isToolEnabled, listActiveToolOverrides, listActiveToolRefs } from "../modules/governance/toolGovernanceRepo";
import { getEffectiveToolLimit } from "../modules/governance/limitsRepo";
import { getEnabledSkillRuntimeRunner, listActiveSkillTrustedKeys } from "../modules/governance/skillRuntimeRepo";
import { extractTextForPromptInjectionScan, getPromptInjectionDenyTargetsFromEnv, getPromptInjectionModeFromEnv, scanPromptInjection, shouldDenyPromptInjectionForTarget, summarizePromptInjection } from "../modules/safety/promptInjectionGuard";
import { getEffectiveToolNetworkPolicy } from "../modules/governance/toolNetworkPolicyRepo";
import { sha256Hex } from "../modules/notifications/digest";

export const toolRoutes: FastifyPluginAsync = async (app) => {
  function networkPolicyDigest(allowedDomains: string[], rules: any[] | null) {
    const canon = allowedDomains.map((d) => d.trim()).filter(Boolean).sort();
    const rulesCanon = Array.isArray(rules) ? rules : [];
    return {
      allowedDomainsCount: canon.length,
      sha256_8: sha256Hex(canon.join("\n")).slice(0, 8),
      rulesCount: rulesCanon.length,
      rulesSha256_8: sha256Hex(JSON.stringify(rulesCanon)).slice(0, 8),
    };
  }

  function isValidUrl(u: string) {
    try {
      new URL(u);
      return true;
    } catch {
      return false;
    }
  }

  app.get("/tools", async (req) => {
    setAuditContext(req, { resourceType: "tool", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const tools = await listToolDefinitions(app.db, subject.tenantId);
    const actives = await listActiveToolRefs({ pool: app.db, tenantId: subject.tenantId });
    const map = new Map(actives.map((a) => [a.name, a.activeToolRef]));
    const overrides = subject.spaceId ? await listActiveToolOverrides({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId }) : [];
    const oMap = new Map(overrides.map((o) => [o.name, o.activeToolRef]));
    return {
      tools: tools.map((t) => {
        const activeToolRef = map.get(t.name) ?? null;
        const effectiveActiveToolRef = oMap.get(t.name) ?? activeToolRef;
        return { ...t, activeToolRef, effectiveActiveToolRef };
      }),
    };
  });

  app.get("/tools/:name", async (req, reply) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "tool", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const def = await getToolDefinition(app.db, subject.tenantId, params.name);
    if (!def) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "工具不存在", "en-US": "Tool not found" }, traceId: req.ctx.traceId });
    const versions = await listToolVersions(app.db, subject.tenantId, params.name);
    const active = await getActiveToolRef({ pool: app.db, tenantId: subject.tenantId, name: params.name });
    const activeToolRef = active?.activeToolRef ?? null;
    const override = subject.spaceId ? await getActiveToolOverride({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: params.name }) : null;
    const effectiveActiveToolRef = override?.activeToolRef ?? activeToolRef;
    return { tool: { ...def, activeToolRef, effectiveActiveToolRef }, versions };
  });

  app.post("/tools/:name/publish", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "tool", action: "publish", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "tool", action: "publish" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const publish = toolPublishSchema.parse(req.body);

    const existing = await getToolDefinition(app.db, subject.tenantId, params.name);
    const scope = publish.scope ?? existing?.scope ?? null;
    const resourceType = publish.resourceType ?? existing?.resourceType ?? null;
    const action = publish.action ?? existing?.action ?? null;
    const idempotencyRequired = publish.idempotencyRequired ?? existing?.idempotencyRequired ?? null;
    if (!scope) throw Errors.badRequest("缺少 scope");
    if (!resourceType) throw Errors.badRequest("缺少 resourceType");
    if (!action) throw Errors.badRequest("缺少 action");
    if (idempotencyRequired === null) throw Errors.badRequest("缺少 idempotencyRequired");

    const riskLevel = publish.riskLevel ?? existing?.riskLevel ?? "low";
    const approvalRequired = publish.approvalRequired ?? existing?.approvalRequired ?? false;
    let depsDigest = publish.depsDigest;
    const artifactRef = publish.artifactId ? `artifact:${publish.artifactId}` : publish.artifactRef;
    let scanSummary: any = null;
    let trustSummary: any = null;
    let sbomSummary: any = null;
    let sbomDigest: string | null = null;
    const hasArtifactChange = Boolean(publish.artifactId || publish.artifactRef || publish.depsDigest);
    if (artifactRef) {
      try {
        const artifactDir = publish.artifactId ? resolveSkillArtifactDir(publish.artifactId) : resolveArtifactDir(artifactRef);
        const loaded = await loadSkillManifest(artifactDir);
        assertManifestConsistent({
          toolName: params.name,
          expectedContract: { scope, resourceType, action, idempotencyRequired: Boolean(idempotencyRequired), riskLevel, approvalRequired: Boolean(approvalRequired) },
          expectedSchemas: { inputSchema: publish.inputSchema, outputSchema: publish.outputSchema },
          manifest: loaded.manifest,
        });
        if (!depsDigest) depsDigest = await computeDepsDigest({ artifactDir, manifest: loaded.manifest });
        if (depsDigest && publish.depsDigest && depsDigest !== publish.depsDigest) throw new Error("depsDigest 不匹配");
        const activeKeys = await listActiveSkillTrustedKeys({ pool: app.db as any, tenantId: subject.tenantId });
        const keyIdToPem: Record<string, string> = {};
        for (const k of activeKeys) keyIdToPem[k.keyId] = k.publicKeyPem;
        const trustedKeys = parseTrustedSkillPublicKeys({ keyIdToPem });
        const trust = verifySkillManifestTrustWithKeys({ toolName: params.name, depsDigest, manifest: loaded.manifest, trustedKeys });
        trustSummary = {
          status: trust.status,
          reason: (trust as any).reason ?? null,
          signature: loaded.manifest?.signature ? { alg: loaded.manifest.signature.alg, keyId: loaded.manifest.signature.keyId, signedDigest: loaded.manifest.signature.signedDigest } : null,
          verifiedAt: new Date().toISOString(),
        };
        if (trust.status === "untrusted") {
          req.ctx.audit!.errorCategory = "policy_violation";
          throw Errors.trustNotVerified();
        }
        scanSummary = await scanSkillDependencies({ artifactDir });
        const mode = String(scanSummary?.mode ?? "").toLowerCase();
        const status = String(scanSummary?.status ?? "").toLowerCase();
        const vulns = scanSummary?.vulnerabilities ?? null;
        const crit = Number(vulns?.critical ?? 0) || 0;
        const high = Number(vulns?.high ?? 0) || 0;
        if (mode === "deny") {
          if (status === "error") {
            req.ctx.audit!.errorCategory = "policy_violation";
            throw Errors.scanNotPassed();
          }
          if (status === "ok" && (crit > 0 || high > 0)) {
            req.ctx.audit!.errorCategory = "policy_violation";
            throw Errors.scanNotPassed();
          }
        }
        const sb = await computeSkillSbomV1({ artifactDir, depsDigest, manifestSummary: { toolName: params.name, depsDigest, artifactRef } });
        sbomSummary = sb.sbomSummary;
        sbomDigest = sb.sbomDigest;
      } catch (e: any) {
        if (e && typeof e === "object" && "errorCode" in e) throw e;
        throw Errors.badRequest(String(e?.message ?? e));
      }
    }

    if (
      !publish.inputSchema &&
      !publish.outputSchema &&
      !publish.displayName &&
      !publish.description &&
      !publish.scope &&
      !publish.resourceType &&
      !publish.action &&
      publish.idempotencyRequired === undefined &&
      !publish.riskLevel &&
      publish.approvalRequired === undefined &&
      !hasArtifactChange
    ) {
      throw Errors.badRequest("发布内容为空");
    }

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const version = await publishToolVersion({
        pool: client,
        tenantId: subject.tenantId,
        name: params.name,
        publish: { ...publish, depsDigest, artifactRef, scanSummary, trustSummary, sbomSummary, sbomDigest: sbomDigest ?? undefined },
      });
      req.ctx.audit!.outputDigest = { toolRef: version.toolRef, name: version.name, version: version.version };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { toolRef: version.toolRef, version };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });

  app.get("/tools/versions/:toolRef", async (req, reply) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "tool", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const ver = await getToolVersionByRef(app.db, subject.tenantId, params.toolRef);
    if (!ver) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "工具版本不存在", "en-US": "Tool version not found" }, traceId: req.ctx.traceId });
    return { version: ver };
  });

  app.post("/tools/:toolRef/execute", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const rawToolRef = params.toolRef;

    const idx = rawToolRef.lastIndexOf("@");
    const toolName = idx > 0 ? rawToolRef.slice(0, idx) : rawToolRef;
    const toolRef =
      idx > 0
        ? rawToolRef
        : await resolveEffectiveToolRef({ pool: app.db, tenantId: req.ctx.subject!.tenantId, spaceId: req.ctx.subject!.spaceId, name: toolName });
    if (!toolRef) throw Errors.badRequest("工具版本不存在");

    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined) ??
      null;

    setAuditContext(req, { resourceType: "tool", action: "execute", toolRef, idempotencyKey: idempotencyKey ?? undefined });
    const decision = await requirePermission({ req, resourceType: "tool", action: "execute" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const ver = await getToolVersionByRef(app.db, subject.tenantId, toolRef);
    if (!ver) throw Errors.badRequest("工具版本不存在");

    if (!["entity.create", "entity.update", "entity.delete", "memory.read", "memory.write", "knowledge.search"].includes(toolName)) {
      if (!ver.artifactRef) {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.forbidden();
      }
    }

    if (toolName === "memory.read") {
      await requirePermission({ req, resourceType: "memory", action: "read" });
    }
    if (toolName === "memory.write") {
      await requirePermission({ req, resourceType: "memory", action: "write" });
    }

    const enabled = await isToolEnabled({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, toolRef });
    if (!enabled) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.toolDisabled();
    }

    let supplyChainGate: any = null;
    if (ver.artifactRef) {
      const t = toolTrustOk((ver as any).trustSummary);
      const s = toolScanOk((ver as any).scanSummary);
      const b = toolSbomOk({ sbomSummary: (ver as any).sbomSummary, sbomDigest: (ver as any).sbomDigest });
      const minIsoRaw = String(process.env.SKILL_ISOLATION_MIN ?? "").trim().toLowerCase();
      const minIsolation = minIsoRaw === "remote" ? "remote" : minIsoRaw === "container" ? "container" : "process";
      const override = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
      const envRunnerOk = override ? isValidUrl(override) : false;
      const dbRunner = minIsolation === "remote" && !envRunnerOk ? await getEnabledSkillRuntimeRunner({ pool: app.db as any, tenantId: subject.tenantId }) : null;
      const remoteRunnerOk = minIsolation !== "remote" ? true : Boolean(envRunnerOk || dbRunner);
      supplyChainGate = {
        trust: { required: t.required, status: t.status, ok: t.ok },
        scan: { required: s.required, mode: s.mode, status: s.status, ok: s.ok, vulnerabilities: s.vulnerabilities ?? null },
        sbom: { required: b.required, mode: b.mode, status: b.status, ok: b.ok, hasDigest: b.hasDigest },
        isolation: { minIsolation, remoteRunnerOk, ok: minIsolation !== "remote" ? true : remoteRunnerOk },
      };
      if (!t.ok) {
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { supplyChainGate };
        throw Errors.trustNotVerified();
      }
      if (!s.ok) {
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { supplyChainGate };
        throw Errors.scanNotPassed();
      }
      if (!b.ok) {
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { supplyChainGate };
        throw Errors.sbomNotPresent();
      }
      if (minIsolation === "remote" && !remoteRunnerOk) {
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { supplyChainGate };
        throw Errors.isolationRequired();
      }
    }

    const body = req.body as any;
    let input = body;
    let limits: any = null;
    let capabilityEnvelope: any = null;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      limits = body.limits ?? null;
      capabilityEnvelope = body.capabilityEnvelope ?? null;
      input = { ...body };
      delete (input as any).limits;
      delete (input as any).networkPolicy;
      delete (input as any).capabilityEnvelope;
    }

    const piMode = getPromptInjectionModeFromEnv();
    const piDenyTargets = getPromptInjectionDenyTargetsFromEnv();
    const piTarget = "tool:execute";
    const piText = extractTextForPromptInjectionScan(input);
    const piScan = scanPromptInjection(piText);
    const piDenied = shouldDenyPromptInjectionForTarget({ scan: piScan, mode: piMode, target: piTarget, denyTargets: piDenyTargets });
    const piSummary = summarizePromptInjection(piScan, piMode, piTarget, piDenied);
    if (piDenied) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { safetySummary: { decision: "denied", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary } };
      throw Errors.safetyPromptInjectionDenied();
    }

    validateToolInput(ver.inputSchema, input);

    if (!limits || typeof limits !== "object" || Array.isArray(limits)) limits = {};
    if (limits.maxConcurrency === undefined) {
      const tl = await getEffectiveToolLimit({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, toolRef });
      if (tl) limits.maxConcurrency = tl.defaultMaxConcurrency;
    }

    const def = await getToolDefinition(app.db, subject.tenantId, toolName);
    const scope = def?.scope ?? null;
    const resourceType = def?.resourceType ?? null;
    const action = def?.action ?? null;
    const idempotencyRequired = def?.idempotencyRequired ?? null;
    if (!scope || !resourceType || !action || idempotencyRequired === null) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("工具契约缺失");
    }

    const opDecision = await requirePermission({ req, resourceType, action });

    if (scope === "write" && !idempotencyKey) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("缺少 idempotency-key");
    }

    const effPol = await getEffectiveToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, toolRef });
    const effAllowedDomains = effPol?.allowedDomains ?? [];
    const effRules = (effPol as any)?.rules ?? [];
    const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };

    if (!capabilityEnvelope) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { capabilityEnvelope: { status: "missing" } };
      throw Errors.badRequest("缺少 capabilityEnvelope");
    }
    const parsed = validateCapabilityEnvelopeV1(capabilityEnvelope);
    if (!parsed.ok) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { capabilityEnvelope: { status: "invalid" } };
      throw Errors.badRequest("capabilityEnvelope 不合法");
    }
    const effLimits = normalizeRuntimeLimitsV1(limits);
    const effectiveEnvelope: CapabilityEnvelopeV1 = {
      format: "capabilityEnvelope.v1",
      dataDomain: {
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        subjectId: subject.subjectId ?? null,
        toolContract: {
          scope,
          resourceType,
          action,
          fieldRules: (opDecision as any).fieldRules ?? null,
          rowFilters: (opDecision as any).rowFilters ?? null,
        },
      },
      secretDomain: { connectorInstanceIds: [] },
      egressDomain: { networkPolicy: normalizeNetworkPolicyV1(effNetworkPolicy) },
      resourceDomain: { limits: effLimits },
    };
    const subset = checkCapabilityEnvelopeNotExceedV1({ envelope: parsed.envelope, effective: effectiveEnvelope });
    if (!subset.ok) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { capabilityEnvelope: { status: "not_subset", reason: subset.reason } };
      throw Errors.badRequest("capabilityEnvelope 不得扩大权限");
    }

    const finalEnvelope = parsed.envelope;
    const finalLimits = finalEnvelope.resourceDomain.limits;
    const finalNetworkPolicy = finalEnvelope.egressDomain.networkPolicy;
    const effNetDigest = networkPolicyDigest(finalNetworkPolicy.allowedDomains, finalNetworkPolicy.rules ?? null);

    const { job, run, step } = await createJobRunStep({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "tool.execute",
      toolRef,
      policySnapshotRef: opDecision.snapshotRef,
      idempotencyKey: idempotencyKey ?? undefined,
      createdBySubjectId: subject.subjectId,
      trigger: "manual",
      masterKey: app.cfg.secrets.masterKey,
      input: {
        toolRef,
        idempotencyKey: idempotencyKey ?? undefined,
        toolContract: {
          scope,
          resourceType,
          action,
          idempotencyRequired,
          riskLevel: def?.riskLevel,
          approvalRequired: def?.approvalRequired,
          fieldRules: finalEnvelope.dataDomain.toolContract.fieldRules ?? null,
          rowFilters: finalEnvelope.dataDomain.toolContract.rowFilters ?? null,
        },
        input,
        limits: finalLimits,
        networkPolicy: finalNetworkPolicy,
        capabilityEnvelope: finalEnvelope,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        traceId: req.ctx.traceId,
      },
    });

    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: step.stepId }, status: "queued" as const };

    const approvalRequired = Boolean(def?.approvalRequired) || def?.riskLevel === "high";
    if (approvalRequired) {
      await app.db.query("UPDATE runs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, run.runId]);
      await app.db.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [subject.tenantId, job.jobId]);
      const approval = await createApproval({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        runId: run.runId,
        stepId: step.stepId,
        requestedBySubjectId: subject.subjectId,
        toolRef,
        policySnapshotRef: opDecision.snapshotRef ?? null,
        inputDigest: step.inputDigest ?? null,
      });
      await insertAuditEvent(app.db, {
        subjectId: subject.subjectId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        resourceType: "workflow",
        action: "approval.requested",
        policyDecision: opDecision,
        inputDigest: { approvalId: approval.approvalId, toolRef },
        outputDigest: { status: "pending", runId: run.runId, stepId: step.stepId },
        idempotencyKey: idempotencyKey ?? undefined,
        result: "success",
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
        runId: run.runId,
        stepId: step.stepId,
      });
      req.ctx.audit!.outputDigest = {
        status: "needs_approval",
        approvalId: approval.approvalId,
        toolRef,
        runId: run.runId,
        stepId: step.stepId,
        safetySummary: { decision: "allowed", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
        runtimePolicy: { networkPolicyDigest: effNetDigest },
        supplyChainGate,
      };
      return { jobId: job.jobId, runId: run.runId, stepId: step.stepId, approvalId: approval.approvalId, receipt: { ...receipt, status: "needs_approval" as const } };
    }

    await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    req.ctx.audit!.outputDigest = {
      status: "queued",
      toolRef,
      runId: run.runId,
      stepId: step.stepId,
      safetySummary: { decision: "allowed", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
      runtimePolicy: { networkPolicyDigest: effNetDigest },
      supplyChainGate,
    };
    return { jobId: job.jobId, runId: run.runId, stepId: step.stepId, receipt };
  });

  app.get("/tools/runs/:runId", async (req, reply) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "tool", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
    const steps = await listSteps(app.db, run.runId);
    return { run, steps };
  });

  app.get("/tools/steps/:stepId", async (req, reply) => {
    const params = z.object({ stepId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "tool", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });
    const res = await app.db.query(
      `
        SELECT s.*, r.tenant_id
        FROM steps s
        JOIN runs r ON r.run_id = s.run_id
        WHERE s.step_id = $1 AND r.tenant_id = $2 AND (s.input->>'spaceId') = $3
        LIMIT 1
      `,
      [params.stepId, subject.tenantId, subject.spaceId],
    );
    if (res.rowCount === 0) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Step 不存在", "en-US": "Step not found" }, traceId: req.ctx.traceId });
    const step = res.rows[0];
    return {
      step: {
        stepId: step.step_id,
        runId: step.run_id,
        seq: step.seq,
        status: step.status,
        attempt: step.attempt,
        toolRef: step.tool_ref,
        inputDigest: step.input_digest,
        outputDigest: step.output_digest,
        errorCategory: step.error_category,
        lastError: step.last_error,
        createdAt: step.created_at,
        updatedAt: step.updated_at,
      },
    };
  });
};
