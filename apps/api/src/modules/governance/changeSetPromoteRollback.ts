/**
 * ChangeSet — Promote (canary → full) and Rollback logic.
 */
import type { Pool } from "pg";
import { getByNameVersion, getEffectiveSchema, getPreviousReleasedSchemaVersion, getActiveSchemaOverride, setActiveSchemaOverride, setActiveSchemaVersion, clearActiveSchemaOverride } from "../metadata/schemaRepo";
import { getPageConfigContract } from "../contracts/pageConfigContract";
import { getWorkbenchContract } from "../contracts/workbenchContract";
import {
  clearActiveToolOverride, clearActiveToolRef, deleteToolRollout,
  getActiveToolOverride, getActiveToolRef, getToolRolloutEnabled,
  setActiveToolOverride, setActiveToolRef, setToolRollout,
} from "./toolGovernanceRepo";
import { client, toCs } from "./changeSetShared";
import { createChangeSet, getChangeSet, listChangeSetItems } from "./changeSetCrud";
import { validateItem } from "./changeSetValidation";

export async function promoteChangeSet(params: { pool: Pool; tenantId: string; id: string; promotedBy: string }) {
  const cs = await getChangeSet(params);
  if (!cs) throw new Error("changeset_not_found");
  if (cs.status !== "released") throw new Error("changeset_not_released");
  if (!cs.canaryReleasedAt) throw new Error("changeset_not_canary_released");
  if (cs.promotedAt) throw new Error("changeset_already_promoted");
  const targets = cs.canaryTargets ?? [];
  if (!targets.length) throw new Error("canary_targets_missing");

  const items = await listChangeSetItems({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  const rollback = cs.rollbackData && Array.isArray(cs.rollbackData.actions) ? cs.rollbackData : { actions: [] };

  const tx = await params.pool.connect();
  try {
    await tx.query("BEGIN");
    const locked = await tx.query(`SELECT status, promoted_at FROM governance_changesets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [params.tenantId, params.id]);
    if (!locked.rowCount || locked.rows[0].status !== "released") throw new Error("changeset_not_released");
    if (locked.rows[0].promoted_at) throw new Error("changeset_already_promoted");

    for (const item of items) {
      await validateItem(tx, params.tenantId, item);

      if (item.kind === "tool.enable" || item.kind === "tool.disable") {
        const toolRef = String(item.payload.toolRef);
        const enabled = item.kind === "tool.enable";
        const prev = await getToolRolloutEnabled({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef });
        rollback.actions.push({ kind: "tool.set_enabled", scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled: prev });
        await setToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled });
        for (const spaceId of targets) await deleteToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType: "space", scopeId: spaceId, toolRef });
        continue;
      }

      if (item.kind === "tool.set_active") {
        const toolRef = String(item.payload.toolRef);
        const name = String(item.payload.name);
        const prev = await getActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name });
        rollback.actions.push({ kind: "tool.set_active", name, toolRef: prev?.activeToolRef ?? null });
        await setActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name, toolRef });
        for (const spaceId of targets) await clearActiveToolOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name });
        continue;
      }

      if (item.kind === "schema.publish") {
        const schemaName = String(item.payload?.name ?? "");
        const published = Number(rollback.schemaPublishedVersions?.[schemaName]);
        const latest = await tx.query("SELECT version FROM schemas WHERE name = $1 AND status = 'released' ORDER BY version DESC LIMIT 1", [schemaName]);
        const version = Number.isFinite(published) && published > 0 ? published : latest.rowCount ? Number(latest.rows[0].version) : null;
        if (!version) throw new Error("schema_published_missing");
        if (cs.scopeType === "space") {
          const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prev ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version: version as any });
        } else {
          const prev = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version: version as any });
        }
        for (const spaceId of targets) await clearActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
        continue;
      }

      if (item.kind === "schema.set_active") {
        const schemaName = String(item.payload?.name ?? "");
        const version = Number(item.payload?.version);
        if (!Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const stored = await getByNameVersion(tx as any, schemaName, version);
        if (!stored || stored.status !== "released") throw new Error("invalid_item");
        if (cs.scopeType === "space") {
          const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prev ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version });
        } else {
          const prev = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version });
        }
        for (const spaceId of targets) await clearActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
        continue;
      }

      if (item.kind === "schema.rollback") {
        const schemaName = String(item.payload?.name ?? "");
        if (cs.scopeType === "space") {
          const cur = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          if (!cur) throw new Error("schema_not_found");
          const prevVersion = await getPreviousReleasedSchemaVersion({ pool: tx as any, name: schemaName, beforeVersion: cur.version });
          if (!prevVersion) throw new Error("schema_prev_missing");
          const prevOverride = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prevOverride ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version: prevVersion });
        } else {
          const cur = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
          if (!cur) throw new Error("schema_not_found");
          const prevVersion = await getPreviousReleasedSchemaVersion({ pool: tx as any, name: schemaName, beforeVersion: cur.version });
          if (!prevVersion) throw new Error("schema_prev_missing");
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: cur.version });
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version: prevVersion });
        }
        for (const spaceId of targets) await clearActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
        continue;
      }

      if (item.kind === "model_routing.upsert") {
        const purpose = String(item.payload.purpose);
        const primaryModelRef = String(item.payload.primaryModelRef);
        const fallbackModelRefs = Array.isArray(item.payload.fallbackModelRefs) ? item.payload.fallbackModelRefs : [];
        const enabled = item.payload.enabled === undefined ? true : Boolean(item.payload.enabled);
        const prevRes = await tx.query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`, [params.tenantId, purpose]);
        const prev = prevRes.rowCount ? { primaryModelRef: prevRes.rows[0].primary_model_ref, fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [], enabled: Boolean(prevRes.rows[0].enabled) } : null;
        rollback.actions.push({ kind: "model_routing.restore", purpose, prev });
        await tx.query(`INSERT INTO routing_policies (tenant_id, purpose, primary_model_ref, fallback_model_refs, enabled) VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (tenant_id, purpose) DO UPDATE SET primary_model_ref = EXCLUDED.primary_model_ref, fallback_model_refs = EXCLUDED.fallback_model_refs, enabled = EXCLUDED.enabled, updated_at = now()`, [params.tenantId, purpose, primaryModelRef, JSON.stringify(fallbackModelRefs), enabled]);
        for (const spaceId of targets) await tx.query(`DELETE FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3`, [params.tenantId, spaceId, purpose]);
        continue;
      }

      if (item.kind === "model_routing.disable") {
        const purpose = String(item.payload.purpose);
        const prevRes = await tx.query(`SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`, [params.tenantId, purpose]);
        const prev = prevRes.rowCount ? { primaryModelRef: prevRes.rows[0].primary_model_ref, fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [], enabled: Boolean(prevRes.rows[0].enabled) } : null;
        rollback.actions.push({ kind: "model_routing.restore", purpose, prev });
        await tx.query(`UPDATE routing_policies SET enabled = false, updated_at = now() WHERE tenant_id = $1 AND purpose = $2`, [params.tenantId, purpose]);
        for (const spaceId of targets) await tx.query(`DELETE FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3`, [params.tenantId, spaceId, purpose]);
        continue;
      }
    }

    const upd = await tx.query(`UPDATE governance_changesets SET promoted_at = now(), rollback_data = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`, [params.tenantId, params.id, rollback]);
    await tx.query("COMMIT");
    return toCs(upd.rows[0]);
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}

export async function rollbackChangeSet(params: { pool: Pool; tenantId: string; id: string; createdBy: string }) {
  const cs = await getChangeSet(params);
  if (!cs) throw new Error("changeset_not_found");
  if (cs.status !== "released") throw new Error("changeset_not_released");
  const rollback = cs.rollbackData;
  if (!rollback || !Array.isArray(rollback.actions)) throw new Error("rollback_data_missing");

  const tx = await params.pool.connect();
  try {
    await tx.query("BEGIN");
    const locked = await tx.query(`SELECT status, scope_type, scope_id FROM governance_changesets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [params.tenantId, params.id]);
    if (!locked.rowCount || locked.rows[0].status !== "released") throw new Error("changeset_not_released");

    const rb = await createChangeSet({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, title: `rollback:${cs.id}`, createdBy: params.createdBy });
    await tx.query(`UPDATE governance_changesets SET rollback_of = $3, status = 'approved', approved_by = $4, approved_at = now(), updated_at = now() WHERE id = $2 AND tenant_id = $1`, [params.tenantId, rb.id, cs.id, params.createdBy]);

    for (const a of rollback.actions) {
      if (a.kind === "tool.set_enabled") {
        const scopeType = (a.scopeType as "tenant" | "space" | undefined) ?? cs.scopeType;
        const scopeId = (a.scopeId as string | undefined) ?? cs.scopeId;
        if (a.enabled === null || a.enabled === undefined) {
          await deleteToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, toolRef: String(a.toolRef) });
        } else {
          await setToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, toolRef: String(a.toolRef), enabled: Boolean(a.enabled) });
        }
        continue;
      }
      if (a.kind === "tool.set_active") {
        const name = String(a.name);
        const toolRef = a.toolRef ? String(a.toolRef) : null;
        if (toolRef) await setActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name, toolRef });
        else await clearActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name });
        continue;
      }
      if (a.kind === "tool.set_active_override") {
        const spaceId = String(a.spaceId);
        const name = String(a.name);
        const toolRef = a.toolRef ? String(a.toolRef) : null;
        if (toolRef) await setActiveToolOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name, toolRef });
        else await clearActiveToolOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name });
        continue;
      }
      if (a.kind === "model_routing.restore") {
        const purpose = String(a.purpose);
        const prev = a.prev ?? null;
        if (!prev) { await tx.query(`DELETE FROM routing_policies WHERE tenant_id = $1 AND purpose = $2`, [params.tenantId, purpose]); }
        else { await tx.query(`INSERT INTO routing_policies (tenant_id, purpose, primary_model_ref, fallback_model_refs, enabled) VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (tenant_id, purpose) DO UPDATE SET primary_model_ref = EXCLUDED.primary_model_ref, fallback_model_refs = EXCLUDED.fallback_model_refs, enabled = EXCLUDED.enabled, updated_at = now()`, [params.tenantId, purpose, String(prev.primaryModelRef), JSON.stringify(Array.isArray(prev.fallbackModelRefs) ? prev.fallbackModelRefs : []), Boolean(prev.enabled)]); }
        continue;
      }
      if (a.kind === "model_routing.override_restore") {
        const spaceId = String(a.spaceId);
        const purpose = String(a.purpose);
        const prev = a.prev ?? null;
        if (!prev) { await tx.query(`DELETE FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3`, [params.tenantId, spaceId, purpose]); }
        else { await tx.query(`INSERT INTO routing_policies_overrides (tenant_id, space_id, purpose, primary_model_ref, fallback_model_refs, enabled) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (tenant_id, space_id, purpose) DO UPDATE SET primary_model_ref = EXCLUDED.primary_model_ref, fallback_model_refs = EXCLUDED.fallback_model_refs, enabled = EXCLUDED.enabled, updated_at = now()`, [params.tenantId, spaceId, purpose, String(prev.primaryModelRef), JSON.stringify(Array.isArray(prev.fallbackModelRefs) ? prev.fallbackModelRefs : []), Boolean(prev.enabled)]); }
        continue;
      }
      if (a.kind === "artifact_policy.restore") {
        const scopeType = String(a.scopeType); const scopeId = String(a.scopeId); const prev = a.prev ?? null;
        if (!prev) { await tx.query(`DELETE FROM artifact_policies WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3`, [params.tenantId, scopeType, scopeId]); }
        else { await tx.query(`INSERT INTO artifact_policies (tenant_id, scope_type, scope_id, download_token_expires_in_sec, download_token_max_uses, watermark_headers_enabled) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE SET download_token_expires_in_sec = EXCLUDED.download_token_expires_in_sec, download_token_max_uses = EXCLUDED.download_token_max_uses, watermark_headers_enabled = EXCLUDED.watermark_headers_enabled, updated_at = now()`, [params.tenantId, scopeType, scopeId, Number(prev.downloadTokenExpiresInSec), Number(prev.downloadTokenMaxUses), Boolean(prev.watermarkHeadersEnabled)]); }
        continue;
      }
      if (a.kind === "policy.version.restore") {
        const name = String(a.name ?? ""); const version = Number(a.version); const prevStatus = String(a.prevStatus ?? "draft"); const prevPublishedAt = a.prevPublishedAt ?? null;
        if (!name || !Number.isFinite(version) || version <= 0) throw new Error("rollback_failed");
        await tx.query(`UPDATE policy_versions SET status = $4, published_at = $5 WHERE tenant_id = $1 AND name = $2 AND version = $3`, [params.tenantId, name, version, prevStatus, prevPublishedAt]);
        continue;
      }
      if (a.kind === "safety_policy.version.restore") {
        const policyId = String(a.policyId ?? ""); const version = Number(a.version); const prevStatus = String(a.prevStatus ?? "draft"); const prevPublishedAt = a.prevPublishedAt ?? null;
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId) || !Number.isFinite(version) || version <= 0) throw new Error("rollback_failed");
        await tx.query(`UPDATE safety_policy_versions v SET status = $4, published_at = $5, updated_at = now() WHERE v.policy_id = $1 AND v.version = $2 AND EXISTS (SELECT 1 FROM safety_policies p WHERE p.policy_id = v.policy_id AND p.tenant_id = $3)`, [policyId, version, params.tenantId, prevStatus, prevPublishedAt]);
        continue;
      }
      if (a.kind === "safety_policy.set_active") {
        const policyId = String(a.policyId ?? ""); const prevVersion = a.prevVersion === null || a.prevVersion === undefined ? null : Number(a.prevVersion);
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("rollback_failed");
        if (prevVersion === null) { await tx.query(`DELETE FROM safety_policy_active_versions WHERE tenant_id = $1 AND policy_id = $2`, [params.tenantId, policyId]); }
        else { await tx.query(`INSERT INTO safety_policy_active_versions (tenant_id, policy_id, active_version) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, policy_id) DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()`, [params.tenantId, policyId, prevVersion]); }
        continue;
      }
      if (a.kind === "safety_policy.set_override") {
        const policyId = String(a.policyId ?? ""); const spaceId = String(a.spaceId ?? ""); const prevVersion = a.prevVersion === null || a.prevVersion === undefined ? null : Number(a.prevVersion);
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId) || !spaceId) throw new Error("rollback_failed");
        if (prevVersion === null) { await tx.query(`DELETE FROM safety_policy_active_overrides WHERE tenant_id = $1 AND space_id = $2 AND policy_id = $3`, [params.tenantId, spaceId, policyId]); }
        else { await tx.query(`INSERT INTO safety_policy_active_overrides (tenant_id, space_id, policy_id, active_version) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, space_id, policy_id) DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()`, [params.tenantId, spaceId, policyId, prevVersion]); }
        continue;
      }
      if (a.kind === "schema.set_active") {
        const schemaName = String(a.schemaName); const version = a.version === null || a.version === undefined ? null : Number(a.version);
        const { clearActiveSchemaVersion } = await import("../metadata/schemaRepo");
        if (version === null) { await clearActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName }); }
        else { await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version }); }
        continue;
      }
      if (a.kind === "schema.set_active_override") {
        const spaceId = String(a.spaceId); const schemaName = String(a.schemaName); const version = a.version === null || a.version === undefined ? null : Number(a.version);
        if (version === null) { await clearActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName }); }
        else { await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName, version }); }
        continue;
      }
      if (a.kind === "ui.page.restore") {
        const pageName = String(a.pageName); const publishedVersion = Number(a.publishedVersion); const restoreToVersion = a.restoreToVersion === null || a.restoreToVersion === undefined ? null : Number(a.restoreToVersion);
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, name: pageName } as const;
        const pc = getPageConfigContract();
        if (restoreToVersion === null) { await pc.setPageVersionStatus(tx as any, key, publishedVersion, "rolled_back"); }
        else { const cloned = await pc.cloneReleasedVersion(tx as any, key, restoreToVersion); if (!cloned) throw new Error("ui_restore_missing_source"); }
        continue;
      }
      if (a.kind === "workbench.set_active") {
        const scopeType = (a.scopeType as "tenant" | "space" | undefined) ?? cs.scopeType;
        const scopeId = (a.scopeId as string | undefined) ?? cs.scopeId;
        const workbenchKey = String(a.workbenchKey); const version = a.version === null || a.version === undefined ? null : Number(a.version);
        const wb = getWorkbenchContract();
        if (version === null) { await wb.clearActiveVersion({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, workbenchKey }); }
        else { await wb.setActiveVersion({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, workbenchKey, activeVersion: version }); }
        continue;
      }
      if (a.kind === "workbench.set_canary") {
        const scopeType = (a.scopeType as "tenant" | "space" | undefined) ?? cs.scopeType;
        const scopeId = (a.scopeId as string | undefined) ?? cs.scopeId;
        const workbenchKey = String(a.workbenchKey); const prev = a.prev ?? null;
        const wb2 = getWorkbenchContract();
        if (!prev) { await wb2.clearCanaryConfig({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, workbenchKey }); }
        else { await wb2.setCanaryConfig({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, workbenchKey, canaryVersion: Number(prev.canaryVersion), subjectIds: Array.isArray(prev.subjectIds) ? prev.subjectIds : [] }); }
        continue;
      }
    }

    await tx.query(`UPDATE governance_changesets SET status = 'rolled_back', updated_at = now() WHERE tenant_id = $1 AND id = $2`, [params.tenantId, cs.id]);
    await tx.query(`UPDATE governance_changesets SET status = 'released', released_by = $3, released_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`, [params.tenantId, rb.id, params.createdBy]);

    await tx.query("COMMIT");
    const out = await getChangeSet({ pool: params.pool, tenantId: params.tenantId, id: rb.id });
    if (!out) throw new Error("rollback_created_missing");
    return out;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
