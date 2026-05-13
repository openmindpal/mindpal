import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { enqueueAuditOutboxForRequest } from "../../modules/audit/requestOutbox";
import { getConnectorInstance } from "../../lib/connectorContract";
import { encryptSecretEnvelope } from "../../modules/secrets/envelope";
import { createSecretRecord, getSecretRecord, listSecretRecords, retireSecretRecord, revokeSecretRecord } from "../../modules/secrets/secretRepo";
import { listSecretUsageEvents } from "../../modules/secrets/usageRepo";

function resolveScope(subject: { tenantId: string; spaceId?: string | null }) {
  if (subject.spaceId) return { scopeType: "space" as const, scopeId: subject.spaceId };
  return { scopeType: "tenant" as const, scopeId: subject.tenantId };
}

function masterKey() {
  return process.env.API_MASTER_KEY ?? "dev-master-key-change-me";
}

export const secretRoutes: FastifyPluginAsync = async (app) => {
  app.get("/secrets", async (req) => {
    setAuditContext(req, { resourceType: "secret", action: "read" });
    const decision = await requirePermission({ req, resourceType: "secret", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const secrets = await listSecretRecords(app.db, subject.tenantId, scope.scopeType, scope.scopeId);
    return { scope, secrets };
  });

  app.post("/secrets", async (req) => {
    setAuditContext(req, { resourceType: "secret", action: "create", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "secret", action: "create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z
      .object({
        connectorInstanceId: z.string().min(3),
        payload: z.record(z.string(), z.any()),
      })
      .parse(req.body);

    const inst = await getConnectorInstance(app.db, subject.tenantId, body.connectorInstanceId);
    if (!inst) throw Errors.badRequest("ConnectorInstance 不存在");
    if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");

    const enc = await encryptSecretEnvelope({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      masterKey: masterKey(),
      payload: body.payload,
    });
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const secret = await createSecretRecord({
        pool: client,
        tenantId: subject.tenantId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        connectorInstanceId: body.connectorInstanceId,
        encryptedPayload: enc.encryptedPayload,
        keyVersion: enc.keyVersion,
        encFormat: enc.encFormat,
        keyRef: enc.keyRef,
      });
      req.ctx.audit!.outputDigest = { secretId: secret.id, connectorInstanceId: secret.connectorInstanceId, scopeType: secret.scopeType };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { scope, secret };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      const msg = String((e as any)?.message ?? e ?? "");
      if (msg.includes("audit_outbox") || msg.includes("AUDIT_OUTBOX") || msg === "subject_missing") throw Errors.auditOutboxWriteFailed();
      throw e;
    } finally {
      client.release();
    }
  });

  app.get("/secrets/:id", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "secret", action: "read" });
    const decision = await requirePermission({ req, resourceType: "secret", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const secret = await getSecretRecord(app.db, subject.tenantId, params.id);
    if (!secret) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Secret 不存在", "en-US": "Secret not found" }, traceId: req.ctx.traceId });
    return { secret };
  });

  app.put("/secrets/:id", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "secret", action: "update", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "secret", action: "update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        tags: z.array(z.string().max(100)).max(50).optional(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");

      const locked = await client.query(
        "SELECT id, tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, credential_version, rotated_from_id, enc_format, key_ref, created_at, updated_at, activated_at, retired_at, grace_period_sec, revoked_at, name, description, tags, metadata FROM secret_records WHERE tenant_id = $1 AND id = $2 LIMIT 1 FOR UPDATE",
        [subject.tenantId, params.id],
      );
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Secret 不存在", "en-US": "Secret not found" }, traceId: req.ctx.traceId });
      }

      const setClauses: string[] = ["updated_at = now()"];
      const values: any[] = [subject.tenantId, params.id];
      let idx = 3;

      if (body.name !== undefined) {
        setClauses.push(`name = $${idx}`);
        values.push(body.name);
        idx++;
      }
      if (body.description !== undefined) {
        setClauses.push(`description = $${idx}`);
        values.push(body.description);
        idx++;
      }
      if (body.tags !== undefined) {
        setClauses.push(`tags = $${idx}::jsonb`);
        values.push(JSON.stringify(body.tags));
        idx++;
      }
      if (body.metadata !== undefined) {
        setClauses.push(`metadata = $${idx}::jsonb`);
        values.push(JSON.stringify(body.metadata));
        idx++;
      }

      const res = await client.query(
        `UPDATE secret_records SET ${setClauses.join(", ")} WHERE tenant_id = $1 AND id = $2 RETURNING id, tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, credential_version, rotated_from_id, enc_format, key_ref, created_at, updated_at, activated_at, retired_at, grace_period_sec, revoked_at, name, description, tags, metadata`,
        values,
      );
      const row = res.rows[0] as any;
      const secret = {
        id: row.id,
        tenantId: row.tenant_id,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        connectorInstanceId: row.connector_instance_id,
        status: row.status,
        keyVersion: row.key_version,
        credentialVersion: typeof row.credential_version === "number" ? row.credential_version : Number(row.credential_version ?? 1),
        rotatedFromId: row.rotated_from_id ? String(row.rotated_from_id) : null,
        encFormat: row.enc_format ?? "a256gcm",
        keyRef: row.key_ref ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        activatedAt: row.activated_at ?? row.created_at,
        retiredAt: row.retired_at ?? null,
        gracePeriodSec: row.grace_period_sec ?? null,
        revokedAt: row.revoked_at ?? null,
        name: row.name ?? null,
        description: row.description ?? null,
        tags: row.tags ?? [],
        metadata: row.metadata ?? null,
      };

      req.ctx.audit!.outputDigest = { secretId: secret.id, connectorInstanceId: secret.connectorInstanceId, updatedFields: Object.keys(body) };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { secret };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      const msg = String((e as any)?.message ?? e ?? "");
      if (msg.includes("audit_outbox") || msg.includes("AUDIT_OUTBOX") || msg === "subject_missing") throw Errors.auditOutboxWriteFailed();
      throw e;
    } finally {
      client.release();
    }
  });

  app.post("/secrets/:id/revoke", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "secret", action: "revoke", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "secret", action: "revoke" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const secret = await revokeSecretRecord(client, subject.tenantId, params.id);
      if (!secret) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Secret 不存在", "en-US": "Secret not found" }, traceId: req.ctx.traceId });
      }
      req.ctx.audit!.outputDigest = { secretId: secret.id, connectorInstanceId: secret.connectorInstanceId, scopeType: secret.scopeType };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { secret };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      const msg = String((e as any)?.message ?? e ?? "");
      if (msg.includes("audit_outbox") || msg.includes("AUDIT_OUTBOX") || msg === "subject_missing") throw Errors.auditOutboxWriteFailed();
      throw e;
    } finally {
      client.release();
    }
  });

  app.post("/secrets/:id/rotate", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "secret", action: "rotate", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "secret", action: "rotate" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z
      .object({
        payload: z.record(z.string(), z.any()),
        gracePeriodSec: z.number().int().positive().max(365 * 24 * 60 * 60).optional(),
      })
      .parse(req.body);

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");

      const locked = await client.query("SELECT * FROM secret_records WHERE tenant_id = $1 AND id = $2 LIMIT 1 FOR UPDATE", [subject.tenantId, params.id]);
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Secret 不存在", "en-US": "Secret not found" }, traceId: req.ctx.traceId });
      }
      const old = locked.rows[0] as any;
      if (String(old.status ?? "") !== "active") throw Errors.badRequest("Secret 未激活");
      if (String(old.scope_type ?? "") !== scope.scopeType || String(old.scope_id ?? "") !== scope.scopeId) throw Errors.forbidden();

      const connectorInstanceId = String(old.connector_instance_id ?? "");
      if (!connectorInstanceId) throw Errors.badRequest("Secret 缺少 connectorInstanceId");

      const inst = await getConnectorInstance(app.db, subject.tenantId, connectorInstanceId);
      if (!inst) throw Errors.badRequest("ConnectorInstance 不存在");
      if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");

      const prevCredentialVersion = typeof old.credential_version === "number" ? old.credential_version : Number(old.credential_version ?? 1);
      const nextCredentialVersion = Math.max(1, Math.round(prevCredentialVersion) + 1);

      const enc = await encryptSecretEnvelope({
        pool: client,
        tenantId: subject.tenantId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        masterKey: masterKey(),
        payload: body.payload,
      });

      const created = await createSecretRecord({
        pool: client,
        tenantId: subject.tenantId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        connectorInstanceId,
        encryptedPayload: enc.encryptedPayload,
        keyVersion: enc.keyVersion,
        encFormat: enc.encFormat,
        keyRef: enc.keyRef,
        credentialVersion: nextCredentialVersion,
        rotatedFromId: params.id,
      });

      const retired = await retireSecretRecord({ pool: client, tenantId: subject.tenantId, id: params.id, gracePeriodSec: body.gracePeriodSec });
      if (!retired) throw Errors.badRequest("Secret 轮换失败");

      const bindings = await client.query(
        `SELECT id, secret_ids FROM provider_bindings WHERE tenant_id = $1 AND connector_instance_id = $2::uuid AND status = 'enabled'`,
        [subject.tenantId, connectorInstanceId],
      );
      let updatedBindings = 0;
      for (const r of bindings.rows as any[]) {
        const bindingId = String(r.id ?? "");
        if (!bindingId) continue;
        const rawIds = r.secret_ids;
        let ids: any[] = [];
        if (Array.isArray(rawIds)) ids = rawIds;
        else if (typeof rawIds === "string") {
          try {
            const j = JSON.parse(rawIds);
            if (Array.isArray(j)) ids = j;
          } catch {}
        } else if (rawIds && typeof rawIds === "object" && typeof (rawIds as any).toString === "function") {
          try {
            const j = JSON.parse(String((rawIds as any).toString("utf8")));
            if (Array.isArray(j)) ids = j;
          } catch {}
        }
        const canon = Array.from(new Set([created.id, ...ids.map((x: any) => String(x)).filter(Boolean).filter((x: string) => x !== created.id)]));
        await client.query("UPDATE provider_bindings SET secret_id = $1::uuid, secret_ids = $2::jsonb, updated_at = now() WHERE tenant_id = $3 AND id = $4::uuid", [
          created.id,
          JSON.stringify(canon),
          subject.tenantId,
          bindingId,
        ]);
        updatedBindings += 1;
      }

      req.ctx.audit!.outputDigest = {
        oldSecretId: params.id,
        newSecretId: created.id,
        connectorInstanceId,
        credentialVersion: created.credentialVersion,
        retiredGraceSec: body.gracePeriodSec ?? null,
        updatedBindings,
      };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { scope, oldSecretId: params.id, secret: created, updatedBindings };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw e;
    } finally {
      client.release();
    }
  });

  app.get("/secrets/usage", async (req) => {
    setAuditContext(req, { resourceType: "secret", action: "read" });
    const decision = await requirePermission({ req, resourceType: "secret", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const q = z.object({ connectorInstanceId: z.string().min(3), limit: z.coerce.number().int().positive().max(200).optional() }).parse(req.query ?? {});
    const events = await listSecretUsageEvents({ pool: app.db, tenantId: subject.tenantId, connectorInstanceId: q.connectorInstanceId, limit: q.limit });
    req.ctx.audit!.outputDigest = { connectorInstanceId: q.connectorInstanceId, eventsCount: events.length };
    return { connectorInstanceId: q.connectorInstanceId, events };
  });

  app.get("/secrets/:id/plaintext", async (req) => {
    setAuditContext(req, { resourceType: "secret", action: "read" });
    req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.secretForbidden();
  });
};
