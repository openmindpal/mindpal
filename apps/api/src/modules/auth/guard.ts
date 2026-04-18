import type { FastifyRequest } from "fastify";
import type { AbacEvaluationRequest } from "@openslin/shared";
import { Errors } from "../../lib/errors";
import { authorize } from "./authz";

export function requireSubject(req: FastifyRequest) {
  if (!req.ctx.subject) throw Errors.unauthorized(req.ctx.locale);
  return req.ctx.subject;
}

function detectDeviceType(ua?: string): string | undefined {
  if (!ua) return undefined;
  const lower = ua.toLowerCase();
  if (/mobile|android|iphone|ipod/.test(lower)) return "mobile";
  if (/tablet|ipad/.test(lower)) return "tablet";
  return "desktop";
}

export type PermissionSubject = { subjectId: string; tenantId: string; spaceId?: string };

export function buildAbacEvaluationRequestFromContext(params: {
  subject: PermissionSubject;
  resourceType: string;
  action: string;
  environment?: {
    ip?: string;
    userAgent?: string;
    deviceType?: string;
    geoCountry?: string;
    riskLevel?: string;
    dataLabels?: string[];
    attributes?: Record<string, unknown>;
  };
}): AbacEvaluationRequest {
  const env = params.environment ?? {};
  const attributes = {
    ...(env.attributes ?? {}),
    ...(env.riskLevel ? { riskLevel: env.riskLevel } : {}),
    ...(env.dataLabels?.length ? { dataLabels: env.dataLabels } : {}),
  };

  return {
    subject: {
      subjectId: params.subject.subjectId,
      tenantId: params.subject.tenantId,
      spaceId: params.subject.spaceId,
      attributes: {},
    },
    resource: {
      resourceType: params.resourceType,
      attributes: {},
    },
    action: params.action,
    environment: {
      ip: env.ip,
      userAgent: env.userAgent,
      deviceType: env.deviceType,
      geoCountry: env.geoCountry,
      timestamp: new Date().toISOString(),
      attributes,
    },
  };
}

/** 从 HTTP 请求中构建 ABAC 四维属性上下文 */
function buildAbacEvaluationRequest(
  req: FastifyRequest,
  subject: { subjectId: string; tenantId: string; spaceId?: string },
  resourceType: string,
  action: string,
): AbacEvaluationRequest {
  const clientIp =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.headers["x-real-ip"] as string | undefined ??
    req.ip ??
    undefined;
  const userAgent = req.headers["user-agent"] ?? undefined;
  return buildAbacEvaluationRequestFromContext({
    subject,
    resourceType,
    action,
    environment: {
      ip: clientIp,
      userAgent,
      deviceType: detectDeviceType(userAgent),
      geoCountry: (req.headers["x-geo-region"] as string | undefined) ?? (req.headers["x-geo-country"] as string | undefined) ?? undefined,
      riskLevel: (req.headers["x-risk-level"] as string | undefined) ?? undefined,
      dataLabels: (req.headers["x-data-labels"] as string | undefined)?.split(",").map((s) => s.trim()).filter(Boolean) ?? undefined,
    },
  });
}

export async function requirePermission(params: {
  req: FastifyRequest;
  resourceType: string;
  action: string;
}) {
  const subject = requireSubject(params.req);
  const abacRequest = buildAbacEvaluationRequest(params.req, subject, params.resourceType, params.action);
  const decision = await authorize({
    pool: params.req.server.db,
    subjectId: subject.subjectId,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    resourceType: params.resourceType,
    action: params.action,
    abacRequest,
  });
  if (decision.decision !== "allow") {
    if (params.req.ctx.audit) params.req.ctx.audit.policyDecision = decision;
    throw Errors.forbidden();
  }
  return decision;
}
