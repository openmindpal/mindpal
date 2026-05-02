import crypto from "node:crypto";
import type { Pool } from "pg";
import { sha256Hex } from "@mindpal/shared";

export type TokenType = "access" | "refresh" | "pat";

export type AuthTokenRow = {
  id: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  name: string | null;
  tokenHash: string;
  tokenType: TokenType;
  familyId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

function rowToToken(r: any): AuthTokenRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    spaceId: r.space_id ? String(r.space_id) : null,
    subjectId: String(r.subject_id),
    name: r.name ? String(r.name) : null,
    tokenHash: String(r.token_hash),
    tokenType: (["access", "refresh", "pat"].includes(r.token_type) ? r.token_type : "pat") as TokenType,
    familyId: r.family_id ? String(r.family_id) : null,
    createdAt: String(r.created_at),
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    revokedAt: r.revoked_at ? String(r.revoked_at) : null,
  };
}

function genPatToken() {
  const raw = crypto.randomBytes(24).toString("base64url");
  return `pat_${raw}`;
}

function genAccessToken() {
  return `at_${crypto.randomBytes(24).toString("base64url")}`;
}

function genRefreshToken() {
  return `rt_${crypto.randomBytes(32).toString("base64url")}`;
}

/* ─── P1-04b: Session TTL defaults ─── */

const ACCESS_TOKEN_TTL_MS = Number(process.env.ACCESS_TOKEN_TTL_MS) || 15 * 60 * 1000;          // 15 min
const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_MS) || 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CONCURRENT_SESSIONS = Number(process.env.MAX_CONCURRENT_SESSIONS) || 10;

export async function createAuthToken(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  name?: string | null;
  expiresAt?: string | null;
  tokenType?: TokenType;
  familyId?: string | null;
}) {
  const tt = params.tokenType ?? "pat";
  const token = tt === "access" ? genAccessToken() : tt === "refresh" ? genRefreshToken() : genPatToken();
  const tokenHash = sha256Hex(token);
  const familyId = params.familyId ?? (tt === "refresh" ? crypto.randomUUID() : null);

  /* P1-04b: auto-expire based on tokenType when no explicit expiresAt */
  let expiresAt = params.expiresAt ?? null;
  if (!expiresAt && tt === "access") expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
  if (!expiresAt && tt === "refresh") expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();

  const res = await params.pool.query(
    `
      INSERT INTO auth_tokens (tenant_id, space_id, subject_id, name, token_hash, token_type, family_id, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.subjectId, params.name ?? null, tokenHash, tt, familyId, expiresAt],
  );
  return { token, record: rowToToken(res.rows[0]) };
}

export async function listAuthTokens(params: { pool: Pool; tenantId: string; subjectId: string; limit: number }) {
  const limit = Math.max(1, Math.min(200, params.limit));
  const res = await params.pool.query(
    `
      SELECT *
      FROM auth_tokens
      WHERE tenant_id = $1 AND subject_id = $2
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [params.tenantId, params.subjectId, limit],
  );
  return res.rows.map(rowToToken);
}

export async function getAuthTokenByHash(params: { pool: Pool; tokenHash: string }) {
  const res = await params.pool.query("SELECT * FROM auth_tokens WHERE token_hash = $1 LIMIT 1", [params.tokenHash]);
  if (!res.rowCount) return null;
  return rowToToken(res.rows[0]);
}

export async function getAuthTokenById(params: { pool: Pool; tenantId: string; tokenId: string }) {
  const res = await params.pool.query("SELECT * FROM auth_tokens WHERE tenant_id = $1 AND id = $2 LIMIT 1", [params.tenantId, params.tokenId]);
  if (!res.rowCount) return null;
  return rowToToken(res.rows[0]);
}

export async function touchAuthTokenLastUsed(params: { pool: Pool; tokenId: string }) {
  await params.pool.query("UPDATE auth_tokens SET last_used_at = now() WHERE id = $1", [params.tokenId]);
}

export async function revokeAuthToken(params: { pool: Pool; tenantId: string; tokenId: string }) {
  const res = await params.pool.query(
    `
      UPDATE auth_tokens
      SET revoked_at = now()
      WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
      RETURNING *
    `,
    [params.tenantId, params.tokenId],
  );
  if (!res.rowCount) return null;
  return rowToToken(res.rows[0]);
}

