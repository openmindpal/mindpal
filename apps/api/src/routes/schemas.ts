import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import {
  getByNameVersion,
  getEffectiveSchema,
  listLatestReleased,
  listVersionsByName,
} from "../modules/metadata/schemaRepo";

export const schemaRoutes: FastifyPluginAsync = async (app) => {
  app.get("/schemas", async (req) => {
    setAuditContext(req, { resourceType: "schema", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "schema", action: "read" });
    const list = await listLatestReleased(app.db);
    return { schemas: list };
  });

  app.get("/schemas/:name/latest", async (req, reply) => {
    setAuditContext(req, { resourceType: "schema", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "schema", action: "read" });
    const params = z.object({ name: z.string() }).parse(req.params);
    const subject = req.ctx.subject!;
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: params.name });
    if (!schema) return reply.status(404).send({ errorCode: "SCHEMA_NOT_FOUND", message: { "zh-CN": "Schema 不存在", "en-US": "Schema not found" }, traceId: req.ctx.traceId });
    return schema;
  });

  app.get("/schemas/:name/:version", async (req, reply) => {
    setAuditContext(req, { resourceType: "schema", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "schema", action: "read" });
    const params = z.object({ name: z.string(), version: z.coerce.number().int().positive() }).parse(req.params);
    const schema = await getByNameVersion(app.db, params.name, params.version);
    if (!schema) return reply.status(404).send({ errorCode: "SCHEMA_NOT_FOUND", message: { "zh-CN": "Schema 不存在", "en-US": "Schema not found" }, traceId: req.ctx.traceId });
    return schema;
  });

  app.get("/schemas/:name/versions", async (req) => {
    setAuditContext(req, { resourceType: "schema", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "schema", action: "read" });
    const params = z.object({ name: z.string() }).parse(req.params);
    const q = req.query as any;
    const limit = z.coerce.number().int().positive().max(200).optional().parse(q?.limit) ?? 50;
    const versions = await listVersionsByName({ pool: app.db, name: params.name, limit });
    req.ctx.audit!.outputDigest = { name: params.name, count: versions.length };
    return { versions };
  });

  app.post("/schemas/:name/publish", async (req) => {
    const params = z.object({ name: z.string() }).parse(req.params);
    setAuditContext(req, { resourceType: "schema", action: "publish" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "schema", action: "publish" });
    req.ctx.audit!.inputDigest = { name: params.name };
    req.ctx.audit!.outputDigest = { ok: false, requiredFlow: "changeset.release", supportedKind: "schema.publish" };
    throw Errors.schemaChangesetRequired("publish");
  });
};
