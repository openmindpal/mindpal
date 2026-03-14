import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { enqueueAuditOutboxForRequest } from "../modules/audit/requestOutbox";
import { getConnectorInstance } from "../modules/connectors/connectorRepo";
import { encryptSecretEnvelope } from "../modules/secrets/envelope";
import { createSecretRecord, getSecretRecord, listSecretRecords, revokeSecretRecord } from "../modules/secrets/secretRepo";

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
      throw Errors.auditOutboxWriteFailed();
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
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });

  app.get("/secrets/:id/plaintext", async (req) => {
    setAuditContext(req, { resourceType: "secret", action: "read" });
    req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.secretForbidden();
  });
};
