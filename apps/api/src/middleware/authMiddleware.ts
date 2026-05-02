/**
 * Phase 1: Request Context + Authentication + Authorization
 *
 * Merges: requestContextPlugin, authenticationPlugin
 *
 * 功能目标：将请求上下文初始化与认证/授权逻辑合并为单一 onRequest 阶段，
 * 确保每个请求在进入后续中间件前已完成身份识别。
 */
import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { resolveRequestLocale } from "../lib/locale";
import { Errors } from "../lib/errors";
import { getDeviceByTokenHash } from "../lib/deviceAuth";
import { sha256Hex } from "../lib/digest";
import { ensureSubject } from "../modules/auth/subjectRepo";

function readCookieValue(cookieHeader: unknown, name: string): string {
  const raw = typeof cookieHeader === "string" ? cookieHeader : "";
  if (!raw) return "";
  const parts = raw.split(";").map((x) => x.trim());
  const key = `${encodeURIComponent(name)}=`;
  for (const p of parts) {
    if (!p.startsWith(key)) continue;
    const v = p.slice(key.length);
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return "";
}

function isPublicPath(url: string): boolean {
  return (
    url.startsWith("/health") ||
    url.startsWith("/healthz") ||
    url.startsWith("/readyz") ||
    url.startsWith("/internal/")
  );
}

export function authMiddleware(app: FastifyInstance): void {
  app.addHook("onRequest", async (req) => {
    // ── 1. Request Context Initialization ──
    const traceId = (req.headers["x-trace-id"] as string | undefined) ?? uuidv4();
    const requestId = uuidv4();
    const locale = resolveRequestLocale({
      userLocale: req.headers["x-user-locale"] as string | undefined,
      spaceLocale: req.headers["x-space-locale"] as string | undefined,
      tenantLocale: req.headers["x-tenant-locale"] as string | undefined,
      acceptLanguage: req.headers["accept-language"] as string | undefined,
      platformLocale: app.cfg.platformLocale,
    });
    req.ctx = { traceId, requestId, locale };

    // ── 2. Bearer / Cookie Authentication ──
    const headerAuth = req.headers.authorization;
    const cookieToken = readCookieValue(req.headers.cookie, "mindpal_token").trim();
    const cookieAuth =
      cookieToken && !headerAuth
        ? cookieToken.toLowerCase().startsWith("bearer ") || cookieToken.toLowerCase().startsWith("device ")
          ? cookieToken
          : `Bearer ${cookieToken}`
        : undefined;
    const credential = headerAuth ?? cookieAuth;

    if (credential) {
      const authCtx = await app.authProvider.authenticate(credential);
      if (authCtx) {
        req.ctx.authContext = authCtx;
        req.ctx.subject = {
          subjectId: authCtx.subject,
          tenantId: authCtx.tenantId,
          spaceId: authCtx.spaceId,
        };
      } else if (!isPublicPath(req.url)) {
        app.log.debug({ url: req.url, method: req.method }, "[authn] 未认证请求，将由下游 requirePermission 拦截");
      }
    } else if (!isPublicPath(req.url)) {
      app.log.debug({ url: req.url, method: req.method }, "[authn] 未认证请求，将由下游 requirePermission 拦截");
    }

    // ── 3. Device Token Authentication ──
    if (req.url.startsWith("/device-agent")) {
      const auth = req.headers.authorization ?? "";
      const token = auth.toLowerCase().startsWith("device ") ? auth.slice("device ".length).trim() : "";
      if (token) {
        const device = await getDeviceByTokenHash({ pool: app.db, deviceTokenHash: sha256Hex(token) });
        if (device) (req.ctx as any).device = device;
      }
    }

    // ── 4. Subject Validation ──
    const subject = req.ctx.subject;
    if (subject) {
      const ensured = await ensureSubject({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
      if (!ensured.ok) throw Errors.unauthorized(req.ctx.locale);
    }
  });
}
