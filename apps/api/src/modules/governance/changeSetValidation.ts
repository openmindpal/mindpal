/**
 * ChangeSet — Item validation + migration / policy / contract checks.
 */
import type { Pool, PoolClient } from "pg";
import { validatePolicyExpr, isPlainObject } from "@openslin/shared";
import { Errors } from "../../lib/errors";
import { getToolVersionByRef } from "../tools/toolRepo";
import { schemaDefSchema } from "../metadata/schemaModel";
import { getByNameVersion } from "../metadata/schemaRepo";
import { getPolicyVersion } from "../auth/policyVersionRepo";
import { getEnabledSkillRuntimeRunner } from "./skillRuntimeRepo";
import { getWorkbenchContract } from "../contracts/workbenchContract";
import { client, validateToolSupplyChain, type ChangeSetItemRow } from "./changeSetShared";

export async function validateItem(pool: Pool | PoolClient, tenantId: string, item: ChangeSetItemRow) {
  if (item.kind === "tool.set_active") {
    const toolRef = String(item.payload?.toolRef ?? "");
    const name = String(item.payload?.name ?? "");
    if (!toolRef || !name) throw new Error("invalid_item");
    if (!toolRef.startsWith(`${name}@`)) throw new Error("invalid_item");
    const ver = await getToolVersionByRef(client(pool), tenantId, toolRef);
    if (!ver || ver.status !== "released") throw new Error("tool_version_not_released");
    if (ver.artifactRef) {
      const gate = validateToolSupplyChain((ver as any).trustSummary, (ver as any).scanSummary, (ver as any).sbomSummary, (ver as any).sbomDigest);
      if (!gate.trust.ok) throw new Error("trust_not_verified");
      if (!gate.scan.ok) throw new Error("scan_not_passed");
      if (!gate.sbom.ok) throw new Error("sbom_not_present");
      if (gate.isolation.denied) {
        const override = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
        const runner = override ? { endpoint: override } : await getEnabledSkillRuntimeRunner({ pool: client(pool), tenantId });
        if (!runner) throw new Error("isolation_required");
      }
    }
    return;
  }
  if (item.kind === "tool.enable" || item.kind === "tool.disable") {
    const toolRef = String(item.payload?.toolRef ?? "");
    if (!toolRef) throw new Error("invalid_item");
    const ver = await getToolVersionByRef(client(pool), tenantId, toolRef);
    if (!ver || ver.status !== "released") throw new Error("tool_version_not_released");
    if (item.kind === "tool.enable" && ver.artifactRef) {
      const gate = validateToolSupplyChain((ver as any).trustSummary, (ver as any).scanSummary, (ver as any).sbomSummary, (ver as any).sbomDigest);
      if (!gate.trust.ok) throw new Error("trust_not_verified");
      if (!gate.scan.ok) throw new Error("scan_not_passed");
      if (!gate.sbom.ok) throw new Error("sbom_not_present");
      if (gate.isolation.denied) {
        const override = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
        const runner = override ? { endpoint: override } : await getEnabledSkillRuntimeRunner({ pool: client(pool), tenantId });
        if (!runner) throw new Error("isolation_required");
      }
    }
    return;
  }
  if (item.kind === "schema.publish") {
    const name = String(item.payload?.name ?? "");
    const schemaDef = schemaDefSchema.parse(item.payload?.schemaDef ?? null);
    if (!name || schemaDef.name !== name) throw new Error("invalid_item");
    const migrationRunId = item.payload?.migrationRunId;
    if (migrationRunId !== undefined && migrationRunId !== null) {
      const v = String(migrationRunId);
      if (!/^[0-9a-fA-F-]{36}$/.test(v)) throw new Error("invalid_item");
    }
    return;
  }
  if (item.kind === "schema.set_active") {
    const name = String(item.payload?.name ?? "");
    const version = Number(item.payload?.version);
    if (!name || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
    const stored = await getByNameVersion(pool as any, name, version);
    if (!stored || stored.status !== "released") throw new Error("invalid_item");
    const migrationRunId = item.payload?.migrationRunId;
    if (migrationRunId !== undefined && migrationRunId !== null) {
      const v = String(migrationRunId);
      if (!/^[0-9a-fA-F-]{36}$/.test(v)) throw new Error("invalid_item");
    }
    return;
  }
  if (item.kind === "schema.rollback") {
    const name = String(item.payload?.name ?? "");
    if (!name) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "ui.page.publish") {
    const pageName = String(item.payload?.pageName ?? "");
    if (!pageName) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "ui.page.rollback") {
    const pageName = String(item.payload?.pageName ?? "");
    if (!pageName) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.version.release") {
    const name = String(item.payload?.name ?? "");
    const version = Number(item.payload?.version);
    if (!name || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
    const pv = await getPolicyVersion({ pool: pool as any, tenantId, name, version });
    if (!pv || pv.status !== "draft") throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.publish") {
    const policyId = String(item.payload?.policyId ?? "");
    const version = Number(item.payload?.version);
    if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("invalid_item");
    if (!Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
    const pv = await client(pool).query(
      `
        SELECT v.status
        FROM safety_policy_versions v
        JOIN safety_policies p ON p.policy_id = v.policy_id
        WHERE p.tenant_id = $1 AND p.policy_id = $2 AND v.version = $3
        LIMIT 1
      `,
      [tenantId, policyId, version],
    );
    if (!pv.rowCount) throw new Error("invalid_item");
    const st = String(pv.rows[0].status);
    if (!["draft", "submitted", "approved"].includes(st)) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.set_active") {
    const policyId = String(item.payload?.policyId ?? "");
    const version = Number(item.payload?.version);
    if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("invalid_item");
    if (!Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
    const pv = await client(pool).query(
      `
        SELECT v.status
        FROM safety_policy_versions v
        JOIN safety_policies p ON p.policy_id = v.policy_id
        WHERE p.tenant_id = $1 AND p.policy_id = $2 AND v.version = $3
        LIMIT 1
      `,
      [tenantId, policyId, version],
    );
    if (!pv.rowCount || String(pv.rows[0].status) !== "released") throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.rollback") {
    const policyId = String(item.payload?.policyId ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("invalid_item");
    const cur = await client(pool).query(`SELECT active_version FROM safety_policy_active_versions WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1`, [tenantId, policyId]);
    if (!cur.rowCount) throw new Error("invalid_item");
    const prev = await client(pool).query(
      `SELECT version FROM safety_policy_versions WHERE policy_id = $1 AND status = 'released' AND version < $2 ORDER BY version DESC LIMIT 1`,
      [policyId, Number(cur.rows[0].active_version)],
    );
    if (!prev.rowCount) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.set_override") {
    const policyId = String(item.payload?.policyId ?? "");
    const spaceId = String(item.payload?.spaceId ?? "");
    const version = Number(item.payload?.version);
    if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("invalid_item");
    if (!spaceId) throw new Error("invalid_item");
    if (!Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
    const pv = await client(pool).query(
      `
        SELECT v.status
        FROM safety_policy_versions v
        JOIN safety_policies p ON p.policy_id = v.policy_id
        WHERE p.tenant_id = $1 AND p.policy_id = $2 AND v.version = $3
        LIMIT 1
      `,
      [tenantId, policyId, version],
    );
    if (!pv.rowCount || String(pv.rows[0].status) !== "released") throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.cache.invalidate") {
    const scopeType = String(item.payload?.scopeType ?? "");
    const scopeId = String(item.payload?.scopeId ?? "");
    const reason = String(item.payload?.reason ?? "");
    if (scopeType !== "tenant" && scopeType !== "space") throw new Error("invalid_item");
    if (!scopeId) throw new Error("invalid_item");
    if (!reason || reason.length > 500) throw new Error("invalid_item");
    const csRes = await client(pool).query("SELECT scope_type, scope_id FROM governance_changesets WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
      tenantId,
      item.changesetId,
    ]);
    if (!csRes.rowCount) throw new Error("invalid_item");
    const csScopeType = csRes.rows[0].scope_type as "tenant" | "space";
    const csScopeId = String(csRes.rows[0].scope_id);
    if (scopeType !== csScopeType || scopeId !== csScopeId) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "workbench.plugin.publish") {
    const workbenchKey = String(item.payload?.workbenchKey ?? "");
    if (!workbenchKey) throw new Error("invalid_item");
    const csRes = await client(pool).query("SELECT scope_type, scope_id FROM governance_changesets WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
      tenantId,
      item.changesetId,
    ]);
    if (!csRes.rowCount) throw new Error("invalid_item");
    const scopeType = csRes.rows[0].scope_type as "tenant" | "space";
    const scopeId = String(csRes.rows[0].scope_id);
    const draft = await getWorkbenchContract().getDraftVersion({ pool: pool as any, tenantId, scopeType, scopeId, workbenchKey });
    if (!draft) throw Errors.badRequest("workbench draft 不存在");
    return;
  }
  if (item.kind === "workbench.plugin.rollback") {
    const workbenchKey = String(item.payload?.workbenchKey ?? "");
    if (!workbenchKey) throw new Error("invalid_item");
    const csRes = await client(pool).query("SELECT scope_type, scope_id FROM governance_changesets WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
      tenantId,
      item.changesetId,
    ]);
    if (!csRes.rowCount) throw new Error("invalid_item");
    const scopeType = csRes.rows[0].scope_type as "tenant" | "space";
    const scopeId = String(csRes.rows[0].scope_id);
    const cur = await getWorkbenchContract().getActiveVersion({ pool: pool as any, tenantId, scopeType, scopeId, workbenchKey });
    if (!cur) throw Errors.badRequest("workbench 尚未设置 activeVersion");
    const prev = await getWorkbenchContract().getPreviousReleasedVersion({ pool: pool as any, tenantId, scopeType, scopeId, workbenchKey, beforeVersion: cur });
    if (!prev) throw Errors.workbenchNoPreviousVersion();
    return;
  }
  if (item.kind === "workbench.plugin.canary") {
    const workbenchKey = String(item.payload?.workbenchKey ?? "");
    const canaryVersion = Number(item.payload?.canaryVersion);
    const subjectIds = Array.isArray(item.payload?.subjectIds) ? item.payload.subjectIds : [];
    if (!workbenchKey) throw new Error("invalid_item");
    if (!Number.isFinite(canaryVersion) || canaryVersion <= 0) throw new Error("invalid_item");
    if (subjectIds.length > 500) throw new Error("invalid_item");
    const csRes = await client(pool).query("SELECT scope_type, scope_id FROM governance_changesets WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
      tenantId,
      item.changesetId,
    ]);
    if (!csRes.rowCount) throw new Error("invalid_item");
    const scopeType = csRes.rows[0].scope_type as "tenant" | "space";
    const scopeId = String(csRes.rows[0].scope_id);
    const verRes = await client(pool).query(
      `
        SELECT 1
        FROM workbench_plugin_versions
        WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 AND status = 'released' AND version = $5
        LIMIT 1
      `,
      [tenantId, scopeType, scopeId, workbenchKey, canaryVersion],
    );
    if (!verRes.rowCount) throw Errors.badRequest("workbench canaryVersion 未发布");
    return;
  }
  if (item.kind === "model_routing.upsert") {
    const purpose = String(item.payload?.purpose ?? "");
    const primaryModelRef = String(item.payload?.primaryModelRef ?? "");
    const enabled = item.payload?.enabled === undefined ? true : Boolean(item.payload?.enabled);
    const fallbacks = Array.isArray(item.payload?.fallbackModelRefs) ? item.payload.fallbackModelRefs : [];
    if (!purpose || purpose.length > 100) throw new Error("invalid_item");
    if (!primaryModelRef || primaryModelRef.length < 3) throw new Error("invalid_item");
    if (fallbacks.length > 10) throw new Error("invalid_item");
    if (typeof enabled !== "boolean") throw new Error("invalid_item");
    return;
  }
  if (item.kind === "model_routing.disable") {
    const purpose = String(item.payload?.purpose ?? "");
    if (!purpose || purpose.length > 100) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "artifact_policy.upsert") {
    const scopeType = String(item.payload?.scopeType ?? "");
    const scopeId = String(item.payload?.scopeId ?? "");
    const expiresInSec = Number(item.payload?.downloadTokenExpiresInSec);
    const maxUses = Number(item.payload?.downloadTokenMaxUses);
    const watermarkHeadersEnabled = item.payload?.watermarkHeadersEnabled;
    if (scopeType !== "tenant" && scopeType !== "space") throw new Error("invalid_item");
    if (!scopeId) throw new Error("invalid_item");
    if (!Number.isFinite(expiresInSec) || expiresInSec <= 0 || expiresInSec > 3600) throw new Error("invalid_item");
    if (!Number.isFinite(maxUses) || maxUses <= 0 || maxUses > 10) throw new Error("invalid_item");
    if (typeof watermarkHeadersEnabled !== "boolean") throw new Error("invalid_item");
    return;
  }
  throw new Error("invalid_item");
}

// ---- Migration Gate ----

export async function assertMigrationGate(params: { pool: Pool | PoolClient; tenantId: string; migrationRunId: string; schemaName: string; targetVersion: number }) {
  const res = await params.pool.query(
    `
      SELECT r.status, m.schema_name, m.target_version
      FROM schema_migration_runs r
      JOIN schema_migrations m ON m.migration_id = r.migration_id
      WHERE r.tenant_id = $1 AND r.migration_run_id = $2
      LIMIT 1
    `,
    [params.tenantId, params.migrationRunId],
  );
  if (!res.rowCount) throw new Error("migration_required");
  const row = res.rows[0] as any;
  if (String(row.status ?? "") !== "succeeded") throw new Error("migration_required");
  if (String(row.schema_name ?? "") !== params.schemaName) throw new Error("migration_required");
  if (Number(row.target_version ?? 0) !== params.targetVersion) throw new Error("migration_required");
}

// ---- Schema helpers ----

export function defaultValueForSchemaType(type: string) {
  const t = String(type ?? "").trim().toLowerCase();
  if (t === "string") return "";
  if (t === "number") return 0;
  if (t === "boolean") return false;
  if (t === "datetime") return new Date(0).toISOString();
  if (t === "json") return null;
  return null;
}

export function generateSchemaMigrationDraftsV1(params: {
  scopeType: "tenant" | "space";
  scopeId: string;
  schemaName: string;
  targetVersionHint: number;
  schemaDef: any;
  requiredFieldPaths: string[];
}) {
  const drafts: any[] = [];
  const rollbackPlanSummary = {
    rollbackScope: { scopeType: params.scopeType, scopeId: params.scopeId },
    stopPlan: {
      cancelRun: { method: "POST", path: "/governance/schema-migration-runs/:id/cancel" },
      note: "取消仅停止后续批处理；已写入的数据不自动逆转",
    },
    schemaRollbackPlan: {
      note: "通过 changeset 将 schema active 指针回退到上一 released 版本（或 set_active 指向旧版本）",
      supportedKinds: ["schema.rollback", "schema.set_active"],
    },
    dataRollbackLimitations: "已写入的 payload 字段不保证自动回滚；必要时需另行编写数据修复迁移",
  };

  function resolveFieldType(path: string) {
    const seg = String(path ?? "").split(".").map((s) => s.trim()).filter(Boolean);
    if (seg.length < 2) return null;
    const entityName = seg[0];
    const fieldName = seg.slice(1).join(".");
    const entity = params.schemaDef?.entities?.[entityName];
    const field = entity?.fields?.[fieldName];
    return String(field?.type ?? "").trim() || null;
  }

  for (const p of params.requiredFieldPaths) {
    const seg = String(p ?? "").split(".").map((s) => s.trim()).filter(Boolean);
    if (seg.length < 2) continue;
    const entityName = seg[0];
    const fieldPath = seg.slice(1).join(".");
    const t = resolveFieldType(p);
    drafts.push({
      kind: "backfill_required_field",
      params: { entityName, fieldPath, defaultValue: defaultValueForSchemaType(t ?? ""), batchSize: 200 },
      evidenceDigest: { kind: "backfill_required_field", schemaName: params.schemaName, targetVersion: params.targetVersionHint, entityName, fieldPath },
      rollbackPlanSummary,
      createRequest: {
        method: "POST",
        path: "/governance/schema-migrations",
        body: {
          scopeType: params.scopeType,
          scopeId: params.scopeId,
          schemaName: params.schemaName,
          targetVersion: params.targetVersionHint,
          kind: "backfill_required_field",
          plan: { entityName, fieldPath, defaultValue: defaultValueForSchemaType(t ?? ""), batchSize: 200 },
        },
      },
    });
  }

  const entities = params.schemaDef?.entities ?? {};
  for (const [entityName, entity] of Object.entries<any>(entities)) {
    const fields = entity?.fields ?? {};
    for (const [fieldName, field] of Object.entries<any>(fields)) {
      const ext = field?.extensions;
      const renameFrom = ext && typeof ext === "object" && !Array.isArray(ext) ? (ext as any)?.["io.openslin.migrate"]?.renameFrom : undefined;
      const fromPath = typeof renameFrom === "string" ? renameFrom.trim() : "";
      if (!fromPath) continue;
      const toPath = String(fieldName ?? "").trim();
      if (!toPath) continue;
      drafts.push({
        kind: "rename_field_dual_write",
        params: { entityName, fromPath, toPath },
        evidenceDigest: { kind: "rename_field_dual_write", schemaName: params.schemaName, targetVersion: params.targetVersionHint, entityName, fromPath, toPath },
        rollbackPlanSummary,
        createRequest: {
          method: "POST",
          path: "/governance/schema-migrations",
          body: {
            scopeType: params.scopeType,
            scopeId: params.scopeId,
            schemaName: params.schemaName,
            targetVersion: params.targetVersionHint,
            kind: "rename_field_dual_write",
            plan: { entityName, fromPath, toPath, batchSize: 200 },
          },
        },
      });
    }
  }

  return drafts;
}

export async function checkPolicyVersionContract(params: { pool: Pool | PoolClient; tenantId: string; name: string; version: number }) {
  const pv = await getPolicyVersion({ pool: params.pool as any, tenantId: params.tenantId, name: params.name, version: params.version });
  if (!pv) {
    return { status: "fail" as const, errorCode: "CONTRACT_NOT_COMPATIBLE", messageI18n: { "zh-CN": "PolicyVersion 不存在", "en-US": "PolicyVersion not found" }, digest: null };
  }
  const policyJson = pv.policyJson;
  if (!isPlainObject(policyJson)) {
    return { status: "fail" as const, errorCode: "CONTRACT_NOT_COMPATIBLE", messageI18n: { "zh-CN": "policyJson 非对象", "en-US": "policyJson must be an object" }, digest: pv.digest };
  }
  const expr = (policyJson as any).rowFiltersExpr ?? (policyJson as any).policyExpr ?? null;
  if (expr !== null && expr !== undefined) {
    const v = validatePolicyExpr(expr);
    if (!v.ok) {
      return { status: "fail" as const, errorCode: "CONTRACT_NOT_COMPATIBLE", messageI18n: { "zh-CN": v.message, "en-US": v.message }, digest: pv.digest };
    }
  }
  return { status: "pass" as const, errorCode: null, messageI18n: null, digest: pv.digest };
}
