import type { Pool } from "pg";
import { validateCapabilityEnvelopeV1 } from "@openslin/shared";
import { acquireWriteLease, releaseWriteLease } from "../writeLease";
import { writeAudit } from "./audit";
import { executeBuiltinTool } from "./builtinTools";
import { digestObject, isPlainObject, jsonByteLength, scrubBySchema, stableStringify, sha256Hex, validateBySchema } from "./common";
import { decryptStepInputIfNeeded, encryptStepOutputAndCompensation } from "./encryption";
import { createArtifact } from "./entity";
import { executeDynamicSkill } from "./dynamicSkill";
import { handleEntityExportJob, handleEntityImportJob, handleSchemaMigrationJob, handleSpaceBackupJob, handleSpaceRestoreJob } from "./jobHandlers";
import type { EgressEvent } from "./runtime";
import { normalizeLimits, normalizeNetworkPolicy, withConcurrency, withTimeout } from "./runtime";
import { computeEvidenceDigestV1, computeSealedDigestV1, deriveIsolation } from "./sealed";
import { buildSafeToolOutput, computeWriteLeaseResourceRef, isWriteLeaseTool, loadToolVersion, parseToolRef } from "./tooling";

function sbomMode() {
  const raw = String(process.env.SKILL_SBOM_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off" as const;
  if (raw === "audit_only") return "audit_only" as const;
  if (raw === "deny") return "deny" as const;
  return "audit_only" as const;
}

function isSideEffectWriteToolName(toolName: string) {
  return toolName === "entity.create" || toolName === "entity.update" || toolName === "entity.delete" || toolName === "memory.write" || toolName === "entity.import" || toolName === "space.restore";
}

async function sealRunIfFinished(params: { pool: Pool; runId: string }) {
  const res = await params.pool.query("SELECT tenant_id, status, tool_ref, policy_snapshot_ref, input_digest FROM runs WHERE run_id = $1 LIMIT 1", [params.runId]);
  if (!res.rowCount) return;
  const r = res.rows[0];
  const status = String(r.status ?? "");
  if (!(status === "succeeded" || status === "failed" || status === "canceled" || status === "compensated")) return;
  const stepsRes = await params.pool.query(
    "SELECT seq, tool_ref, sealed_output_digest, error_category FROM steps WHERE run_id = $1 ORDER BY seq ASC",
    [params.runId],
  );
  const steps = stepsRes.rows.map((x: any) => ({
    seq: Number(x.seq ?? 0) || 0,
    toolRef: x.tool_ref ? String(x.tool_ref) : null,
    sealedOutputDigest: x.sealed_output_digest ?? null,
    errorCategory: x.error_category ?? null,
  }));
  const sealedInputDigest = computeSealedDigestV1(r.input_digest ?? null);
  const sealedOutputDigest = computeSealedDigestV1({ status, toolRef: r.tool_ref ?? null, policySnapshotRef: r.policy_snapshot_ref ?? null, steps });
  await params.pool.query(
    `
      UPDATE runs
      SET sealed_at = COALESCE(sealed_at, now()),
          sealed_schema_version = COALESCE(sealed_schema_version, 1),
          sealed_input_digest = COALESCE(sealed_input_digest, $2),
          sealed_output_digest = COALESCE(sealed_output_digest, $3),
          nondeterminism_policy = COALESCE(nondeterminism_policy, $4),
          updated_at = now()
      WHERE run_id = $1
    `,
    [params.runId, sealedInputDigest, sealedOutputDigest, { ignoredJsonPaths: ["latencyMs"] }],
  );
}

export async function processStep(params: { pool: Pool; jobId: string; runId: string; stepId: string }) {
  const stepRes = await params.pool.query("SELECT * FROM steps WHERE step_id = $1 LIMIT 1", [params.stepId]);
  if (stepRes.rowCount === 0) throw new Error("step_not_found");
  const step = stepRes.rows[0];

  const jobRes = await params.pool.query("SELECT job_type FROM jobs WHERE job_id = $1 LIMIT 1", [params.jobId]);
  if (jobRes.rowCount === 0) throw new Error("job_not_found");
  const jobType = String(jobRes.rows[0].job_type ?? "");

  const runRes = await params.pool.query("SELECT * FROM runs WHERE run_id = $1 LIMIT 1", [params.runId]);
  if (runRes.rowCount === 0) throw new Error("run_not_found");
  const run = runRes.rows[0];
  const tenantId = String(run.tenant_id ?? "");
  const isComp = String(run.trigger ?? "") === "compensate";

  async function updateCompensationStatus(status: string) {
    if (!isComp || !tenantId) return;
    await params.pool.query("UPDATE workflow_step_compensations SET status = $3, updated_at = now() WHERE tenant_id = $1 AND compensation_run_id = $2", [
      tenantId,
      params.runId,
      status,
    ]);
  }

  const runStatus = String(run.status ?? "");
  if (runStatus === "needs_approval") {
    await params.pool.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE job_id = $1", [params.jobId]);
    await params.pool.query("UPDATE steps SET status = 'pending', updated_at = now() WHERE step_id = $1 AND status <> 'succeeded'", [params.stepId]);
    return;
  }

  if (runStatus === "canceled") {
    await updateCompensationStatus("canceled");
    await params.pool.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1", [
      params.stepId,
    ]);
    await params.pool.query("UPDATE jobs SET status = 'canceled', updated_at = now() WHERE job_id = $1", [params.jobId]);
    return;
  }

  const metaInput = step.input as any;
  const traceId = (metaInput?.traceId as string | undefined) ?? (metaInput?.trace_id as string | undefined) ?? "unknown";
  const toolRef = step.tool_ref as string | null;
  const seq = Number(step.seq ?? 0) || 0;
  const collabRunId = typeof metaInput?.collabRunId === "string" ? String(metaInput.collabRunId) : "";
  const taskId = typeof metaInput?.taskId === "string" ? String(metaInput.taskId) : "";
  const actorRole = typeof metaInput?.actorRole === "string" ? String(metaInput.actorRole) : null;
  const planStepId = typeof metaInput?.planStepId === "string" ? String(metaInput.planStepId) : null;
  const spaceIdFromMeta = metaInput?.spaceId ? String(metaInput.spaceId) : null;

  if (jobType === "schema.migration") {
    const inputDigest = digestObject(metaInput);
    await handleSchemaMigrationJob({
      pool: params.pool,
      jobId: params.jobId,
      runId: params.runId,
      stepId: params.stepId,
      traceId,
      tenantId: String(run.tenant_id ?? ""),
      spaceId: spaceIdFromMeta,
      subjectId: typeof metaInput?.subjectId === "string" ? String(metaInput.subjectId) : null,
      inputDigest,
      input: metaInput,
    });
    return;
  }

  async function appendCollabEventOnce(type: string, payloadDigest: any | null) {
    if (!collabRunId || !taskId) return;
    const tenantId = String(run.tenant_id ?? "");
    if (!tenantId) return;
    const ex = await params.pool.query("SELECT 1 FROM collab_run_events WHERE tenant_id = $1 AND collab_run_id = $2 AND type = $3 AND step_id = $4 LIMIT 1", [
      tenantId,
      collabRunId,
      type,
      params.stepId,
    ]);
    if (ex.rowCount) return;
    await params.pool.query(
      "INSERT INTO collab_run_events (tenant_id, space_id, collab_run_id, task_id, type, actor_role, run_id, step_id, payload_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [tenantId, spaceIdFromMeta, collabRunId, taskId, type, actorRole, params.runId, params.stepId, payloadDigest],
    );
  }

  await params.pool.query("UPDATE runs SET status = $2, started_at = COALESCE(started_at, now()), updated_at = now() WHERE run_id = $1", [
    params.runId,
    isComp ? "compensating" : "running",
  ]);
  const limits = normalizeLimits(metaInput?.limits);
  const networkPolicy = normalizeNetworkPolicy(metaInput?.networkPolicy);
  const parsedForDigest = toolRef ? parseToolRef(toolRef) : null;
  const sideEffectWrite =
    String(metaInput?.toolContract?.scope ?? "") === "write" || (parsedForDigest ? isSideEffectWriteToolName(parsedForDigest.name) : false);
  const inputDigest = {
    toolRef,
    limits,
    networkPolicy,
    sideEffectWrite,
    inputKeys: digestObject(metaInput),
  };
  const sealedInputDigest = computeSealedDigestV1(inputDigest);
  await params.pool.query(
    "UPDATE steps SET status = $2, attempt = attempt + 1, input_digest = COALESCE(input_digest, $3), started_at = COALESCE(started_at, now()), updated_at = now() WHERE step_id = $1",
    [params.stepId, isComp ? "compensating" : "running", inputDigest],
  );
  await updateCompensationStatus("running");
  try {
    await appendCollabEventOnce("collab.step.started", { toolRef, seq, planStepId });
  } catch {
  }

  const egress: EgressEvent[] = [];
  let rawInput = metaInput as any;
  try {
    if (!tenantId) throw new Error("missing_tenant_id");
    rawInput = await decryptStepInputIfNeeded({ pool: params.pool, tenantId, step, metaInput });
    const spaceId = rawInput?.spaceId ?? null;
    const subjectId = rawInput?.subjectId ? String(rawInput?.subjectId) : null;
    const capRaw = rawInput?.capabilityEnvelope ?? metaInput?.capabilityEnvelope ?? null;
    if (jobType === "tool.execute" || jobType === "agent.run") {
      if (!capRaw) {
        const e: any = new Error("policy_violation:capability_envelope_missing");
        e.capabilityEnvelopeSummary = { status: "missing" };
        throw e;
      }
      const parsed = validateCapabilityEnvelopeV1(capRaw);
      if (!parsed.ok) {
        const e: any = new Error("policy_violation:capability_envelope_invalid");
        e.capabilityEnvelopeSummary = { status: "invalid" };
        throw e;
      }
      const tc = rawInput?.toolContract;
      if (!tc || typeof tc !== "object" || Array.isArray(tc)) {
        const e: any = new Error("policy_violation:capability_envelope_mismatch:tool_contract_missing");
        e.capabilityEnvelopeSummary = { status: "mismatch", diffs: ["toolContract"] };
        throw e;
      }
      const spaceIdNorm = spaceId === null || spaceId === undefined ? null : String(spaceId);
      const subjectIdNorm = subjectId === null || subjectId === undefined ? null : String(subjectId);
      const expected = validateCapabilityEnvelopeV1({
        format: "capabilityEnvelope.v1",
        dataDomain: {
          tenantId,
          spaceId: spaceIdNorm,
          subjectId: subjectIdNorm,
          toolContract: {
            scope: String((tc as any).scope ?? ""),
            resourceType: String((tc as any).resourceType ?? ""),
            action: String((tc as any).action ?? ""),
            fieldRules: (tc as any).fieldRules ?? null,
            rowFilters: (tc as any).rowFilters ?? null,
          },
        },
        secretDomain: { connectorInstanceIds: [] },
        egressDomain: { networkPolicy },
        resourceDomain: { limits },
      });
      if (!expected.ok) {
        const e: any = new Error("policy_violation:capability_envelope_mismatch:expected_invalid");
        e.capabilityEnvelopeSummary = { status: "mismatch", diffs: ["expected"] };
        throw e;
      }
      const diffs: string[] = [];
      if (stableStringify(parsed.envelope.dataDomain) !== stableStringify(expected.envelope.dataDomain)) diffs.push("dataDomain");
      if (stableStringify(parsed.envelope.secretDomain) !== stableStringify(expected.envelope.secretDomain)) diffs.push("secretDomain");
      if (stableStringify(parsed.envelope.egressDomain) !== stableStringify(expected.envelope.egressDomain)) diffs.push("egressDomain");
      if (stableStringify(parsed.envelope.resourceDomain) !== stableStringify(expected.envelope.resourceDomain)) diffs.push("resourceDomain");
      if (diffs.length) {
        const e: any = new Error(`policy_violation:capability_envelope_mismatch:${diffs.join(",")}`);
        e.capabilityEnvelopeSummary = { status: "mismatch", diffs };
        throw e;
      }
    }

    if (jobType === "entity.export") {
      if (!spaceId) throw new Error("policy_violation:missing_space");
      await handleEntityExportJob({
        pool: params.pool,
        jobId: params.jobId,
        runId: params.runId,
        stepId: params.stepId,
        traceId,
        tenantId,
        spaceId,
        subjectId,
        inputDigest,
        input: rawInput,
      });
      return;
    }

    if (jobType === "entity.import") {
      if (!spaceId) throw new Error("policy_violation:missing_space");
      const idempotencyKey = (run.idempotency_key as string | null) ?? null;
      if (!idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
      await handleEntityImportJob({
        pool: params.pool,
        jobId: params.jobId,
        runId: params.runId,
        stepId: params.stepId,
        traceId,
        tenantId,
        spaceId,
        subjectId,
        idempotencyKey,
        inputDigest,
        input: rawInput,
      });
      return;
    }

    if (jobType === "space.backup") {
      if (!spaceId) throw new Error("policy_violation:missing_space");
      await handleSpaceBackupJob({
        pool: params.pool,
        jobId: params.jobId,
        runId: params.runId,
        stepId: params.stepId,
        traceId,
        tenantId,
        spaceId,
        subjectId,
        inputDigest,
        input: rawInput,
      });
      return;
    }

    if (jobType === "space.restore") {
      if (!spaceId) throw new Error("policy_violation:missing_space");
      await handleSpaceRestoreJob({
        pool: params.pool,
        jobId: params.jobId,
        runId: params.runId,
        stepId: params.stepId,
        traceId,
        tenantId,
        spaceId,
        subjectId,
        inputDigest,
        input: rawInput,
      });
      return;
    }

    if (!toolRef) throw new Error("missing_tool_ref");

    const parsed = parseToolRef(toolRef);
    if (!parsed) {
      const msg = `invalid_tool_ref:${toolRef}`;
      await params.pool.query("UPDATE steps SET status = 'failed', error_category = $2, last_error = $3, updated_at = now() WHERE step_id = $1", [
        params.stepId,
        "policy_violation",
        msg,
      ]);
      await params.pool.query("UPDATE runs SET status = 'failed', updated_at = now() WHERE run_id = $1", [params.runId]);
      await params.pool.query("UPDATE jobs SET status = 'failed', updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, { error: msg }]);
      await updateCompensationStatus("failed");
      await writeAudit(params.pool, { traceId, tenantId, spaceId, subjectId, runId: params.runId, stepId: params.stepId, toolRef, result: "error", inputDigest: digestObject(step.input), errorCategory: "policy_violation" });
      return;
    }

    const ver = await loadToolVersion(params.pool, tenantId, toolRef);
    if (!ver) {
      const msg = `tool_not_released:${toolRef}`;
      await params.pool.query("UPDATE steps SET status = 'failed', error_category = $2, last_error = $3, updated_at = now() WHERE step_id = $1", [
        params.stepId,
        "policy_violation",
        msg,
      ]);
      await params.pool.query("UPDATE runs SET status = 'failed', updated_at = now() WHERE run_id = $1", [params.runId]);
      await params.pool.query("UPDATE jobs SET status = 'failed', updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, { error: msg }]);
      await updateCompensationStatus("failed");
      await writeAudit(params.pool, { traceId, tenantId, spaceId, subjectId, runId: params.runId, stepId: params.stepId, toolRef, result: "error", inputDigest: digestObject(step.input), errorCategory: "policy_violation" });
      return;
    }

    const trustSummary = (ver as any).trust_summary ?? null;
    const scanSummary = (ver as any).scan_summary ?? null;

    const toolContract = rawInput?.toolContract ?? null;
    const fieldRules = toolContract?.fieldRules ?? null;
    const rowFilters = toolContract?.rowFilters ?? null;
    const idempotencyRequired = toolContract?.idempotencyRequired ?? ["entity.create", "entity.update", "entity.delete", "memory.write"].includes(parsed.name);
    let idempotencyKey = run.idempotency_key as string | null;
    if (jobType === "agent.run") {
      const ik = rawInput?.idempotencyKey;
      if (typeof ik === "string" && ik.trim()) idempotencyKey = ik;
    }
    const toolInput = rawInput?.input ?? {};

    if (idempotencyRequired && !idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
    const schemaName = toolInput?.schemaName ?? "core";

    const concurrencyKey = `${tenantId}:${toolRef}`;
    const startedAt = Date.now();

    let artifactRef: string | null = ver.artifact_ref ?? null;
    let depsDigest: string | null = ver.deps_digest ?? null;
    let runtimeBackend: string = artifactRef ? "process" : "builtin";
    let degraded = false;

    if (artifactRef) {
      const trustStatus = String((trustSummary as any)?.status ?? "unknown").toLowerCase();
      if (trustStatus === "untrusted") throw new Error("policy_violation:trust_not_verified");
      const mode = String((scanSummary as any)?.mode ?? "").toLowerCase();
      const status = String((scanSummary as any)?.status ?? "").toLowerCase();
      const vulns = (scanSummary as any)?.vulnerabilities ?? null;
      const crit = Number((vulns as any)?.critical ?? 0) || 0;
      const high = Number((vulns as any)?.high ?? 0) || 0;
      if (mode === "deny") {
        if (status === "error") throw new Error("policy_violation:scan_not_passed");
        if (status === "ok" && (crit > 0 || high > 0)) throw new Error("policy_violation:scan_not_passed");
      }
      const sbMode = sbomMode();
      if (sbMode === "deny") {
        const sbStatus = String((ver as any).sbom_summary?.status ?? "").toLowerCase();
        const sbDigest = String((ver as any).sbom_digest ?? "");
        if (!(sbStatus === "ok" && sbDigest)) throw new Error("policy_violation:sbom_not_present");
      }
    }

    const output = await withConcurrency(concurrencyKey, limits.maxConcurrency, async () => {
      return withTimeout(limits.timeoutMs, async (signal) => {
        const withWriteLease = async <T>(toolName: string, fn: () => Promise<T>) => {
          if (!isWriteLeaseTool(toolName)) return fn();
          const resourceRef = computeWriteLeaseResourceRef({ toolName, spaceId, idempotencyKey, toolInput });
          if (!resourceRef) return fn();
          const owner = { runId: params.runId, stepId: params.stepId, traceId };
          const ttlMs = Math.max(60_000, limits.timeoutMs + 10_000);
          const leaseKeyDigest = sha256Hex(stableStringify({ tenantId, spaceId, resourceRef }));
          const ownerDigest = sha256Hex(stableStringify(owner));
          const acquired = await acquireWriteLease({ pool: params.pool, tenantId, spaceId: String(spaceId), resourceRef, owner, ttlMs });
          if (!acquired.acquired) {
            const expiresAtMs = Date.parse(acquired.expiresAt);
            const deltaMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - Date.now()) : 1_000;
            const backoffMs = Math.max(200, Math.min(5_000, Math.round(deltaMs + 50)));
            const currentOwnerDigest = sha256Hex(stableStringify(acquired.currentOwner));
            const e: any = new Error("write_lease_busy");
            e.writeLease = { leaseKeyDigest, ownerDigest, currentOwnerDigest, expiresAt: acquired.expiresAt, backoffMs };
            throw e;
          }
          try {
            return await fn();
          } finally {
            try {
              await releaseWriteLease({ pool: params.pool, tenantId, spaceId: String(spaceId), resourceRef, owner });
            } catch {}
          }
        };

        if (artifactRef) {
          const subjectId = rawInput?.subjectId ? String(rawInput?.subjectId) : null;
          const dyn = await executeDynamicSkill({ pool: params.pool, toolRef, tenantId, spaceId, subjectId, traceId, idempotencyKey, input: toolInput, limits, networkPolicy, artifactRef, depsDigest, egress, signal });
          depsDigest = dyn.depsDigest;
          runtimeBackend = dyn.runtimeBackend;
          degraded = dyn.degraded;
          return dyn.output;
        }
        return executeBuiltinTool({
          name: parsed.name,
          pool: params.pool,
          tenantId,
          spaceId,
          subjectId,
          traceId,
          idempotencyKey,
          schemaName,
          toolInput,
          fieldRules,
          rowFilters,
          limits,
          networkPolicy,
          egress,
          signal,
          withWriteLease,
        });
      });
    });

    const scrubbedOutput = scrubBySchema(ver.output_schema, output);
    validateBySchema("output", ver.output_schema, scrubbedOutput);
    const outputBytes = jsonByteLength(scrubbedOutput);
    if (outputBytes > limits.maxOutputBytes) {
      throw new Error("resource_exhausted:max_output_bytes");
    }

    const latencyMs = Date.now() - startedAt;
    const artifactId = artifactRef && String(artifactRef).startsWith("artifact:") ? String(artifactRef).slice("artifact:".length).trim() : null;
    const isolation = deriveIsolation(runtimeBackend, degraded);
    const ev = parsed.name === "knowledge.search" ? computeEvidenceDigestV1(scrubbedOutput) : null;
    const outputDigest = {
      latencyMs,
      egressSummary: egress,
      egressCount: egress.length,
      limitsSnapshot: limits,
      networkPolicySnapshot: networkPolicy,
      depsDigest,
      artifactId,
      artifactRef,
      runtimeBackend,
      degraded,
      isolation,
      retrievalLogId: ev ? (typeof (scrubbedOutput as any)?.retrievalLogId === "string" ? String((scrubbedOutput as any).retrievalLogId) : "") : "",
      evidenceCount: ev ? ev.evidenceCount : 0,
      evidenceDigest: ev ? ev.evidenceDigest : null,
      outputBytes,
      outputKeys: digestObject(scrubbedOutput),
    };
    const sealedOutputDigest = computeSealedDigestV1(outputDigest);
    const supplyChain = { depsDigest, artifactId, artifactRef, sbomDigest: (ver as any)?.sbom_digest ?? null, verified: true };

    const runStatusRes = await params.pool.query("SELECT status FROM runs WHERE run_id = $1 LIMIT 1", [params.runId]);
    const runStatus = runStatusRes.rowCount ? String(runStatusRes.rows[0].status ?? "") : "";
    if (runStatus === "canceled") {
      await params.pool.query(
        "UPDATE steps SET status = 'canceled', output_digest = $2, sealed_at = COALESCE(sealed_at, now()), sealed_schema_version = COALESCE(sealed_schema_version, 1), sealed_input_digest = COALESCE(sealed_input_digest, $3), sealed_output_digest = $4, nondeterminism_policy = COALESCE(nondeterminism_policy, $5), supply_chain = $6, isolation = $7, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
        [params.stepId, outputDigest, sealedInputDigest, sealedOutputDigest, { ignoredJsonPaths: ["latencyMs"] }, supplyChain, isolation],
      );
      await params.pool.query("UPDATE jobs SET status = 'canceled', updated_at = now() WHERE job_id = $1", [params.jobId]);
      await params.pool.query("UPDATE runs SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
      await sealRunIfFinished({ pool: params.pool, runId: params.runId });
      await updateCompensationStatus("canceled");
      return;
    }

    const safeOutput = buildSafeToolOutput(parsed.name, scrubbedOutput);
    const enc =
      spaceId && (jobType === "tool.execute" || jobType === "agent.run")
        ? await encryptStepOutputAndCompensation({
            pool: params.pool,
            tenantId,
            spaceId,
            stepInputKeyVersion: step.input_key_version as number | null,
            jobType,
            toolName: parsed.name,
            schemaName,
            toolInput,
            scrubbedOutput,
            sideEffectWrite,
          })
        : {
            outputEncFormat: null,
            outputKeyVersion: null,
            outputEncryptedPayload: null,
            compensationEncFormat: null,
            compensationKeyVersion: null,
            compensationEncryptedPayload: null,
          };
    const outputEncFormat = enc.outputEncFormat;
    const outputKeyVersion = enc.outputKeyVersion;
    const outputEncryptedPayload = enc.outputEncryptedPayload;
    const compensationEncFormat = enc.compensationEncFormat;
    const compensationKeyVersion = enc.compensationKeyVersion;
    const compensationEncryptedPayload = enc.compensationEncryptedPayload;

    await params.pool.query(
      "UPDATE steps SET status = $2, output = $3, output_digest = $4, sealed_at = COALESCE(sealed_at, now()), sealed_schema_version = COALESCE(sealed_schema_version, 1), sealed_input_digest = COALESCE(sealed_input_digest, $5), sealed_output_digest = $6, nondeterminism_policy = COALESCE(nondeterminism_policy, $7), supply_chain = $8, isolation = $9, output_enc_format = $10, output_key_version = $11, output_encrypted_payload = $12, compensation_enc_format = $13, compensation_key_version = $14, compensation_encrypted_payload = $15, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
      [
        params.stepId,
        isComp ? "compensated" : "succeeded",
        safeOutput,
        outputDigest,
        sealedInputDigest,
        sealedOutputDigest,
        { ignoredJsonPaths: ["latencyMs"] },
        supplyChain,
        isolation,
        outputEncFormat,
        outputKeyVersion,
        outputEncryptedPayload,
        compensationEncFormat,
        compensationKeyVersion,
        compensationEncryptedPayload,
      ],
    );
    await updateCompensationStatus("succeeded");
    try {
      await appendCollabEventOnce("collab.step.completed", { toolRef, seq, planStepId, outputDigest });
    } catch {
    }
    if (jobType === "agent.run") {
      const aggRes = await params.pool.query(
        `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
            COUNT(*) FILTER (WHERE status IN ('pending','running'))::int AS remaining
          FROM steps
          WHERE run_id = $1
        `,
        [params.runId],
      );
      const total = Number(aggRes.rowCount ? aggRes.rows[0].total : 1) || 1;
      const succeeded = Number(aggRes.rowCount ? aggRes.rows[0].succeeded : 0) || 0;
      const remaining = Number(aggRes.rowCount ? aggRes.rows[0].remaining : 0) || 0;
      const progress = Math.max(0, Math.min(100, Math.round((succeeded / total) * 100)));
      if (remaining > 0) {
        await params.pool.query("UPDATE runs SET status = 'queued', updated_at = now(), finished_at = NULL WHERE run_id = $1", [params.runId]);
        await params.pool.query("UPDATE jobs SET status = 'queued', progress = $2, updated_at = now(), result_summary = $3 WHERE job_id = $1", [
          params.jobId,
          progress,
          safeOutput,
        ]);
      } else {
        await params.pool.query("UPDATE runs SET status = $2, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [
          params.runId,
          isComp ? "compensated" : "succeeded",
        ]);
        await params.pool.query("UPDATE jobs SET status = 'succeeded', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, safeOutput]);
        await sealRunIfFinished({ pool: params.pool, runId: params.runId });
      }
    } else {
      await params.pool.query("UPDATE runs SET status = $2, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [
        params.runId,
        isComp ? "compensated" : "succeeded",
      ]);
      await params.pool.query("UPDATE jobs SET status = 'succeeded', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, safeOutput]);
      await sealRunIfFinished({ pool: params.pool, runId: params.runId });
    }

    await writeAudit(params.pool, { traceId, runId: params.runId, stepId: params.stepId, toolRef, result: "success", inputDigest, outputDigest });
  } catch (err: any) {
    const rawMsg = String(err?.message ?? err);
    const msg = rawMsg.startsWith("concurrency_limit:") ? "resource_exhausted:max_concurrency" : rawMsg;
    const category =
      msg === "timeout"
        ? "timeout"
        : msg.startsWith("resource_exhausted:")
          ? "resource_exhausted"
          : msg.startsWith("policy_violation:")
            ? "policy_violation"
            : msg.startsWith("output_schema:") || msg.startsWith("input_schema:")
              ? "internal"
              : msg === "write_lease_busy"
                ? "retryable"
                : msg.startsWith("conflict_")
                  ? "retryable"
                  : msg.startsWith("schema_not_found:")
                    ? "retryable"
                    : "retryable";
    const outputDigest = {
      latencyMs: null,
      egressSummary: egress,
      egressCount: egress.length,
      limitsSnapshot: limits,
      networkPolicySnapshot: networkPolicy,
      depsDigest: null,
      artifactRef: null,
      error: msg,
      capabilityEnvelopeSummary: isPlainObject((err as any)?.capabilityEnvelopeSummary) ? (err as any).capabilityEnvelopeSummary : null,
      writeLease: isPlainObject(err?.writeLease) ? err.writeLease : null,
    };
    const sealedOutputDigest = computeSealedDigestV1(outputDigest);
    const isolation = deriveIsolation(null, false);
    const supplyChain = { depsDigest: null, artifactId: null, artifactRef: null, sbomDigest: null, verified: false };
    await params.pool.query("UPDATE steps SET status = 'failed', error_category = $2, last_error = $3, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1", [
      params.stepId,
      category,
      msg,
    ]);
    await params.pool.query(
      "UPDATE steps SET sealed_at = COALESCE(sealed_at, now()), sealed_schema_version = COALESCE(sealed_schema_version, 1), sealed_input_digest = COALESCE(sealed_input_digest, $2), sealed_output_digest = COALESCE(sealed_output_digest, $3), nondeterminism_policy = COALESCE(nondeterminism_policy, $4), supply_chain = COALESCE(supply_chain, $5), isolation = COALESCE(isolation, $6), updated_at = now() WHERE step_id = $1",
      [params.stepId, sealedInputDigest, sealedOutputDigest, { ignoredJsonPaths: ["latencyMs"] }, supplyChain, isolation],
    );
    try {
      await appendCollabEventOnce("collab.step.failed", { toolRef, seq, planStepId, errorCategory: category });
    } catch {
    }
    await params.pool.query("UPDATE runs SET status = 'failed', updated_at = now() WHERE run_id = $1", [params.runId]);
    await params.pool.query("UPDATE jobs SET status = 'failed', updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, { error: msg }]);
    await sealRunIfFinished({ pool: params.pool, runId: params.runId });
    await updateCompensationStatus("failed");

    try {
      const tenantId = run.tenant_id as string;
      const spaceId = rawInput?.spaceId ?? null;
      const subjectId = rawInput?.subjectId ? String(rawInput?.subjectId) : null;
      if (jobType === "space.backup" && tenantId && spaceId) {
        const reportText = JSON.stringify({ error: msg, traceId });
        const report = await createArtifact({
          pool: params.pool,
          tenantId,
          spaceId,
          type: "backup_report",
          format: "json",
          contentType: "application/json; charset=utf-8",
          contentText: reportText,
          source: { spaceId, traceId },
          runId: params.runId,
          stepId: params.stepId,
          createdBySubjectId: subjectId,
        });
        await params.pool.query("UPDATE backups SET status = 'failed', report_artifact_id = $3, updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [
          tenantId,
          params.runId,
          report.artifactId,
        ]);
      }
    } catch {
    }

    await writeAudit(params.pool, { traceId, runId: params.runId, stepId: params.stepId, toolRef: toolRef ?? undefined, result: "error", inputDigest, outputDigest, errorCategory: category });
    if (category === "policy_violation" || category === "internal") return;
    throw err;
  }
}
