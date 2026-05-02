import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { createAuthToken, getAuthTokenById, listAuthTokens, revokeAuthToken, issueSessionTokenPair, rotateRefreshToken, enforceSessionLimit } from "../../modules/auth/tokenRepo";
import { generateTotpSecret, buildTotpUri, verifyTotp, generateRecoveryCodes, getMfaEnrollment, upsertMfaEnrollment, confirmMfaEnrollment, deleteMfaEnrollment, consumeRecoveryCode } from "../../modules/auth/mfaRuntime";
import { getSsoProvider, listSsoProviders } from "../../modules/auth/ssoScimRepo";
import {
  buildSsoAuthorizeUrl,
  consumeSsoLoginState,
  createSsoLoginState,
  decodeJwtPayload,
  deriveCodeChallenge,
  discoverOidcEndpoints,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generateNonce,
  generateSsoState,
  mapClaims,
  validateIdTokenClaims,
} from "../../modules/auth/ssoOidcRuntime";
import { ensureSubject } from "../../modules/auth/subjectRepo";

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

  /* ─── SSO/OIDC Login ─── §15.15 ─── */
  app.post("/auth/sso/initiate", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "sso.initiate" });
    const body = z.object({ tenantId: z.string().min(1), providerId: z.string().min(1).optional() }).parse(req.body);
    const tenantId = body.tenantId;
    const provider = body.providerId
      ? await getSsoProvider({ pool: app.db, tenantId, providerId: body.providerId })
      : (await listSsoProviders({ pool: app.db, tenantId })).find((p) => p.status === "active") ?? null;
    if (!provider) throw Errors.notFound("SSO provider");

    const discovery = await discoverOidcEndpoints(provider.issuerUrl);
    const state = generateSsoState();
    const nonce = generateNonce();
    /* P1-04a: generate PKCE code_verifier & code_challenge */
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);

    const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const proto = xfProto === "https" || xfProto === "http" ? xfProto : "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]?.trim();
    const redirectUri = `${proto}://${host}/auth/sso/callback`;

    await createSsoLoginState({ pool: app.db, tenantId, providerId: provider.providerId, state, nonce, redirectUri, codeVerifier });

    const authorizeUrl = buildSsoAuthorizeUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      clientId: provider.clientId,
      redirectUri,
      state,
      nonce,
      scopes: provider.scopes,
      codeChallenge,
    });

    return { authorizeUrl, state, providerId: provider.providerId };
  });

  app.get("/auth/sso/callback", async (req) => {
    const qs = req.query as Record<string, string>;
    const code = String(qs.code ?? "").trim();
    const state = String(qs.state ?? "").trim();
    if (!code || !state) throw Errors.badRequest("缺少 code 或 state");

    setAuditContext(req, { resourceType: "auth", action: "sso.callback" });
    const loginState = await consumeSsoLoginState({ pool: app.db, state });
    if (!loginState) throw Errors.badRequest("SSO state 无效或已过期");

    const provider = await getSsoProvider({ pool: app.db, tenantId: loginState.tenantId, providerId: loginState.providerId });
    if (!provider || provider.status !== "active") throw Errors.badRequest("SSO provider 不可用");

    /* discover endpoints */
    const discovery = await discoverOidcEndpoints(provider.issuerUrl);

    /* exchange code for tokens — P1-04a: include PKCE code_verifier */
    const clientSecret = provider.clientSecretRef ?? "";
    const tokens = await exchangeCodeForTokens({
      tokenEndpoint: discovery.token_endpoint,
      code,
      redirectUri: loginState.redirectUri,
      clientId: provider.clientId,
      clientSecret,
      codeVerifier: loginState.codeVerifier,
    });

    /* verify id_token */
    if (!tokens.id_token) throw Errors.badRequest("IdP 未返回 id_token");
    const claims = decodeJwtPayload(tokens.id_token);
    validateIdTokenClaims({ claims, issuer: discovery.issuer || provider.issuerUrl, clientId: provider.clientId });
    if (claims.nonce && claims.nonce !== loginState.nonce) throw Errors.badRequest("nonce 不匹配");

    /* map claims → subject */
    const mapped = mapClaims(claims, provider.claimMappings ?? {});
    if (!mapped.subjectId) throw Errors.badRequest("无法提取 subjectId");

    /* ensure subject exists (auto-provision) */
    await ensureSubject({ pool: app.db, tenantId: loginState.tenantId, subjectId: mapped.subjectId });

    /* issue auth token — P1-04b: issue access + refresh pair */
    await enforceSessionLimit({ pool: app.db, tenantId: loginState.tenantId, subjectId: mapped.subjectId });
    const session = await issueSessionTokenPair({
      pool: app.db,
      tenantId: loginState.tenantId,
      spaceId: null,
      subjectId: mapped.subjectId,
      name: `sso:${provider.providerId}`,
    });

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      tokenId: session.access.id,
      subjectId: mapped.subjectId,
      email: mapped.email,
      displayName: mapped.displayName,
      providerId: provider.providerId,
      expiresAt: session.access.expiresAt,
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

  /* ─── P1-04b: Refresh Token rotation ─── */
  app.post("/auth/tokens/refresh", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "token.refresh" });
    const body = z.object({ refreshToken: z.string().min(1) }).parse(req.body);

    const result = await rotateRefreshToken({ pool: app.db, refreshTokenRaw: body.refreshToken });

    if (result.error === "token_reuse") {
      throw Errors.unauthorized("Refresh token reuse detected — all sessions revoked");
    }
    if (result.error) {
      throw Errors.unauthorized(result.error);
    }

    const pair = result.pair!;
    req.ctx.audit!.outputDigest = { accessTokenId: pair.access.id, familyId: pair.familyId };

    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenId: pair.access.id,
      expiresAt: pair.access.expiresAt,
    };
  });

  /* ─── P1-04c: MFA/TOTP Endpoints ─── */

  /** Enroll TOTP — returns secret + QR URI. Must be confirmed with a valid code. */
  app.post("/auth/mfa/enroll", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "mfa.enroll" });
    const decision = await requirePermission({ req, resourceType: "auth", action: "token.self" });
    req.ctx.audit!.policyDecision = decision;
    const subject = requireSubject(req);

    const secret = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes();

    await upsertMfaEnrollment({
      pool: app.db,
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
      secretEnc: secret, // In production, encrypt with master key
      recoveryCodes: recoveryCodes.hashed,
    });

    const uri = buildTotpUri({ secret, accountName: subject.subjectId });
    req.ctx.audit!.outputDigest = { enrolled: true };
    return { totpUri: uri, secret, recoveryCodes: recoveryCodes.plain };
  });

  /** Confirm TOTP enrollment with a valid code. */
  app.post("/auth/mfa/confirm", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "mfa.confirm" });
    const decision = await requirePermission({ req, resourceType: "auth", action: "token.self" });
    req.ctx.audit!.policyDecision = decision;
    const subject = requireSubject(req);
    const body = z.object({ code: z.string().min(1).max(10) }).parse(req.body);

    const enrollment = await getMfaEnrollment({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
    if (!enrollment) throw Errors.badRequest("MFA not enrolled");
    if (enrollment.verified) throw Errors.badRequest("MFA already confirmed");

    const valid = verifyTotp(enrollment.secretEnc, body.code.trim());
    if (!valid) throw Errors.badRequest("Invalid TOTP code");

    await confirmMfaEnrollment({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
    req.ctx.audit!.outputDigest = { confirmed: true };
    return { ok: true };
  });

  /** Verify a TOTP code (for login step-up or action confirmation). */
  app.post("/auth/mfa/verify", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "mfa.verify" });
    const subject = requireSubject(req);
    const body = z.object({ code: z.string().min(1).max(10) }).parse(req.body);

    const enrollment = await getMfaEnrollment({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
    if (!enrollment || !enrollment.verified) throw Errors.badRequest("MFA not enabled");

    const valid = verifyTotp(enrollment.secretEnc, body.code.trim());
    req.ctx.audit!.outputDigest = { valid };
    if (!valid) throw Errors.unauthorized("Invalid TOTP code");
    return { ok: true };
  });

  /** Use a recovery code to bypass TOTP. */
  app.post("/auth/mfa/recovery", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "mfa.recovery" });
    const subject = requireSubject(req);
    const body = z.object({ recoveryCode: z.string().min(1).max(20) }).parse(req.body);

    const consumed = await consumeRecoveryCode({
      pool: app.db,
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
      code: body.recoveryCode,
    });

    if (!consumed) throw Errors.unauthorized("Invalid recovery code");
    req.ctx.audit!.outputDigest = { recoveryCodeUsed: true };
    return { ok: true, warning: "Recovery code consumed. Remaining codes reduced." };
  });

  /** Get MFA status for the current user. */
  app.get("/auth/mfa/status", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "mfa.status" });
    const subject = requireSubject(req);
    const enrollment = await getMfaEnrollment({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
    return {
      enrolled: Boolean(enrollment),
      verified: Boolean(enrollment?.verified),
      method: enrollment ? "totp" : null,
      recoveryCodesRemaining: enrollment?.recoveryCodes?.length ?? 0,
    };
  });

  /** Disable MFA for the current user. Requires TOTP or recovery code. */
  app.post("/auth/mfa/disable", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "mfa.disable" });
    const decision = await requirePermission({ req, resourceType: "auth", action: "token.self" });
    req.ctx.audit!.policyDecision = decision;
    const subject = requireSubject(req);
    const body = z.object({ code: z.string().min(1).max(20) }).parse(req.body);

    const enrollment = await getMfaEnrollment({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
    if (!enrollment || !enrollment.verified) throw Errors.badRequest("MFA not enabled");

    /* Verify with TOTP or recovery code */
    const totpOk = verifyTotp(enrollment.secretEnc, body.code.trim());
    const recoveryOk = !totpOk && await consumeRecoveryCode({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, code: body.code });
    if (!totpOk && !recoveryOk) throw Errors.unauthorized("Invalid code");

    await deleteMfaEnrollment({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
    req.ctx.audit!.outputDigest = { disabled: true };
    return { ok: true };
  });
};

