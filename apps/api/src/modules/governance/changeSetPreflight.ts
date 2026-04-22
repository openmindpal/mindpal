/**
 * ChangeSet — Preflight check logic.
 */
import type { Pool } from "pg";
import { sha256Hex, stableStringify } from "../../lib/digest";
import { isSupportedModelProvider } from "../../lib/modelProviderContract";
import { getToolDefinition, getToolVersionByRef } from "../tools/toolRepo";
import { shouldRequireApproval } from "@openslin/shared/approvalDecision";
import { getEvalSuite, getLatestEvalRunForChangeSet, listChangeSetEvalBindings } from "./evalRepo";
import { evalPassed } from "./evalLogic";
import { computeSchemaCompatReportV1 } from "../metadata/compat";
import { schemaDefSchema } from "../metadata/schemaModel";
import { getByNameVersion, getEffectiveSchema, getPreviousReleasedSchemaVersion } from "../metadata/schemaRepo";
import { getPageConfigContract } from "../contracts/pageConfigContract";
import { getWorkbenchContract } from "../contracts/workbenchContract";
import { getPolicyCacheEpoch } from "../auth/policyCacheEpochRepo";
import { getEnabledSkillRuntimeRunner } from "./skillRuntimeRepo";
import {
  getActiveToolOverride,
  getActiveToolRef,
  getToolRolloutEnabled,
} from "./toolGovernanceRepo";
import { client, countApprovals, validateToolSupplyChain } from "./changeSetShared";
import { getChangeSet, listChangeSetItems, computeApprovalGate } from "./changeSetCrud";
import { checkPolicyVersionContract, generateSchemaMigrationDraftsV1 } from "./changeSetValidation";

