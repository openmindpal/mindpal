import type { FastifyPluginAsync } from "fastify";
import { Errors } from "../lib/errors";
import { getDeviceByTokenHash } from "../lib/deviceAuth";
import { sha256Hex } from "../lib/digest";
import { authenticate } from "../modules/auth/authn";
import { ensureSubject } from "../modules/auth/subjectRepo";

function readCookieValue(cookieHeader: unknown, name: string) {
  const raw = typeof cookieHeader === "string" ? cookieHeader : "";
  if (!raw) return "";
  const parts = raw.split(";").map((x) => x.trim());
  const key = `${encodeURIComponent(name)}=`;
  for (const p of parts) {
    if (!p.startsWith(key)) continue;
    // P2-2: 取 key= 后的全部内容（不再用 split('=')[1]，避免 Base64 值中的 '=' 被截断）
    const v = p.slice(key.length);
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return "";
}

export const authenticationPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req) => {
    const headerAuth = req.headers.authorization;
    const cookieToken = readCookieValue(req.headers.cookie, "openslin_token").trim();
    const cookieAuth =
      cookieToken && !headerAuth
        ? cookieToken.toLowerCase().startsWith("bearer ") || cookieToken.toLowerCase().startsWith("device ")
          ? cookieToken
          : `Bearer ${cookieToken}`
        : undefined;
    const subject = await authenticate({ pool: app.db, authorization: headerAuth ?? cookieAuth });
    // 4.2 FIX: 认证失败时记录日志，而不是静默继续
    if (!subject) {
      // 公开路由无需认证，其它路由在下游通过 requirePermission 保护
      if (!req.url.startsWith("/health") && !req.url.startsWith("/healthz") && !req.url.startsWith("/readyz") && !req.url.startsWith("/internal/")) {
        app.log.debug({ url: req.url, method: req.method }, "[authn] 未认证请求，将由下游 requirePermission 拦截");
      }
      return;
    }
    req.ctx.subject = subject;
  });

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/device-agent")) return;
    const auth = req.headers.authorization ?? "";
    const token = auth.toLowerCase().startsWith("device ") ? auth.slice("device ".length).trim() : "";
    if (!token) return;
    const device = await getDeviceByTokenHash({ pool: app.db, deviceTokenHash: sha256Hex(token) });
    if (!device) return;
    (req.ctx as any).device = device;
  });

  app.addHook("onRequest", async (req) => {
    const subject = req.ctx.subject;
    if (!subject) return;
    const ensured = await ensureSubject({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
    if (!ensured.ok) throw Errors.unauthorized(req.ctx.locale);
  });
};