/* ─── P1-04b: Dual Token helpers ─── */

/**
 * Issue an access + refresh token pair for a session.
 */
export async function issueSessionTokenPair(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  name?: string | null;
  familyId?: string | null;
}) {
  const familyId = params.familyId ?? crypto.randomUUID();

  const access = await createAuthToken({
    ...params,
    tokenType: "access",
    familyId,
    name: params.name ? `${params.name}:access` : "session:access",
  });

  const refresh = await createAuthToken({
    ...params,
    tokenType: "refresh",
    familyId,
    name: params.name ? `${params.name}:refresh` : "session:refresh",
  });

  return { accessToken: access.token, refreshToken: refresh.token, familyId, access: access.record, refresh: refresh.record };
}

/**
 * Rotate a refresh token: revoke the old one, issue new access + refresh pair.
 * Implements refresh-token rotation with family-based revocation (detect reuse).
 */
export async function rotateRefreshToken(params: {
  pool: Pool;
  refreshTokenRaw: string;
}) {
  const hash = sha256Hex(params.refreshTokenRaw);
  const rec = await getAuthTokenByHash({ pool: params.pool, tokenHash: hash });
  if (!rec) return { error: "invalid_token" as const };
  if (rec.revokedAt) {
    /* Reuse detected — revoke entire family */
    if (rec.familyId) {
      await params.pool.query(
        "UPDATE auth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL",
        [rec.familyId],
      );
    }
    return { error: "token_reuse" as const };
  }
  if (rec.tokenType !== "refresh") return { error: "not_refresh" as const };
  if (rec.expiresAt) {
    const exp = Date.parse(rec.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) return { error: "expired" as const };
  }

  /* Revoke the old refresh token */
  await revokeAuthToken({ pool: params.pool, tenantId: rec.tenantId, tokenId: rec.id });

  /* Issue a new pair in the same family */
  return {
    error: null,
    pair: await issueSessionTokenPair({
      pool: params.pool,
      tenantId: rec.tenantId,
      spaceId: rec.spaceId,
      subjectId: rec.subjectId,
      familyId: rec.familyId,
      name: "session",
    }),
  };
}

/**
 * P1-04b: Count active (non-revoked, non-expired) sessions for a subject.
 */
export async function countActiveSessions(params: { pool: Pool; tenantId: string; subjectId: string }): Promise<number> {
  const res = await params.pool.query(
    `SELECT COUNT(*) AS cnt FROM auth_tokens
     WHERE tenant_id = $1 AND subject_id = $2 AND token_type = 'refresh'
       AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [params.tenantId, params.subjectId],
  );
  return Number(res.rows[0]?.cnt ?? 0);
}

/**
 * P1-04b: Enforce concurrent session limit — revoke oldest sessions if over limit.
 */
export async function enforceSessionLimit(params: { pool: Pool; tenantId: string; subjectId: string; maxSessions?: number }) {
  const max = params.maxSessions ?? MAX_CONCURRENT_SESSIONS;
  const count = await countActiveSessions(params);
  if (count < max) return { revoked: 0 };

  /* Revoke oldest refresh tokens beyond the limit */
  const excess = count - max + 1; // make room for the new one
  const res = await params.pool.query(
    `UPDATE auth_tokens SET revoked_at = now()
     WHERE id IN (
       SELECT id FROM auth_tokens
       WHERE tenant_id = $1 AND subject_id = $2 AND token_type = 'refresh'
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at ASC
       LIMIT $3
     ) RETURNING id`,
    [params.tenantId, params.subjectId, excess],
  );
  /* Also revoke access tokens in those families */
  if (res.rowCount) {
    const ids = res.rows.map((r: any) => String(r.id));
    await params.pool.query(
      `UPDATE auth_tokens SET revoked_at = now()
       WHERE family_id IN (
         SELECT family_id FROM auth_tokens WHERE id = ANY($1::uuid[])
       ) AND revoked_at IS NULL AND token_type = 'access'`,
      [ids],
    );
  }
  return { revoked: res.rowCount ?? 0 };
}