export async function preflightChangeSet(params: { pool: Pool; tenantId: string; id: string; mode?: "full" | "canary" }) {
  const cs = await getChangeSet(params);
  if (!cs) throw new Error("changeset_not_found");
  const items = await listChangeSetItems({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  const gate = await computeApprovalGate({ pool: params.pool, tenantId: params.tenantId, items });
  const approvalsCount = await countApprovals({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  const mode = params.mode ?? "full";

  const warnings: string[] = [];
  if (cs.status === "draft") warnings.push("status:draft");
  if (cs.status === "submitted" && approvalsCount < cs.requiredApprovals) warnings.push("approvals:insufficient");
  if (mode === "canary" && (!cs.canaryTargets || cs.canaryTargets.length === 0)) warnings.push("canary_targets:missing");
  if (gate.evalAdmissionRequired) warnings.push("eval_admission:required_by_item_kinds");

  const requiredEvalSuites = await listChangeSetEvalBindings({ pool: params.pool, tenantId: params.tenantId, changesetId: cs.id });
  const evals: any[] = [];
  for (const suiteId of requiredEvalSuites) {
    const suite = await getEvalSuite({ pool: params.pool, tenantId: params.tenantId, id: suiteId });
    if (!suite) {
      warnings.push("evalsuite:missing");
      evals.push({ suiteId, passed: false, latestRunId: null });
      continue;
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
    const latest = await getLatestEvalRunForChangeSet({ pool: params.pool, tenantId: params.tenantId, suiteId: suite.id, changesetId: cs.id });
    const latestDigest = typeof latest?.summary?.reportDigest8 === "string" ? String(latest.summary.reportDigest8) : "";
    const isStale = Boolean(latest && latestDigest && latestDigest !== reportDigest8);
    const passed = !isStale && latest?.status === "succeeded" && evalPassed({ thresholds: suite.thresholds, summary: latest?.summary });
    if (!passed) warnings.push("eval:not_passed");
    const reason = !latest ? "run:missing" : isStale ? "run:stale" : latest.status !== "succeeded" ? `run:${latest.status}` : passed ? null : "threshold:not_met";
    evals.push({
      suiteId: suite.id,
      name: suite.name,
      passed,
      latestRunId: latest?.id ?? null,
      latestRunStatus: latest?.status ?? null,
      reportDigest8,
      latestReportDigest8: latestDigest || null,
      summary: latest?.summary ?? null,
      reason,
    });
  }

  const plan: any[] = [];
  const currentStateDigest: any[] = [];
  const rollbackPreview: any[] = [];
  const contractChecks: any[] = [];

  const hasNonCanaryItems = items.some(
    (i) => i.kind.startsWith("artifact_policy.") || i.kind.startsWith("ui.") || i.kind.startsWith("workbench.") || i.kind.startsWith("policy."),
  );
  if (mode === "canary" && hasNonCanaryItems) warnings.push("mode:canary_not_supported_for_items");

  const targets = mode === "canary" ? (cs.canaryTargets ?? []) : [];
  for (const item of items) {
    contractChecks.push({ itemId: item.id, kind: item.kind, contractKind: String(item.kind).split(".")[0] ?? "unknown", status: "pass", errorCode: null, messageI18n: null, digest: null });
    if (item.kind === "tool.enable" || item.kind === "tool.disable") {
      const toolRef = String(item.payload.toolRef);
      const enabled = item.kind === "tool.enable";
      const ver = await getToolVersionByRef(client(params.pool), params.tenantId, toolRef);
      const gate = ver?.artifactRef ? validateToolSupplyChain((ver as any).trustSummary, (ver as any).scanSummary, (ver as any).sbomSummary, (ver as any).sbomDigest) : null;
      const trust = gate ? gate.trust : { ok: true, status: "n/a" as const };
      const scan = gate ? gate.scan : { ok: true, mode: "n/a" as const, status: "n/a" as const };
      const sbom = gate ? gate.sbom : { ok: true, mode: "n/a" as const, status: "n/a" as const };
      let isolationOk = true;
      if (enabled && ver?.artifactRef && gate?.isolation.denied) {
        const override = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
        const runner = override ? { endpoint: override } : await getEnabledSkillRuntimeRunner({ pool: client(params.pool), tenantId: params.tenantId });
        isolationOk = Boolean(runner);
      }
      if (enabled && ver?.artifactRef) {
        if (!trust.ok) warnings.push("tool_trust:not_verified");
        if (!scan.ok) warnings.push("tool_scan:not_passed");
        if (!sbom.ok) warnings.push("tool_sbom:not_present");
        if (!isolationOk) warnings.push("tool_isolation:not_satisfied");
      }

      if (mode === "canary") {
        for (const spaceId of targets) {
          const prev = await getToolRolloutEnabled({ pool: params.pool, tenantId: params.tenantId, scopeType: "space", scopeId: spaceId, toolRef });
          plan.push({
            kind: item.kind, scopeType: "space", scopeId: spaceId, toolRef,
            hasArtifact: Boolean(ver?.artifactRef), trustStatus: trust.status,
            scanMode: scan.mode, scanStatus: scan.status,
            sbomMode: (sbom as any).mode ?? null, sbomStatus: (sbom as any).status ?? null, isolationOk,
          });
          currentStateDigest.push({ kind: "tool.enabled", scopeType: "space", scopeId: spaceId, toolRef, enabled: prev });
          rollbackPreview.push({ kind: "tool.set_enabled", scopeType: "space", scopeId: spaceId, toolRef, enabled: prev });
        }
      } else {
        const prev = await getToolRolloutEnabled({ pool: params.pool, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef });
        plan.push({
          kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef,
          hasArtifact: Boolean(ver?.artifactRef), trustStatus: trust.status,
          scanMode: scan.mode, scanStatus: scan.status,
          sbomMode: (sbom as any).mode ?? null, sbomStatus: (sbom as any).status ?? null, isolationOk,
        });
        currentStateDigest.push({ kind: "tool.enabled", scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled: prev });
        rollbackPreview.push({ kind: "tool.set_enabled", scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled: prev });
      }
      continue;
    }

    if (item.kind === "tool.set_active") {
      const toolRef = String(item.payload.toolRef);
      const name = String(item.payload.name);
      const ver = await getToolVersionByRef(client(params.pool), params.tenantId, toolRef);
      const gate = ver?.artifactRef ? validateToolSupplyChain((ver as any).trustSummary, (ver as any).scanSummary, (ver as any).sbomSummary, (ver as any).sbomDigest) : null;
      const trust = gate ? gate.trust : { ok: true, status: "n/a" as const };
      const scan = gate ? gate.scan : { ok: true, mode: "n/a" as const, status: "n/a" as const };
      const sbom = gate ? gate.sbom : { ok: true, mode: "n/a" as const, status: "n/a" as const };
      let isolationOk = true;
      if (ver?.artifactRef && gate?.isolation.denied) {
        const override = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
        const runner = override ? { endpoint: override } : await getEnabledSkillRuntimeRunner({ pool: client(params.pool), tenantId: params.tenantId });
        isolationOk = Boolean(runner);
      }
      if (ver?.artifactRef) {
        if (!trust.ok) warnings.push("tool_trust:not_verified");
        if (!scan.ok) warnings.push("tool_scan:not_passed");
        if (!sbom.ok) warnings.push("tool_sbom:not_present");
        if (!isolationOk) warnings.push("tool_isolation:not_satisfied");
      }

      if (mode === "canary") {
        for (const spaceId of targets) {
          const prev = await getActiveToolOverride({ pool: params.pool, tenantId: params.tenantId, spaceId, name });
          plan.push({
            kind: item.kind, scopeType: "space", scopeId: spaceId, name, toolRef,
            hasArtifact: Boolean(ver?.artifactRef), trustStatus: trust.status,
            scanMode: scan.mode, scanStatus: scan.status,
            sbomMode: (sbom as any).mode ?? null, sbomStatus: (sbom as any).status ?? null, isolationOk,
          });
          currentStateDigest.push({ kind: "tool.active_override", spaceId, name, toolRef: prev?.activeToolRef ?? null });
          rollbackPreview.push({ kind: "tool.set_active_override", spaceId, name, toolRef: prev?.activeToolRef ?? null });
        }
      } else {
        const prev = await getActiveToolRef({ pool: params.pool, tenantId: params.tenantId, name });
        plan.push({
          kind: item.kind, scopeType: "tenant", scopeId: params.tenantId, name, toolRef,
          hasArtifact: Boolean(ver?.artifactRef), trustStatus: trust.status,
          scanMode: scan.mode, scanStatus: scan.status,
          sbomMode: (sbom as any).mode ?? null, sbomStatus: (sbom as any).status ?? null, isolationOk,
        });
        currentStateDigest.push({ kind: "tool.active", name, toolRef: prev?.activeToolRef ?? null });
        rollbackPreview.push({ kind: "tool.set_active", name, toolRef: prev?.activeToolRef ?? null });
      }
      continue;
    }

    if (item.kind === "schema.publish") {
      const schemaName = String(item.payload?.name ?? "");
      const schemaDef = schemaDefSchema.parse(item.payload?.schemaDef ?? null);
      const latest = await client(params.pool).query(
        "SELECT version FROM schemas WHERE name = $1 AND status = 'released' ORDER BY version DESC LIMIT 1",
        [schemaName],
      );
      const nextVersionHint = (latest.rowCount ? Number(latest.rows[0].version) : 0) + 1;

      if (mode === "canary") {
        for (const spaceId of targets) {
          const prev = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
          const compatReport = computeSchemaCompatReportV1(prev?.schema ?? null, schemaDef);
          const requiresMigration = compatReport.level === "migration_required";
          const requiredPaths = Array.from(
            new Set([...compatReport.diffSummary.required.addedPaths, ...compatReport.diffSummary.required.upgradedPaths]),
          );
          const migrationDrafts = requiresMigration
            ? generateSchemaMigrationDraftsV1({ scopeType: "space", scopeId: spaceId, schemaName, targetVersionHint: nextVersionHint, schemaDef, requiredFieldPaths: requiredPaths })
            : generateSchemaMigrationDraftsV1({ scopeType: "space", scopeId: spaceId, schemaName, targetVersionHint: nextVersionHint, schemaDef, requiredFieldPaths: [] }).filter((d: any) => d.kind === "rename_field_dual_write");
          const admission = {
            decision: compatReport.level === "compatible" ? ("allow_release" as const) : ("block_release" as const),
            blockedReasons:
              compatReport.level === "breaking" ? ["SCHEMA_BREAKING_CHANGE"]
                : compatReport.level === "migration_required" ? ["SCHEMA_MIGRATION_REQUIRED"] : [],
          };
          if (compatReport.level === "breaking") warnings.push("schema_compat:failed");
          if (requiresMigration) warnings.push("migration:required");
          plan.push({
            kind: item.kind, scopeType: "space", scopeId: spaceId, schemaName, nextVersionHint, compatReport, admission,
            compatOk: compatReport.level !== "breaking", requiresMigration, migrationDrafts,
            migrationPlanDigest: requiresMigration ? { kind: "backfill_required_field", targetVersion: nextVersionHint, requiredAddedFields: compatReport.diffSummary.required.addedPaths, requiredUpgradedFields: compatReport.diffSummary.required.upgradedPaths, compatReportDigest8: compatReport.digest.sha256_8 } : null,
          });
          currentStateDigest.push({ kind: "schema.effective", scopeType: "space", scopeId: spaceId, schemaName, version: prev?.version ?? null });
          rollbackPreview.push({ kind: "schema.set_active_override", spaceId, schemaName, version: prev?.version ?? null });
        }
      } else {
        const spaceId = cs.scopeType === "space" ? cs.scopeId : undefined;
        const prev = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
        const compatReport = computeSchemaCompatReportV1(prev?.schema ?? null, schemaDef);
        const requiresMigration = compatReport.level === "migration_required";
        const scopeType = cs.scopeType;
        const scopeId = cs.scopeId;
        const requiredPaths = Array.from(new Set([...compatReport.diffSummary.required.addedPaths, ...compatReport.diffSummary.required.upgradedPaths]));
        const migrationDrafts = requiresMigration
          ? generateSchemaMigrationDraftsV1({ scopeType, scopeId, schemaName, targetVersionHint: nextVersionHint, schemaDef, requiredFieldPaths: requiredPaths })
          : generateSchemaMigrationDraftsV1({ scopeType, scopeId, schemaName, targetVersionHint: nextVersionHint, schemaDef, requiredFieldPaths: [] }).filter((d: any) => d.kind === "rename_field_dual_write");
        const admission = {
          decision: compatReport.level === "compatible" ? ("allow_release" as const) : ("block_release" as const),
          blockedReasons:
            compatReport.level === "breaking" ? ["SCHEMA_BREAKING_CHANGE"]
              : compatReport.level === "migration_required" ? ["SCHEMA_MIGRATION_REQUIRED"] : [],
        };
        if (compatReport.level === "breaking") warnings.push("schema_compat:failed");
        if (requiresMigration) warnings.push("migration:required");
        plan.push({
          kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, nextVersionHint, compatReport, admission,
          compatOk: compatReport.level !== "breaking", requiresMigration, migrationDrafts,
          migrationPlanDigest: requiresMigration ? { kind: "backfill_required_field", targetVersion: nextVersionHint, requiredAddedFields: compatReport.diffSummary.required.addedPaths, requiredUpgradedFields: compatReport.diffSummary.required.upgradedPaths, compatReportDigest8: compatReport.digest.sha256_8 } : null,
        });
        currentStateDigest.push({ kind: "schema.effective", scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, version: prev?.version ?? null });
        rollbackPreview.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
      }
      continue;
    }

    if (item.kind === "schema.set_active") {
      const schemaName = String(item.payload?.name ?? "");
      const version = Number(item.payload?.version);
      const stored = Number.isFinite(version) ? await getByNameVersion(params.pool as any, schemaName, version) : null;
      if (!stored || stored.status !== "released") warnings.push("schema_version:missing");

      if (mode === "canary") {
        for (const spaceId of targets) {
          const prev = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
          plan.push({ kind: item.kind, scopeType: "space", scopeId: spaceId, schemaName, version });
          currentStateDigest.push({ kind: "schema.effective", scopeType: "space", scopeId: spaceId, schemaName, version: prev?.version ?? null });
          rollbackPreview.push({ kind: "schema.set_active_override", spaceId, schemaName, version: prev?.version ?? null });
        }
      } else {
        const spaceId = cs.scopeType === "space" ? cs.scopeId : undefined;
        const prev = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
        plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, version });
        currentStateDigest.push({ kind: "schema.effective", scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, version: prev?.version ?? null });
        rollbackPreview.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
      }
      continue;
    }

    if (item.kind === "schema.rollback") {
      const schemaName = String(item.payload?.name ?? "");
      if (mode === "canary") {
        for (const spaceId of targets) {
          const cur = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
          const prevVersion = cur ? await getPreviousReleasedSchemaVersion({ pool: params.pool, name: schemaName, beforeVersion: cur.version }) : null;
          if (!prevVersion) warnings.push("schema_prev:missing");
          plan.push({ kind: item.kind, scopeType: "space", scopeId: spaceId, schemaName, toVersion: prevVersion });
          currentStateDigest.push({ kind: "schema.effective", scopeType: "space", scopeId: spaceId, schemaName, version: cur?.version ?? null });
          rollbackPreview.push({ kind: "schema.set_active_override", spaceId, schemaName, version: cur?.version ?? null });
        }
      } else {
        const spaceId = cs.scopeType === "space" ? cs.scopeId : undefined;
        const cur = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
        const prevVersion = cur ? await getPreviousReleasedSchemaVersion({ pool: params.pool, name: schemaName, beforeVersion: cur.version }) : null;
        if (!prevVersion) warnings.push("schema_prev:missing");
        plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, toVersion: prevVersion });
        currentStateDigest.push({ kind: "schema.effective", scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, version: cur?.version ?? null });
        rollbackPreview.push({ kind: "schema.set_active", schemaName, version: cur?.version ?? null });
      }
      continue;
    }

    if (item.kind === "ui.page.publish") {
      const pageName = String(item.payload?.pageName ?? "");
      const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, name: pageName } as const;
      const cur = await getPageConfigContract().getLatestReleased(params.pool, key);
      const draft = await getPageConfigContract().getDraft(params.pool, key);
      const actionBindings = Array.isArray(draft?.actionBindings) ? draft?.actionBindings : [];
      const dataBindings = Array.isArray(draft?.dataBindings) ? draft?.dataBindings : [];
      const toolRefs = Array.from(new Set(actionBindings.map((x: any) => String(x?.toolRef ?? "")).filter(Boolean))).sort();
      const referencedToolRefsDigest = sha256Hex(JSON.stringify(toolRefs));
      let status: "pass" | "fail" | "warn" = "pass";
      let errorCode: string | null = null;
      let messageI18n: any = null;
      if (!draft) {
        status = "fail";
        errorCode = "CONTRACT_NOT_COMPATIBLE";
        messageI18n = { "zh-CN": "UI 页面 draft 不存在", "en-US": "UI page draft missing" };
      } else {
        for (const ref of toolRefs) {
          const v = await getToolVersionByRef(params.pool as any, params.tenantId, ref);
          if (!v || v.status !== "released") {
            status = "fail";
            errorCode = "CONTRACT_NOT_COMPATIBLE";
            messageI18n = { "zh-CN": "UI 页面引用的工具版本未发布", "en-US": "Referenced tool version not released" };
            break;
          }
        }
        if (status !== "fail") {
          for (const a of actionBindings) {
            const rawToolRef = String((a as any)?.toolRef ?? "");
            if (!rawToolRef) continue;
            const at = rawToolRef.lastIndexOf("@");
            const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
            const def = await getToolDefinition(params.pool as any, params.tenantId, toolName);
            if (!def) {
              status = "fail"; errorCode = "CONTRACT_NOT_COMPATIBLE";
              messageI18n = { "zh-CN": "UI 页面引用的工具契约缺失", "en-US": "Referenced tool contract missing" };
              break;
            }
            const idempotencyRequired = Boolean(def.idempotencyRequired);
            const approvalRequired = shouldRequireApproval(def);
            if (idempotencyRequired && String((a as any)?.idempotencyKeyStrategy ?? "") !== "required") {
              status = "fail"; errorCode = "CONTRACT_NOT_COMPATIBLE";
              messageI18n = { "zh-CN": "UI 页面 ActionBinding 缺少幂等键策略", "en-US": "UI page ActionBinding missing idempotency key strategy" };
              break;
            }
            if (approvalRequired && String((a as any)?.approval ?? "") !== "required") {
              status = "fail"; errorCode = "CONTRACT_NOT_COMPATIBLE";
              messageI18n = { "zh-CN": "UI 页面 ActionBinding 缺少审批声明", "en-US": "UI page ActionBinding missing approval declaration" };
              break;
            }
            if (approvalRequired) {
              const cm = (a as any)?.confirmMessage;
              const hasZh = cm && typeof cm === "object" && String(cm["zh-CN"] ?? "").trim().length > 0;
              const hasEn = cm && typeof cm === "object" && String(cm["en-US"] ?? "").trim().length > 0;
              if (!hasZh && !hasEn) {
                status = "fail"; errorCode = "CONTRACT_NOT_COMPATIBLE";
                messageI18n = { "zh-CN": "高风险 ActionBinding 缺少 confirmMessage", "en-US": "High-risk ActionBinding missing confirmMessage" };
                break;
              }
            }
          }
        }
      }
      contractChecks[contractChecks.length - 1] = { ...contractChecks[contractChecks.length - 1], contractKind: "workflow", status, errorCode, messageI18n, digest: referencedToolRefsDigest };
      if (status === "fail") warnings.push("contract:not_compatible");

      plan.push({
        kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, pageName,
        currentReleasedVersion: cur?.version ?? null, dataBindingsCount: dataBindings.length,
        actionBindingsCount: actionBindings.length, referencedToolRefsCount: toolRefs.length, referencedToolRefsDigest,
      });
      currentStateDigest.push({ kind: "ui.page", pageName, currentReleasedVersion: cur?.version ?? null, hasDraft: Boolean(draft) });
      rollbackPreview.push({ kind: "ui.page.restore", pageName, restoreToVersion: cur?.version ?? null });
      continue;
    }

    if (item.kind === "ui.page.rollback") {
      const pageName = String(item.payload?.pageName ?? "");
      const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, name: pageName } as const;
      const cur = await getPageConfigContract().getLatestReleased(params.pool, key);
      const prevExists = cur ? true : false;
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, pageName, currentReleasedVersion: cur?.version ?? null });
      currentStateDigest.push({ kind: "ui.page", pageName, currentReleasedVersion: cur?.version ?? null });
      rollbackPreview.push({ kind: "ui.page.restore", pageName, restoreToVersion: cur?.version ?? null, prevExists });
      continue;
    }

    if (item.kind === "policy.cache.invalidate") {
      const reason = String(item.payload?.reason ?? "");
      const currentEpoch = await getPolicyCacheEpoch({ pool: params.pool, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId });
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, previousEpoch: currentEpoch, reasonLen: reason.length });
      currentStateDigest.push({ kind: "policy.cache.epoch", scopeType: cs.scopeType, scopeId: cs.scopeId, epoch: currentEpoch });
      rollbackPreview.push({ kind: "policy.cache.invalidate", scopeType: cs.scopeType, scopeId: cs.scopeId, nonReversible: true });
      continue;
    }
    if (item.kind === "policy.version.release") {
      const name = String(item.payload?.name ?? "");
      const version = Number(item.payload?.version);
      const cc = await checkPolicyVersionContract({ pool: params.pool, tenantId: params.tenantId, name, version });
      contractChecks[contractChecks.length - 1] = { ...contractChecks[contractChecks.length - 1], contractKind: "policy", status: cc.status, errorCode: cc.errorCode, messageI18n: cc.messageI18n, digest: cc.digest };
      if (cc.status === "fail") warnings.push("contract:not_compatible");
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, name, version, contractStatus: cc.status });
      currentStateDigest.push({ kind: "policy.version", name, active: null });
      rollbackPreview.push({ kind: "policy.version.restore", name, version, restoreStatus: "draft" });
      continue;
    }

    if (item.kind === "policy.publish") {
      const policyId = String(item.payload?.policyId ?? "");
      const version = Number(item.payload?.version);
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, policyId, version });
      currentStateDigest.push({ kind: "safety_policy.version", policyId, version, status: "draft" });
      rollbackPreview.push({ kind: "safety_policy.version.restore", policyId, version, restoreStatus: "draft" });
      continue;
    }
    if (item.kind === "policy.set_active") {
      const policyId = String(item.payload?.policyId ?? "");
      const version = Number(item.payload?.version);
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, policyId, version });
      currentStateDigest.push({ kind: "safety_policy.active", policyId, scopeType: cs.scopeType, scopeId: cs.scopeId, version });
      rollbackPreview.push({ kind: "safety_policy.set_active", policyId, version: null });
      continue;
    }
    if (item.kind === "policy.rollback") {
      const policyId = String(item.payload?.policyId ?? "");
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, policyId });
      currentStateDigest.push({ kind: "safety_policy.active", policyId, scopeType: cs.scopeType, scopeId: cs.scopeId });
      rollbackPreview.push({ kind: "safety_policy.rollback", policyId, nonReversible: false });
      continue;
    }
    if (item.kind === "policy.set_override") {
      const policyId = String(item.payload?.policyId ?? "");
      const spaceId = String(item.payload?.spaceId ?? "");
      const version = Number(item.payload?.version);
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, policyId, spaceId, version });
      currentStateDigest.push({ kind: "safety_policy.active_override", policyId, spaceId, version });
      rollbackPreview.push({ kind: "safety_policy.set_override", policyId, spaceId, version: null });
      continue;
    }

    if (item.kind === "workbench.plugin.publish") {
      const workbenchKey = String(item.payload?.workbenchKey ?? "");
      const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
      const wb = getWorkbenchContract();
      const draft = await wb.getDraftVersion({ pool: params.pool as any, ...key });
      const latest = await wb.getLatestReleasedVersion({ pool: params.pool as any, ...key });
      const active = await wb.getActiveVersion({ pool: params.pool as any, ...key });
      const nextVersion = (latest?.version ?? 0) + 1;
      const manifest = draft?.manifestJson ?? null;
      const caps = manifest && typeof manifest === "object" ? (manifest as any).capabilities : null;
      const dataBindingsCount = Array.isArray(caps?.dataBindings) ? caps.dataBindings.length : 0;
      const actionBindingsCount = Array.isArray(caps?.actionBindings) ? caps.actionBindings.length : 0;
      const capabilitiesSummary = { dataBindingsCount, actionBindingsCount, sha256_8: sha256Hex(JSON.stringify({ dataBindingsCount, actionBindingsCount })).slice(0, 8) };
      const riskHints = { containsActions: actionBindingsCount > 0, hasDraft: Boolean(draft) };
      if (!draft) {
        contractChecks[contractChecks.length - 1] = {
          ...contractChecks[contractChecks.length - 1], contractKind: "workflow", status: "fail",
          errorCode: "CONTRACT_NOT_COMPATIBLE",
          messageI18n: { "zh-CN": "Workbench draft 不存在", "en-US": "Workbench draft missing" }, digest: null,
        };
        warnings.push("contract:not_compatible");
      } else {
        let status: "pass" | "fail" | "warn" = "pass";
        let errorCode: string | null = null;
        let messageI18n: any = null;
        const actionCaps = Array.isArray(caps?.actionBindings) ? caps.actionBindings : [];
        for (const c of actionCaps) {
          const kind = String((c as any)?.kind ?? "");
          if (kind !== "tools.invoke") continue;
          const allow = (c as any)?.allow;
          const toolRefs = Array.isArray(allow?.toolRefs) ? allow.toolRefs : null;
          const toolNames = Array.isArray(allow?.toolNames) ? allow.toolNames : null;
          if ((!toolRefs || toolRefs.length === 0) && (!toolNames || toolNames.length === 0)) {
            status = "fail"; errorCode = "CONTRACT_NOT_COMPATIBLE";
            messageI18n = { "zh-CN": "Workbench tools.invoke 缺少工具 allowlist", "en-US": "Workbench tools.invoke missing tool allowlist" };
            break;
          }
        }
        contractChecks[contractChecks.length - 1] = {
          ...contractChecks[contractChecks.length - 1], contractKind: "workflow", status, errorCode, messageI18n,
          digest: (draft as any).manifestDigest ?? null,
        };
        if (status === "fail") warnings.push("contract:not_compatible");
      }
      plan.push({
        kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey,
        fromActiveVersion: active ?? null, toVersion: draft ? nextVersion : null,
        manifestDigest: draft?.manifestDigest ?? null, capabilitiesSummary, riskHints,
      });
      currentStateDigest.push({
        kind: "workbench", scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey,
        activeVersion: active ?? null, latestReleasedVersion: latest?.version ?? null, hasDraft: Boolean(draft),
      });
      rollbackPreview.push({ kind: "workbench.set_active", workbenchKey, restoreToVersion: active ?? null });
      if (!draft) warnings.push("workbench_draft:missing");
      continue;
    }

    if (item.kind === "workbench.plugin.rollback") {
      const workbenchKey = String(item.payload?.workbenchKey ?? "");
      const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
      const wb2 = getWorkbenchContract();
      const active = await wb2.getActiveVersion({ pool: params.pool as any, ...key });
      const prev = active ? await wb2.getPreviousReleasedVersion({ pool: params.pool as any, ...key, beforeVersion: active }) : null;
      if (!active) warnings.push("workbench_active:missing");
      if (!prev) warnings.push("workbench_prev:missing");
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey, fromActiveVersion: active ?? null, toVersion: prev ?? null });
      currentStateDigest.push({ kind: "workbench", scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey, activeVersion: active ?? null });
      rollbackPreview.push({ kind: "workbench.set_active", workbenchKey, restoreToVersion: active ?? null });
      continue;
    }

    if (item.kind === "workbench.plugin.canary") {
      const workbenchKey = String(item.payload?.workbenchKey ?? "");
      const canaryVersion = Number(item.payload?.canaryVersion);
      const subjectIds = Array.isArray(item.payload?.subjectIds) ? item.payload.subjectIds : [];
      const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
      const prev = await getWorkbenchContract().getCanaryConfig({ pool: params.pool as any, ...key });
      plan.push({
        kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey,
        canaryVersion, subjectCount: subjectIds.length, prevCanaryVersion: prev?.canaryVersion ?? null,
      });
      currentStateDigest.push({
        kind: "workbench.canary", scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey,
        prevCanaryVersion: prev?.canaryVersion ?? null, prevSubjectCount: prev?.canarySubjectIds.length ?? 0,
      });
      rollbackPreview.push({ kind: "workbench.set_canary", workbenchKey, restorePrev: prev ? { canaryVersion: prev.canaryVersion, subjectCount: prev.canarySubjectIds.length } : null });
      continue;
    }

    if (item.kind === "model_routing.upsert") {
      const purpose = String(item.payload?.purpose ?? "");
      const primaryModelRef = String(item.payload?.primaryModelRef ?? "");
      const fallbackModelRefs = Array.isArray(item.payload?.fallbackModelRefs) ? item.payload.fallbackModelRefs : [];
      const enabled = item.payload?.enabled === undefined ? true : Boolean(item.payload?.enabled);
      const refs = [primaryModelRef, ...fallbackModelRefs].map((x) => String(x ?? "").trim()).filter(Boolean);
      let status: "pass" | "fail" | "warn" = "pass";
      let errorCode: string | null = null;
      let messageI18n: any = null;
      for (const ref of refs) {
        const m = /^([a-z0-9_]+):(.+)$/.exec(ref);
        if (!m) { status = "fail"; errorCode = "CONTRACT_NOT_COMPATIBLE"; messageI18n = { "zh-CN": "无效 modelRef", "en-US": "Invalid modelRef" }; break; }
        const provider = m[1];
        if (!isSupportedModelProvider(provider)) { status = "fail"; errorCode = "CONTRACT_NOT_COMPATIBLE"; messageI18n = { "zh-CN": "provider 未实现", "en-US": "Provider not implemented" }; break; }
        const bRes = mode === "canary"
          ? await client(params.pool).query(`SELECT 1 FROM provider_bindings WHERE tenant_id = $1 AND provider = $2 AND status = 'active' AND ((scope_type = 'tenant' AND scope_id = $3) OR (scope_type = 'space' AND scope_id = ANY($4::text[]))) LIMIT 1`, [params.tenantId, provider, params.tenantId, targets])
          : await client(params.pool).query(`SELECT 1 FROM provider_bindings WHERE tenant_id = $1 AND provider = $2 AND status = 'active' AND ((scope_type = $3 AND scope_id = $4) OR (scope_type = 'tenant' AND scope_id = $1)) LIMIT 1`, [params.tenantId, provider, cs.scopeType, cs.scopeId]);
        if (!bRes.rowCount) { status = "fail"; errorCode = "CONTRACT_NOT_COMPATIBLE"; messageI18n = { "zh-CN": "未配置 provider binding", "en-US": "Provider binding missing" }; break; }
      }
      contractChecks[contractChecks.length - 1] = { ...contractChecks[contractChecks.length - 1], contractKind: "model", status, errorCode, messageI18n };
      if (status === "fail") warnings.push("contract:not_compatible");
      if (mode === "canary") {
        for (const spaceId of targets) {
          const prevOvrRes = await client(params.pool).query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3 LIMIT 1`, [params.tenantId, spaceId, purpose]);
          const prevBaseRes = await client(params.pool).query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`, [params.tenantId, purpose]);
          const prevBase = prevBaseRes.rowCount ? { primaryModelRef: prevBaseRes.rows[0].primary_model_ref, fallbackCount: Array.isArray(prevBaseRes.rows[0].fallback_model_refs) ? prevBaseRes.rows[0].fallback_model_refs.length : 0, enabled: Boolean(prevBaseRes.rows[0].enabled) } : null;
          const prevOverride = prevOvrRes.rowCount ? { primaryModelRef: prevOvrRes.rows[0].primary_model_ref, fallbackCount: Array.isArray(prevOvrRes.rows[0].fallback_model_refs) ? prevOvrRes.rows[0].fallback_model_refs.length : 0, enabled: Boolean(prevOvrRes.rows[0].enabled) } : null;
          const prevEff = prevOverride ?? prevBase;
          plan.push({ kind: item.kind, scopeType: "space", scopeId: spaceId, purpose, primaryModelRef, fallbackCount: fallbackModelRefs.length, enabled });
          currentStateDigest.push({ kind: "model.routing_policy", scopeType: "space", scopeId: spaceId, purpose, exists: Boolean(prevEff), prev: prevEff, overrideExists: Boolean(prevOverride) });
          rollbackPreview.push({ kind: "model_routing.override_restore", spaceId, purpose, exists: Boolean(prevOverride) });
        }
      } else {
        const prevRes = await client(params.pool).query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`, [params.tenantId, purpose]);
        const prev = prevRes.rowCount ? { primaryModelRef: prevRes.rows[0].primary_model_ref, fallbackCount: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs.length : 0, enabled: Boolean(prevRes.rows[0].enabled) } : null;
        plan.push({ kind: item.kind, purpose, primaryModelRef, fallbackCount: fallbackModelRefs.length, enabled });
        currentStateDigest.push({ kind: "model.routing_policy", purpose, exists: Boolean(prev), prev });
        rollbackPreview.push({ kind: "model_routing.restore", purpose, exists: Boolean(prev) });
      }
      continue;
    }

    if (item.kind === "model_routing.disable") {
      const purpose = String(item.payload?.purpose ?? "");
      if (mode === "canary") {
        for (const spaceId of targets) {
          const prevOvrRes = await client(params.pool).query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3 LIMIT 1`, [params.tenantId, spaceId, purpose]);
          const prevBaseRes = await client(params.pool).query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`, [params.tenantId, purpose]);
          const prevBase = prevBaseRes.rowCount ? { primaryModelRef: prevBaseRes.rows[0].primary_model_ref, fallbackCount: Array.isArray(prevBaseRes.rows[0].fallback_model_refs) ? prevBaseRes.rows[0].fallback_model_refs.length : 0, enabled: Boolean(prevBaseRes.rows[0].enabled) } : null;
          const prevOverride = prevOvrRes.rowCount ? { primaryModelRef: prevOvrRes.rows[0].primary_model_ref, fallbackCount: Array.isArray(prevOvrRes.rows[0].fallback_model_refs) ? prevOvrRes.rows[0].fallback_model_refs.length : 0, enabled: Boolean(prevOvrRes.rows[0].enabled) } : null;
          const prevEff = prevOverride ?? prevBase;
          plan.push({ kind: item.kind, scopeType: "space", scopeId: spaceId, purpose });
          currentStateDigest.push({ kind: "model.routing_policy", scopeType: "space", scopeId: spaceId, purpose, exists: Boolean(prevEff), prev: prevEff, overrideExists: Boolean(prevOverride) });
          rollbackPreview.push({ kind: "model_routing.override_restore", spaceId, purpose, exists: Boolean(prevOverride) });
        }
      } else {
        const prevRes = await client(params.pool).query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`, [params.tenantId, purpose]);
        const prev = prevRes.rowCount ? { primaryModelRef: prevRes.rows[0].primary_model_ref, fallbackCount: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs.length : 0, enabled: Boolean(prevRes.rows[0].enabled) } : null;
        plan.push({ kind: item.kind, purpose });
        currentStateDigest.push({ kind: "model.routing_policy", purpose, exists: Boolean(prev), prev });
        rollbackPreview.push({ kind: "model_routing.restore", purpose, exists: Boolean(prev) });
      }
      continue;
    }

    if (item.kind === "artifact_policy.upsert") {
      const scopeType = String(item.payload?.scopeType ?? "") as "tenant" | "space";
      const scopeId = String(item.payload?.scopeId ?? "");
      const downloadTokenExpiresInSec = Number(item.payload?.downloadTokenExpiresInSec);
      const downloadTokenMaxUses = Number(item.payload?.downloadTokenMaxUses);
      const watermarkHeadersEnabled = Boolean(item.payload?.watermarkHeadersEnabled);
      const prevRes = await client(params.pool).query(
        `SELECT download_token_expires_in_sec, download_token_max_uses, watermark_headers_enabled FROM artifact_policies WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 LIMIT 1`,
        [params.tenantId, scopeType, scopeId],
      );
      const prev = prevRes.rowCount ? {
        scopeType, scopeId,
        downloadTokenExpiresInSec: Number(prevRes.rows[0].download_token_expires_in_sec),
        downloadTokenMaxUses: Number(prevRes.rows[0].download_token_max_uses),
        watermarkHeadersEnabled: Boolean(prevRes.rows[0].watermark_headers_enabled),
      } : null;
      plan.push({ kind: item.kind, scopeType, scopeId, downloadTokenExpiresInSec, downloadTokenMaxUses, watermarkHeadersEnabled });
      currentStateDigest.push({ kind: "artifact.policy", scopeType, scopeId, exists: Boolean(prev), prev });
      rollbackPreview.push({ kind: "artifact_policy.restore", scopeType, scopeId, exists: Boolean(prev) });
      continue;
    }
  }

  return {
    changeset: cs,
    gate: { riskLevel: gate.riskLevel, requiredApprovals: gate.requiredApprovals, approvalsCount },
    evalGate: { requiredSuiteIds: requiredEvalSuites, suites: evals, evalAdmissionRequired: gate.evalAdmissionRequired },
    plan,
    currentStateDigest,
    rollbackPreview,
    contractChecks,
    warnings,
  };
}
