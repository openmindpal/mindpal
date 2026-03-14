import type { FastifyRequest } from "fastify";
import { Errors } from "../../lib/errors";
import { authorize } from "./authz";

export function requireSubject(req: FastifyRequest) {
  if (!req.ctx.subject) throw Errors.unauthorized(req.ctx.locale);
  return req.ctx.subject;
}

export async function requirePermission(params: {
  req: FastifyRequest;
  resourceType: string;
  action: string;
}) {
  const subject = requireSubject(params.req);
  const decision = await authorize({
    pool: params.req.server.db,
    subjectId: subject.subjectId,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    resourceType: params.resourceType,
    action: params.action,
  });
  if (decision.decision !== "allow") {
    if (params.req.ctx.audit) params.req.ctx.audit.policyDecision = decision;
    throw Errors.forbidden();
  }
  return decision;
}
