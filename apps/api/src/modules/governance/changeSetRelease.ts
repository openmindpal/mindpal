/**
 * ChangeSet — Release logic (releaseChangeSet).
 */
import type { Pool } from "pg";
import { schemaDefSchema } from "../metadata/schemaModel";
import { computeSchemaCompatReportV1 } from "../metadata/compat";
import { ensureSchemaI18nFallback } from "../metadata/i18n";
import { getActiveSchemaOverride, getByNameVersion, getEffectiveSchema, publishNewReleased, setActiveSchemaOverride, setActiveSchemaVersion } from "../metadata/schemaRepo";
import { getPageConfigContract } from "../contracts/pageConfigContract";
import { getToolDefinition, getToolVersionByRef } from "../tools/toolRepo";
import { assessToolExecutionRisk } from "../../kernel/approvalRuleEngine";
import { getWorkbenchContract } from "../contracts/workbenchContract";
import { bumpPolicyCacheEpoch } from "../auth/policyCacheEpochRepo";
import { getEvalSuite, getLatestEvalRunForChangeSet, listChangeSetEvalBindings, listCoreEvalSuites, getLatestSucceededEvalRunGlobal } from "./evalRepo";
import { evalPassed, evalPassedWithCategories, isEvalRunStale, buildEvalGateReport, type EvalGateFailure } from "./evalLogic";
import { isSupportedModelProvider } from "../../lib/modelProviderContract";
import { getEnabledSkillRuntimeRunner } from "./skillRuntimeRepo";
import {
  getActiveToolOverride, getActiveToolRef, getToolRolloutEnabled,
  setActiveToolOverride, setActiveToolRef, setToolRollout,
} from "./toolGovernanceRepo";
import { client, countApprovals, toCs } from "./changeSetShared";
import { getChangeSet, listChangeSetItems, computeApprovalGate } from "./changeSetCrud";
import { validateItem, assertMigrationGate, checkPolicyVersionContract } from "./changeSetValidation";

