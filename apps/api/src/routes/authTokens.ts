import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import { createAuthToken, getAuthTokenById, listAuthTokens, revokeAuthToken } from "../modules/auth/tokenRepo";

export const authTokenRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/tokens", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "token.create" });
    const decision = await requirePermission({ req, resourceType: "auth", action: "token.self" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        expiresAt: z.string().min(1).max(100).optional(),
      })
      .parse(req.body);

    let expiresAt: string | null = null;
    if (body.expiresAt) {
      const ms = Date.parse(body.expiresAt);
      if (!Number.isFinite(ms)) throw Errors.badRequest("expiresAt 不合法");
      if (ms <= Date.now()) throw Errors.badRequest("expiresAt 必须在未来");
      expiresAt = new Date(ms).toISOString();
    }

    const created = await createAuthToken({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      subjectId: subject.subjectId,
      name: body.name ?? null,
      expiresAt,
    });

    req.ctx.audit!.outputDigest = { tokenId: created.record.id, expiresAt };
    return {
      tokenId: created.record.id,
      token: created.token,
      expiresAt,
    };
  });

  app.get("/auth/tokens", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "token.read" });
    const decision = await requirePermission({ req, resourceType: "auth", action: "token.self" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const limit = z.coerce.number().int().positive().max(200).optional().parse((req.query as any)?.limit) ?? 50;
    const items = await listAuthTokens({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, limit });
    req.ctx.audit!.outputDigest = { count: items.length };
    return {
      items: items.map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
        spaceId: t.spaceId,
      })),
    };
  });

  app.post("/auth/tokens/:tokenId/revoke", async (req) => {
    const params = z.object({ tokenId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "auth", action: "token.revoke" });

    const subject = requireSubject(req);
    const token = await getAuthTokenById({ pool: app.db, tenantId: subject.tenantId, tokenId: params.tokenId });
    if (!token) throw Errors.notFound();

    if (token.subjectId === subject.subjectId) {
      const decision = await requirePermission({ req, resourceType: "auth", action: "token.self" });
      req.ctx.audit!.policyDecision = decision;
    } else {
      const decision = await requirePermission({ req, resourceType: "auth", action: "token.admin" });
      req.ctx.audit!.policyDecision = decision;
    }

    const revoked = await revokeAuthToken({ pool: app.db, tenantId: subject.tenantId, tokenId: token.id });
    req.ctx.audit!.outputDigest = { tokenId: token.id, revoked: Boolean(revoked) };
    return { ok: Boolean(revoked) };
  });
};