export async function releaseChangeSet(params: { pool: Pool; tenantId: string; id: string; releasedBy: string; mode?: "full" | "canary" }) {
  const cs = await getChangeSet(params);
  if (!cs) throw new Error("changeset_not_found");
  if (cs.status !== "approved") throw new Error("changeset_not_approved");

  const mode = params.mode ?? "full";
  const targets = mode === "canary" ? (cs.canaryTargets ?? []) : [];
  if (mode === "canary" && targets.length === 0) throw new Error("canary_targets_missing");

  // P0-2 安全修复：eval admission 检查已移至 items 循环之后执行。
  // 门禁优先级：schema compat errors > eval admission > approval gate。
  // 之前 eval 先于 schema 检查，导致 schema_breaking_change/schema_migration_required 被 eval_not_passed 覆盖。

  const items = await listChangeSetItems({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  if (
    mode === "canary" &&
    items.some(
      (i) =>
        i.kind.startsWith("artifact_policy.") ||
        i.kind.startsWith("ui.") ||
        i.kind.startsWith("workbench.") ||
        i.kind.startsWith("policy."),
    )
  ) {
    throw new Error("changeset_mode_not_supported");
  }
  const rollback: any = { actions: [] as any[], schemaPublishedVersions: {} as Record<string, number> };

  const tx = await params.pool.connect();
  try {
    await tx.query("BEGIN");
    const locked = await tx.query(
      `SELECT status FROM governance_changesets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [params.tenantId, params.id],
    );
    if (!locked.rowCount || locked.rows[0].status !== "approved") throw new Error("changeset_not_approved");

    const approvals = await countApprovals({ pool: tx, tenantId: params.tenantId, changesetId: params.id });
    if (approvals < cs.requiredApprovals) throw new Error("changeset_insufficient_approvals");

    const willPublishPolicyVersions = new Set(
      items
        .filter((i) => i.kind === "policy.publish")
        .map((i) => `${String(i.payload?.policyId ?? "")}@${Number(i.payload?.version)}`),
    );

    for (const item of items) {
      if (item.kind === "policy.set_active") {
        const policyId = String(item.payload?.policyId ?? "");
        const version = Number(item.payload?.version);
        if (willPublishPolicyVersions.has(`${policyId}@${version}`)) {
          const pv = await tx.query(
            `SELECT v.status FROM safety_policy_versions v JOIN safety_policies p ON p.policy_id = v.policy_id WHERE p.tenant_id = $1 AND p.policy_id = $2 AND v.version = $3 LIMIT 1`,
            [params.tenantId, policyId, version],
          );
          if (!pv.rowCount) throw new Error("invalid_item");
          const st = String(pv.rows[0].status);
          if (!["draft", "submitted", "approved", "released"].includes(st)) throw new Error("invalid_item");
        } else {
          await validateItem(tx, params.tenantId, item);
        }
      } else {
        await validateItem(tx, params.tenantId, item);
      }

      if (item.kind === "tool.enable" || item.kind === "tool.disable") {
        const toolRef = String(item.payload.toolRef);
        const enabled = item.kind === "tool.enable";
        if (mode === "canary") {
          for (const spaceId of targets) {
            const prev = await getToolRolloutEnabled({ pool: tx as any, tenantId: params.tenantId, scopeType: "space", scopeId: spaceId, toolRef });
            rollback.actions.push({ kind: "tool.set_enabled", scopeType: "space", scopeId: spaceId, toolRef, enabled: prev });
            await setToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType: "space", scopeId: spaceId, toolRef, enabled });
          }
        } else {
          const prev = await getToolRolloutEnabled({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef });
          rollback.actions.push({ kind: "tool.set_enabled", scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled: prev });
          await setToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled });
        }
        continue;
      }

      if (item.kind === "tool.set_active") {
        const toolRef = String(item.payload.toolRef);
        const name = String(item.payload.name);
        if (mode === "canary") {
          for (const spaceId of targets) {
            const prev = await getActiveToolOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name });
            rollback.actions.push({ kind: "tool.set_active_override", spaceId, name, toolRef: prev?.activeToolRef ?? null });
            await setActiveToolOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name, toolRef });
          }
        } else {
          const prev = await getActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name });
          rollback.actions.push({ kind: "tool.set_active", name, toolRef: prev?.activeToolRef ?? null });
          await setActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name, toolRef });
        }
        continue;
      }

      if (item.kind === "schema.publish") {
        const schemaName = String(item.payload?.name ?? "");
        const schemaDef = schemaDefSchema.parse(item.payload?.schemaDef ?? null);
        ensureSchemaI18nFallback(schemaDef);
        const latest = await client(tx).query("SELECT version FROM schemas WHERE name = $1 AND status = 'released' ORDER BY version DESC LIMIT 1", [schemaName]);
        const nextVersionHint = (latest.rowCount ? Number(latest.rows[0].version) : 0) + 1;
        if (mode === "canary") {
          const migrationRunId = String(item.payload?.migrationRunId ?? "");
          for (const spaceId of targets) {
            const prev = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
            const compatReport = computeSchemaCompatReportV1(prev?.schema ?? null, schemaDef);
            if (compatReport.level === "breaking") throw new Error(`schema_breaking_change:${compatReport.digest.sha256_8}`);
            if (compatReport.level === "migration_required") {
              if (!migrationRunId) throw new Error(`schema_migration_required:${compatReport.digest.sha256_8}`);
              await assertMigrationGate({ pool: tx, tenantId: params.tenantId, migrationRunId, schemaName, targetVersion: nextVersionHint });
            }
          }
        } else {
          const spaceId = cs.scopeType === "space" ? cs.scopeId : undefined;
          const prev = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
          const compatReport = computeSchemaCompatReportV1(prev?.schema ?? null, schemaDef);
          if (compatReport.level === "breaking") throw new Error(`schema_breaking_change:${compatReport.digest.sha256_8}`);
          if (compatReport.level === "migration_required") {
            const migrationRunId = String(item.payload?.migrationRunId ?? "");
            if (!migrationRunId) throw new Error(`schema_migration_required:${compatReport.digest.sha256_8}`);
            await assertMigrationGate({ pool: tx, tenantId: params.tenantId, migrationRunId, schemaName, targetVersion: nextVersionHint });
          }
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
        }
        const stored = await publishNewReleased(tx as any, schemaDef);
        rollback.schemaPublishedVersions[schemaName] = stored.version;
        if (mode === "canary") {
          for (const spaceId of targets) {
            const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
            rollback.actions.push({ kind: "schema.set_active_override", spaceId, schemaName, version: prev ?? null });
            await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName, version: stored.version });
          }
        } else if (cs.scopeType === "space") {
          const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prev ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version: stored.version });
        } else {
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version: stored.version });
        }
        continue;
      }

      if (item.kind === "schema.set_active") {
        const schemaName = String(item.payload?.name ?? "");
        const version = Number(item.payload?.version);
        if (!Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const stored = await getByNameVersion(tx as any, schemaName, version);
        if (!stored || stored.status !== "released") throw new Error("invalid_item");
        const migrationRunId = String(item.payload?.migrationRunId ?? "");
        if (mode === "canary") {
          for (const spaceId of targets) {
            const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
            rollback.actions.push({ kind: "schema.set_active_override", spaceId, schemaName, version: prev ?? null });
            await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName, version });
          }
        } else if (cs.scopeType === "space") {
          const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prev ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version });
        } else {
          const prev = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version });
        }
        continue;
      }

      if (item.kind === "schema.rollback") {
        const schemaName = String(item.payload?.name ?? "");
        if (mode === "canary") {
          for (const spaceId of targets) {
            const cur = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
            if (!cur) throw new Error("schema_not_found");
            const { getPreviousReleasedSchemaVersion } = await import("../metadata/schemaRepo");
            const prevVersion = await getPreviousReleasedSchemaVersion({ pool: tx as any, name: schemaName, beforeVersion: cur.version });
            if (!prevVersion) throw new Error("schema_prev_missing");
            const prevOverride = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
            rollback.actions.push({ kind: "schema.set_active_override", spaceId, schemaName, version: prevOverride ?? null });
            await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName, version: prevVersion });
          }
        } else if (cs.scopeType === "space") {
          const cur = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          if (!cur) throw new Error("schema_not_found");
          const { getPreviousReleasedSchemaVersion } = await import("../metadata/schemaRepo");
          const prevVersion = await getPreviousReleasedSchemaVersion({ pool: tx as any, name: schemaName, beforeVersion: cur.version });
          if (!prevVersion) throw new Error("schema_prev_missing");
          const prevOverride = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prevOverride ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version: prevVersion });
        } else {
          const cur = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
          if (!cur) throw new Error("schema_not_found");
          const { getPreviousReleasedSchemaVersion } = await import("../metadata/schemaRepo");
          const prevVersion = await getPreviousReleasedSchemaVersion({ pool: tx as any, name: schemaName, beforeVersion: cur.version });
          if (!prevVersion) throw new Error("schema_prev_missing");
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: cur.version });
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version: prevVersion });
        }
        continue;
      }

      if (item.kind === "ui.page.publish") {
        const pageName = String(item.payload?.pageName ?? "");
        if (!pageName) throw new Error("invalid_item");
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, name: pageName } as const;
        const pc = getPageConfigContract();
        const cur = await pc.getLatestReleased(tx as any, key);
        const draftRow = await pc.getDraft(tx as any, key);
        if (!draftRow) throw new Error("contract_not_compatible");
        const draft = pc.pageDraftSchema.parse({ title: draftRow.title ?? undefined, pageType: draftRow.pageType, params: draftRow.params ?? undefined, dataBindings: draftRow.dataBindings ?? undefined, actionBindings: draftRow.actionBindings ?? undefined, ui: draftRow.ui ?? undefined });
        for (const a of draft.actionBindings ?? []) {
          const ver = await getToolVersionByRef(tx as any, params.tenantId, a.toolRef);
          if (!ver || ver.status !== "released") throw new Error("contract_not_compatible");
          const rawToolRef = String(a.toolRef ?? "");
          const at = rawToolRef.lastIndexOf("@");
          const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
          const def = await getToolDefinition(tx as any, params.tenantId, toolName);
          if (!def) throw new Error("contract_not_compatible");
          const idempotencyRequired = Boolean(def.idempotencyRequired);
          const approvalAssessment = await assessToolExecutionRisk({
            pool: tx as any,
            tenantId: params.tenantId,
            toolRef: rawToolRef,
            inputDraft: {},
            toolDefinition: { riskLevel: def.riskLevel as any, approvalRequired: def.approvalRequired, scope: def.scope ?? undefined },
          });
          const approvalRequired = approvalAssessment.approvalRequired;
          if (idempotencyRequired && String((a as any).idempotencyKeyStrategy ?? "") !== "required") throw new Error("contract_not_compatible");
          if (approvalRequired && String((a as any).approval ?? "") !== "required") throw new Error("contract_not_compatible");
          if (approvalRequired) {
            const cm = (a as any).confirmMessage;
            const hasZh = cm && typeof cm === "object" && String((cm as any)["zh-CN"] ?? "").trim().length > 0;
            const hasEn = cm && typeof cm === "object" && String((cm as any)["en-US"] ?? "").trim().length > 0;
            if (!hasZh && !hasEn) throw new Error("contract_not_compatible");
          }
        }
        const published = await pc.publishFromDraft(tx as any, key);
        if (!published) throw new Error("contract_not_compatible");
        rollback.actions.push({ kind: "ui.page.restore", pageName, restoreToVersion: cur?.version ?? null, publishedVersion: published.version });
        continue;
      }

      if (item.kind === "ui.page.rollback") {
        const pageName = String(item.payload?.pageName ?? "");
        if (!pageName) throw new Error("invalid_item");
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, name: pageName } as const;
        const pc2 = getPageConfigContract();
        const cur = await pc2.getLatestReleased(tx as any, key);
        const rolled = await pc2.rollbackToPreviousReleased(tx as any, key);
        if (!rolled) throw new Error("ui_no_previous_version");
        rollback.actions.push({ kind: "ui.page.restore", pageName, restoreToVersion: cur?.version ?? null, publishedVersion: rolled.version });
        continue;
      }

      if (item.kind === "policy.cache.invalidate") {
        const scopeType = String(item.payload?.scopeType ?? "") as any;
        const scopeId = String(item.payload?.scopeId ?? "");
        const reason = String(item.payload?.reason ?? "");
        if (!scopeId || !reason) throw new Error("invalid_item");
        await bumpPolicyCacheEpoch({ pool: tx as any, tenantId: params.tenantId, scopeType: scopeType ?? cs.scopeType, scopeId: scopeId ?? cs.scopeId });
        continue;
      }

      if (item.kind === "policy.version.release") {
        const name = String(item.payload?.name ?? "");
        const version = Number(item.payload?.version);
        if (!name || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const cc = await checkPolicyVersionContract({ pool: tx as any, tenantId: params.tenantId, name, version });
        if (cc.status === "fail") throw new Error("contract_not_compatible");
        const prevRes = await tx.query(`SELECT status, published_at FROM policy_versions WHERE tenant_id = $1 AND name = $2 AND version = $3 LIMIT 1`, [params.tenantId, name, version]);
        if (!prevRes.rowCount) throw new Error("contract_not_compatible");
        const prev = prevRes.rows[0];
        rollback.actions.push({ kind: "policy.version.restore", name, version, prevStatus: String(prev.status), prevPublishedAt: prev.published_at ?? null });
        const upd = await tx.query(`UPDATE policy_versions SET status = 'released', published_at = now() WHERE tenant_id = $1 AND name = $2 AND version = $3 AND status = 'draft' RETURNING id`, [params.tenantId, name, version]);
        if (!upd.rowCount) throw new Error("contract_not_compatible");
        await bumpPolicyCacheEpoch({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType as any, scopeId: cs.scopeId });
        continue;
      }

      if (item.kind === "policy.publish") {
        const policyId = String(item.payload?.policyId ?? "");
        const version = Number(item.payload?.version);
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId) || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const prevRes = await tx.query(`SELECT v.status, v.published_at FROM safety_policy_versions v JOIN safety_policies p ON p.policy_id = v.policy_id WHERE p.tenant_id = $1 AND p.policy_id = $2 AND v.version = $3 LIMIT 1`, [params.tenantId, policyId, version]);
        if (!prevRes.rowCount) throw new Error("contract_not_compatible");
        rollback.actions.push({ kind: "safety_policy.version.restore", policyId, version, prevStatus: String(prevRes.rows[0].status), prevPublishedAt: prevRes.rows[0].published_at ?? null });
        const upd = await tx.query(`UPDATE safety_policy_versions v SET status = 'released', published_at = COALESCE(published_at, now()), updated_at = now() WHERE v.policy_id = $1 AND v.version = $2 AND EXISTS (SELECT 1 FROM safety_policies p WHERE p.policy_id = v.policy_id AND p.tenant_id = $3) AND v.status IN ('draft','submitted','approved') RETURNING policy_id`, [policyId, version, params.tenantId]);
        if (!upd.rowCount) throw new Error("contract_not_compatible");
        continue;
      }

      if (item.kind === "policy.set_active") {
        const policyId = String(item.payload?.policyId ?? "");
        const version = Number(item.payload?.version);
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId) || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const prevRes = await tx.query(`SELECT active_version FROM safety_policy_active_versions WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1`, [params.tenantId, policyId]);
        rollback.actions.push({ kind: "safety_policy.set_active", policyId, prevVersion: prevRes.rowCount ? Number(prevRes.rows[0].active_version) : null });
        await tx.query(`INSERT INTO safety_policy_active_versions (tenant_id, policy_id, active_version) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, policy_id) DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()`, [params.tenantId, policyId, version]);
        continue;
      }

      if (item.kind === "policy.rollback") {
        const policyId = String(item.payload?.policyId ?? "");
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("invalid_item");
        const curRes = await tx.query(`SELECT active_version FROM safety_policy_active_versions WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1`, [params.tenantId, policyId]);
        if (!curRes.rowCount) throw new Error("invalid_item");
        const cur = Number(curRes.rows[0].active_version);
        const prevRes = await tx.query(`SELECT version FROM safety_policy_versions WHERE policy_id = $1 AND status = 'released' AND version < $2 ORDER BY version DESC LIMIT 1`, [policyId, cur]);
        if (!prevRes.rowCount) throw new Error("policy_no_previous_version");
        const prev = Number(prevRes.rows[0].version);
        rollback.actions.push({ kind: "safety_policy.set_active", policyId, prevVersion: cur });
        await tx.query(`INSERT INTO safety_policy_active_versions (tenant_id, policy_id, active_version) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, policy_id) DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()`, [params.tenantId, policyId, prev]);
        continue;
      }

      if (item.kind === "policy.set_override") {
        const policyId = String(item.payload?.policyId ?? "");
        const spaceId = String(item.payload?.spaceId ?? "");
        const version = Number(item.payload?.version);
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId) || !spaceId || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const prevRes = await tx.query(`SELECT active_version FROM safety_policy_active_overrides WHERE tenant_id = $1 AND space_id = $2 AND policy_id = $3 LIMIT 1`, [params.tenantId, spaceId, policyId]);
        rollback.actions.push({ kind: "safety_policy.set_override", policyId, spaceId, prevVersion: prevRes.rowCount ? Number(prevRes.rows[0].active_version) : null });
        await tx.query(`INSERT INTO safety_policy_active_overrides (tenant_id, space_id, policy_id, active_version) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, space_id, policy_id) DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()`, [params.tenantId, spaceId, policyId, version]);
        continue;
      }

      if (item.kind === "workbench.plugin.publish") {
        const workbenchKey = String(item.payload?.workbenchKey ?? "");
        if (!workbenchKey) throw new Error("invalid_item");
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
        const wb = getWorkbenchContract();
        const prevActive = await wb.getActiveVersion({ pool: tx as any, ...key });
        const published = await wb.publishFromDraft({ pool: tx as any, ...key, createdBySubjectId: params.releasedBy });
        if (!published) throw new Error("contract_not_compatible");
        rollback.actions.push({ kind: "workbench.set_active", scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey, version: prevActive ?? null });
        continue;
      }

      if (item.kind === "workbench.plugin.rollback") {
        const workbenchKey = String(item.payload?.workbenchKey ?? "");
        if (!workbenchKey) throw new Error("invalid_item");
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
        const wb2 = getWorkbenchContract();
        const prev = await wb2.getActiveVersion({ pool: tx as any, ...key });
        rollback.actions.push({ kind: "workbench.set_active", scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey, version: prev ?? null });
        await wb2.rollbackActiveToPreviousReleased({ pool: tx as any, ...key });
        continue;
      }

      if (item.kind === "workbench.plugin.canary") {
        const workbenchKey = String(item.payload?.workbenchKey ?? "");
        const canaryVersion = Number(item.payload?.canaryVersion);
        const subjectIds = Array.isArray(item.payload?.subjectIds) ? item.payload.subjectIds : [];
        if (!workbenchKey) throw new Error("invalid_item");
        if (!Number.isFinite(canaryVersion) || canaryVersion <= 0) throw new Error("invalid_item");
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
        const wb3 = getWorkbenchContract();
        const prev = await wb3.getCanaryConfig({ pool: tx as any, ...key });
        rollback.actions.push({ kind: "workbench.set_canary", scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey, prev: prev ? { canaryVersion: prev.canaryVersion, subjectIds: prev.canarySubjectIds } : null });
        if (subjectIds.length === 0) {
          await wb3.clearCanaryConfig({ pool: tx as any, ...key });
        } else {
          await wb3.setCanaryConfig({ pool: tx as any, ...key, canaryVersion, subjectIds });
        }
        continue;
      }

      if (item.kind === "model_routing.upsert") {
        const purpose = String(item.payload.purpose);
        const primaryModelRef = String(item.payload.primaryModelRef);
        const fallbackModelRefs = Array.isArray(item.payload.fallbackModelRefs) ? item.payload.fallbackModelRefs : [];
        const enabled = item.payload.enabled === undefined ? true : Boolean(item.payload.enabled);
        if (mode === "canary") {
          for (const spaceId of targets) {
            const prevRes = await tx.query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3 LIMIT 1`, [params.tenantId, spaceId, purpose]);
            const prev = prevRes.rowCount ? { primaryModelRef: prevRes.rows[0].primary_model_ref, fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [], enabled: Boolean(prevRes.rows[0].enabled) } : null;
            rollback.actions.push({ kind: "model_routing.override_restore", spaceId, purpose, prev });
            await tx.query(`INSERT INTO routing_policies_overrides (tenant_id, space_id, purpose, primary_model_ref, fallback_model_refs, enabled) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (tenant_id, space_id, purpose) DO UPDATE SET primary_model_ref = EXCLUDED.primary_model_ref, fallback_model_refs = EXCLUDED.fallback_model_refs, enabled = EXCLUDED.enabled, updated_at = now()`, [params.tenantId, spaceId, purpose, primaryModelRef, JSON.stringify(fallbackModelRefs), enabled]);
          }
        } else {
          const prevRes = await tx.query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`, [params.tenantId, purpose]);
          const prev = prevRes.rowCount ? { primaryModelRef: prevRes.rows[0].primary_model_ref, fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [], enabled: Boolean(prevRes.rows[0].enabled) } : null;
          rollback.actions.push({ kind: "model_routing.restore", purpose, prev });
          await tx.query(`INSERT INTO routing_policies (tenant_id, purpose, primary_model_ref, fallback_model_refs, enabled) VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (tenant_id, purpose) DO UPDATE SET primary_model_ref = EXCLUDED.primary_model_ref, fallback_model_refs = EXCLUDED.fallback_model_refs, enabled = EXCLUDED.enabled, updated_at = now()`, [params.tenantId, purpose, primaryModelRef, JSON.stringify(fallbackModelRefs), enabled]);
        }
        continue;
      }

      if (item.kind === "model_routing.disable") {
        const purpose = String(item.payload.purpose);
        if (mode === "canary") {
          for (const spaceId of targets) {
            const prevRes = await tx.query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3 LIMIT 1`, [params.tenantId, spaceId, purpose]);
            const prev = prevRes.rowCount ? { primaryModelRef: prevRes.rows[0].primary_model_ref, fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [], enabled: Boolean(prevRes.rows[0].enabled) } : null;
            rollback.actions.push({ kind: "model_routing.override_restore", spaceId, purpose, prev });
            if (prevRes.rowCount) {
              await tx.query(`UPDATE routing_policies_overrides SET enabled = false, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3`, [params.tenantId, spaceId, purpose]);
            } else {
              const baseRes = await tx.query(`SELECT primary_model_ref, fallback_model_refs FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`, [params.tenantId, purpose]);
              if (baseRes.rowCount) {
                await tx.query(`INSERT INTO routing_policies_overrides (tenant_id, space_id, purpose, primary_model_ref, fallback_model_refs, enabled) VALUES ($1,$2,$3,$4,$5::jsonb,false) ON CONFLICT (tenant_id, space_id, purpose) DO UPDATE SET enabled = false, updated_at = now()`, [params.tenantId, spaceId, purpose, String(baseRes.rows[0].primary_model_ref), JSON.stringify(Array.isArray(baseRes.rows[0].fallback_model_refs) ? baseRes.rows[0].fallback_model_refs : [])]);
              }
            }
          }
        } else {
          const prevRes = await tx.query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`, [params.tenantId, purpose]);
          const prev = prevRes.rowCount ? { primaryModelRef: prevRes.rows[0].primary_model_ref, fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [], enabled: Boolean(prevRes.rows[0].enabled) } : null;
          rollback.actions.push({ kind: "model_routing.restore", purpose, prev });
          await tx.query(`UPDATE routing_policies SET enabled = false, updated_at = now() WHERE tenant_id = $1 AND purpose = $2`, [params.tenantId, purpose]);
        }
        continue;
      }

      if (item.kind === "artifact_policy.upsert") {
        const scopeType = String(item.payload.scopeType) as "tenant" | "space";
        const scopeId = String(item.payload.scopeId);
        const downloadTokenExpiresInSec = Number(item.payload.downloadTokenExpiresInSec);
        const downloadTokenMaxUses = Number(item.payload.downloadTokenMaxUses);
        const watermarkHeadersEnabled = Boolean(item.payload.watermarkHeadersEnabled);
        const prevRes = await tx.query(`SELECT download_token_expires_in_sec, download_token_max_uses, watermark_headers_enabled FROM artifact_policies WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 LIMIT 1`, [params.tenantId, scopeType, scopeId]);
        const prev = prevRes.rowCount ? { scopeType, scopeId, downloadTokenExpiresInSec: Number(prevRes.rows[0].download_token_expires_in_sec), downloadTokenMaxUses: Number(prevRes.rows[0].download_token_max_uses), watermarkHeadersEnabled: Boolean(prevRes.rows[0].watermark_headers_enabled) } : null;
        rollback.actions.push({ kind: "artifact_policy.restore", scopeType, scopeId, prev });
        await tx.query(`INSERT INTO artifact_policies (tenant_id, scope_type, scope_id, download_token_expires_in_sec, download_token_max_uses, watermark_headers_enabled) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE SET download_token_expires_in_sec = EXCLUDED.download_token_expires_in_sec, download_token_max_uses = EXCLUDED.download_token_max_uses, watermark_headers_enabled = EXCLUDED.watermark_headers_enabled, updated_at = now()`, [params.tenantId, scopeType, scopeId, downloadTokenExpiresInSec, downloadTokenMaxUses, watermarkHeadersEnabled]);
        continue;
      }
    }

    // P0-2: Eval admission 检查 — 在所有 schema compat checks 之后执行
    // 确保 schema_breaking_change / schema_migration_required 优先暴露
    // P2-7: 增强版 — 支持分类阈值 / 过期检测 / 核心套件强制检查 / 详细报告
    {
      const gate2 = await computeApprovalGate({ pool: params.pool, tenantId: params.tenantId, items });
      const requiredEvalSuites = await listChangeSetEvalBindings({ pool: params.pool, tenantId: params.tenantId, changesetId: cs.id });
      const isHighRisk = cs.riskLevel === "high" || cs.requiredApprovals >= 2;

      // P2-7: 查询核心回归套件
      const coreSuites = await listCoreEvalSuites({ pool: params.pool, tenantId: params.tenantId });
      const coreSuiteIds = coreSuites.map((s) => s.id);
      // 合并显式绑定 + 核心套件，去重
      const allSuiteIds = [...new Set([...requiredEvalSuites, ...coreSuiteIds])];

      if (gate2.evalAdmissionRequired && allSuiteIds.length === 0) {
        throw new Error("eval_not_passed");
      }

      const gateFailures: EvalGateFailure[] = [];

      if ((isHighRisk || gate2.evalAdmissionRequired || coreSuiteIds.length > 0) && allSuiteIds.length) {
        for (const suiteId of allSuiteIds) {
          const suite = await getEvalSuite({ pool: params.pool, tenantId: params.tenantId, id: suiteId });
          if (!suite) {
            gateFailures.push(buildEvalGateReport({ suiteId, reason: "missing", details: ["套件不存在"] }));
            continue;
          }

          const isCoreSuite = coreSuiteIds.includes(suiteId);
          // 核心套件：查全局最新运行；绑定套件：查 changeset 级別运行
          const latest = isCoreSuite && !requiredEvalSuites.includes(suiteId)
            ? await getLatestSucceededEvalRunGlobal({ pool: params.pool, tenantId: params.tenantId, suiteId: suite.id })
            : await getLatestEvalRunForChangeSet({ pool: params.pool, tenantId: params.tenantId, suiteId: suite.id, changesetId: cs.id });

          if (!latest) {
            gateFailures.push(buildEvalGateReport({ suiteId, suiteName: suite.name, reason: "missing", details: ["无评测运行记录"] }));
            continue;
          }

          // 状态检查
          if (latest.status === "running" || latest.status === "queued") {
            gateFailures.push(buildEvalGateReport({ suiteId, suiteName: suite.name, reason: "running", runId: latest.id, details: ["评测仍在运行中"] }));
            continue;
          }
          if (latest.status === "failed") {
            gateFailures.push(buildEvalGateReport({ suiteId, suiteName: suite.name, reason: "failed", runId: latest.id, details: ["评测运行失败"] }));
            continue;
          }

          // P2-7: 过期检测
          const maxStaleHours = typeof suite.thresholds?.maxStaleHours === "number" ? suite.thresholds.maxStaleHours : 0;
          if (maxStaleHours > 0 && isEvalRunStale({ runFinishedAt: latest.finishedAt, maxStaleHours })) {
            gateFailures.push(buildEvalGateReport({ suiteId, suiteName: suite.name, reason: "stale", runId: latest.id, details: [`评测结果已过期(超过${maxStaleHours}小时)`] }));
            continue;
          }

          // P2-7: 分类级别阈值检查
          if (suite.thresholds?.categoryThresholds) {
            const catResult = evalPassedWithCategories({ thresholds: suite.thresholds, summary: latest.summary });
            if (!catResult.passed) {
              gateFailures.push(buildEvalGateReport({
                suiteId, suiteName: suite.name,
                reason: "category_threshold_not_met",
                runId: latest.id,
                passRate: latest.summary?.passRate,
                categoryFailures: catResult.failedCategories,
                details: catResult.details,
              }));
              continue;
            }
          } else {
            // 全局阈值检查
            const passed = evalPassed({ thresholds: suite.thresholds, summary: latest.summary });
            if (!passed) {
              gateFailures.push(buildEvalGateReport({
                suiteId, suiteName: suite.name,
                reason: "threshold_not_met",
                runId: latest.id,
                passRate: latest.summary?.passRate,
                details: [`通过率 ${((latest.summary?.passRate ?? 0) * 100).toFixed(1)}% 未达到阈值`],
              }));
              continue;
            }
          }
        }
      }

      if (gateFailures.length > 0) {
        const err = new Error("eval_not_passed") as any;
        err.evalGateFailures = gateFailures;
        throw err;
      }
    }

    const upd = await tx.query(
      `UPDATE governance_changesets SET status = 'released', released_by = $3, released_at = now(), rollback_data = $4, canary_released_at = CASE WHEN $5 = 'canary' THEN now() ELSE NULL END, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [params.tenantId, params.id, params.releasedBy, rollback, mode],
    );
    await tx.query("COMMIT");
    return toCs(upd.rows[0]);
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
