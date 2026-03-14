import type { Pool } from "pg";
import crypto from "node:crypto";
import { encryptJson } from "../secrets/crypto";
import { decryptSecretPayload, encryptSecretEnvelopeWithKeyVersion } from "../secrets/envelope";

export type ExchangeWatermark = {
  deltaLink?: string | null;
  nextLink?: string | null;
  lastSyncTime?: string | null;
  seq?: number | null;
};

export type ExchangePollSummary = {
  insertedCount: number;
  dedupCount: number;
  scannedCount: number;
  watermarkAfter: ExchangeWatermark;
  watermarkNote?: string;
};

export type ExchangeConfigForPoll = {
  tenantId: string;
  spaceId: string;
  connectorInstanceId: string;
  oauthGrantId: string;
  mailbox: string;
  instanceStatus: string;
  allowedDomains: string[];
  grantStatus: string;
  tokenExpiresAt: string | null;
  secretRecordId: string;
  secretStatus: string;
  secretScopeType: string;
  secretScopeId: string;
  secretKeyVersion: number;
  secretEncFormat: string;
  secretKeyRef: any;
  encryptedPayload: any;
};

export class ExchangePollError extends Error {
  category: "policy_violation" | "auth_required" | "rate_limited" | "retryable" | "fatal";
  digest: any;
  backoffMs?: number;
  constructor(params: { category: ExchangePollError["category"]; message: string; digest?: any; backoffMs?: number }) {
    super(params.message);
    this.category = params.category;
    this.digest = params.digest ?? null;
    this.backoffMs = params.backoffMs;
  }
}

function sha256_8(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function digestText(s: any) {
  const v = typeof s === "string" ? s : "";
  if (!v) return { len: 0 };
  return { len: v.length, sha256_8: sha256_8(v) };
}

function parseRetryAfterMs(headers: Headers) {
  const ra = headers.get("retry-after");
  if (!ra) return null;
  const n = Number(ra);
  if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, 10 * 60_000);
  const dt = Date.parse(ra);
  if (!Number.isNaN(dt)) {
    const ms = dt - Date.now();
    if (ms > 0) return Math.min(ms, 10 * 60_000);
  }
  return null;
}

function computeBackoffMs(attemptCount: number) {
  const base = 500;
  const exp = Math.max(0, attemptCount - 1);
  return Math.min(base * Math.pow(2, exp), 60_000);
}

function masterKey() {
  return process.env.API_MASTER_KEY ?? "dev-master-key-change-me";
}

async function graphRequestJson(params: { url: string; token: string; timeoutMs: number }) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), params.timeoutMs);
  try {
    const res = await fetch(params.url, {
      method: "GET",
      headers: { authorization: `Bearer ${params.token}` },
      signal: c.signal,
    });
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers);
      throw new ExchangePollError({
        category: "rate_limited",
        message: "rate_limited",
        digest: { httpStatus: 429, retryAfterMs: retryAfterMs ?? null },
        backoffMs: retryAfterMs ?? 30_000,
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ExchangePollError({ category: "auth_required", message: "auth_required", digest: { httpStatus: res.status } });
    }
    if (res.status >= 500) {
      throw new ExchangePollError({ category: "retryable", message: "upstream_5xx", digest: { httpStatus: res.status }, backoffMs: 5_000 });
    }
    if (!res.ok) {
      throw new ExchangePollError({ category: "fatal", message: "upstream_error", digest: { httpStatus: res.status } });
    }
    return (await res.json()) as any;
  } catch (e: any) {
    if (e instanceof ExchangePollError) throw e;
    if (e?.name === "AbortError") throw new ExchangePollError({ category: "retryable", message: "timeout", digest: { timeoutMs: params.timeoutMs }, backoffMs: 5_000 });
    throw new ExchangePollError({ category: "fatal", message: "network_error", digest: { message: String(e?.message ?? "unknown") }, backoffMs: 5_000 });
  } finally {
    clearTimeout(t);
  }
}

async function refreshTokenIfNeeded(params: { pool: Pool; cfg: ExchangeConfigForPoll; attemptCount: number }) {
  if (params.cfg.grantStatus !== "active") throw new ExchangePollError({ category: "auth_required", message: "oauth_grant_inactive" });
  if (params.cfg.secretStatus !== "active") throw new ExchangePollError({ category: "auth_required", message: "oauth_secret_missing_or_revoked" });

  let payload: any;
  try {
    payload = await decryptSecretPayload({
      pool: params.pool,
      tenantId: params.cfg.tenantId,
      masterKey: masterKey(),
      scopeType: params.cfg.secretScopeType,
      scopeId: params.cfg.secretScopeId,
      keyVersion: params.cfg.secretKeyVersion,
      encFormat: params.cfg.secretEncFormat,
      encryptedPayload: params.cfg.encryptedPayload,
    });
  } catch {
    throw new ExchangePollError({ category: "auth_required", message: "oauth_secret_decrypt_failed" });
  }
  const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
  const refreshToken = typeof payload?.refresh_token === "string" ? payload.refresh_token : "";
  const tokenEndpoint = typeof payload?.token_endpoint === "string" ? payload.token_endpoint : "";
  const clientId = typeof payload?.client_id === "string" ? payload.client_id : "";
  const expiresAt = params.cfg.tokenExpiresAt ? Date.parse(params.cfg.tokenExpiresAt) : null;
  const expiringSoon = expiresAt !== null && Number.isFinite(expiresAt) && expiresAt - Date.now() < 2 * 60_000;

  if (!accessToken) throw new ExchangePollError({ category: "auth_required", message: "missing_access_token" });
  if (!expiringSoon) return { accessToken, refreshed: false };

  if (!tokenEndpoint || !clientId || !refreshToken) {
    throw new ExchangePollError({ category: "auth_required", message: "refresh_not_configured" });
  }
  try {
    const u = new URL(tokenEndpoint);
    const host = u.hostname.toLowerCase();
    if (!params.cfg.allowedDomains.includes(host)) throw new ExchangePollError({ category: "policy_violation", message: "egress_host_not_allowed", digest: { host } });
  } catch (e) {
    if (e instanceof ExchangePollError) throw e;
    throw new ExchangePollError({ category: "fatal", message: "invalid_token_endpoint" });
  }

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("scope", "https://graph.microsoft.com/.default");

  const c = new AbortController();
  const timeoutMs = 10_000;
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(tokenEndpoint, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" }, signal: c.signal });
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers);
      throw new ExchangePollError({
        category: "rate_limited",
        message: "rate_limited",
        digest: { httpStatus: 429, retryAfterMs: retryAfterMs ?? null },
        backoffMs: retryAfterMs ?? computeBackoffMs(params.attemptCount),
      });
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new ExchangePollError({ category: "auth_required", message: "refresh_failed", digest: { httpStatus: res.status } });
    }
    if (res.status >= 500) {
      throw new ExchangePollError({ category: "retryable", message: "upstream_5xx", digest: { httpStatus: res.status }, backoffMs: computeBackoffMs(params.attemptCount) });
    }
    if (!res.ok) throw new ExchangePollError({ category: "fatal", message: "upstream_error", digest: { httpStatus: res.status } });
    const token = (await res.json()) as any;
    const newAccessToken = typeof token?.access_token === "string" ? token.access_token : "";
    if (!newAccessToken) throw new ExchangePollError({ category: "auth_required", message: "refresh_missing_access_token" });
    const tokenExpiresAt = typeof token?.expires_in === "number" ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;

    if (params.cfg.secretEncFormat === "envelope.v1") {
      const env = await encryptSecretEnvelopeWithKeyVersion({
        pool: params.pool,
        tenantId: params.cfg.tenantId,
        masterKey: masterKey(),
        scopeType: params.cfg.secretScopeType,
        scopeId: params.cfg.secretScopeId,
        keyVersion: params.cfg.secretKeyVersion,
        payload: { ...token, refresh_token: token?.refresh_token ?? refreshToken, token_endpoint: tokenEndpoint, client_id: clientId },
      });
      await params.pool.query(
        "UPDATE secret_records SET encrypted_payload = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND id = $2",
        [params.cfg.tenantId, params.cfg.secretRecordId, JSON.stringify(env)],
      );
    } else {
      await params.pool.query("UPDATE secret_records SET encrypted_payload = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND id = $2", [
        params.cfg.tenantId,
        params.cfg.secretRecordId,
        JSON.stringify(encryptJson(masterKey(), { ...token, refresh_token: token?.refresh_token ?? refreshToken, token_endpoint: tokenEndpoint, client_id: clientId })),
      ]);
    }
    await params.pool.query("UPDATE oauth_grants SET token_expires_at = $3::timestamptz, updated_at = now() WHERE tenant_id = $1 AND grant_id = $2", [
      params.cfg.tenantId,
      params.cfg.oauthGrantId,
      tokenExpiresAt,
    ]);
    return { accessToken: newAccessToken, refreshed: true };
  } catch (e: any) {
    if (e instanceof ExchangePollError) throw e;
    if (e?.name === "AbortError") throw new ExchangePollError({ category: "retryable", message: "timeout", digest: { timeoutMs }, backoffMs: computeBackoffMs(params.attemptCount) });
    throw new ExchangePollError({ category: "fatal", message: "network_error", digest: { message: String(e?.message ?? "unknown") }, backoffMs: computeBackoffMs(params.attemptCount) });
  } finally {
    clearTimeout(t);
  }
}

function initialDeltaUrl(params: { mailbox: string; maxPageSize: number }) {
  const base = process.env.EXCHANGE_GRAPH_BASE_URL ?? "https://graph.microsoft.com/v1.0";
  const url = new URL(`${base}/users/${encodeURIComponent(params.mailbox)}/mailFolders/inbox/messages/delta`);
  url.searchParams.set("$select", "id,receivedDateTime,from,toRecipients,subject,hasAttachments,bodyPreview");
  url.searchParams.set("$top", String(params.maxPageSize));
  return url.toString();
}

export async function pollExchangeDelta(params: {
  pool: Pool;
  cfg: ExchangeConfigForPoll;
  runId: string;
  traceId: string;
  watermarkBefore: ExchangeWatermark | null;
  attemptCount: number;
  maxMessagesPerPoll?: number;
}) {
  if (params.cfg.instanceStatus !== "enabled") throw new ExchangePollError({ category: "policy_violation", message: "connector_instance_disabled" });
  if (!params.cfg.allowedDomains.includes("graph.microsoft.com")) throw new ExchangePollError({ category: "policy_violation", message: "egress_host_not_allowed", digest: { host: "graph.microsoft.com" } });

  const maxMessages = params.maxMessagesPerPoll ?? 50;
  const w = params.watermarkBefore ?? null;
  const hasLegacy = typeof (w as any)?.seq === "number" && !(w as any)?.deltaLink && !(w as any)?.nextLink;
  let cursorUrl = (w as any)?.nextLink || (w as any)?.deltaLink || initialDeltaUrl({ mailbox: params.cfg.mailbox, maxPageSize: Math.min(50, maxMessages) });
  let watermarkNote: string | undefined;
  if (hasLegacy) watermarkNote = "migrated_from_seq";

  const tokenState = await refreshTokenIfNeeded({ pool: params.pool, cfg: params.cfg, attemptCount: params.attemptCount });
  const accessToken = tokenState.accessToken;

  let scannedCount = 0;
  let insertedCount = 0;
  let dedupCount = 0;
  let deltaLink: string | null = null;
  let nextLink: string | null = null;

  while (cursorUrl && scannedCount < maxMessages) {
    const data = await graphRequestJson({ url: cursorUrl, token: accessToken, timeoutMs: 10_000 });
    const values: any[] = Array.isArray(data?.value) ? data.value : [];
    for (const m of values) {
      if (scannedCount >= maxMessages) break;
      const messageId = typeof m?.id === "string" ? m.id : "";
      if (!messageId) continue;
      scannedCount++;

      const eventId = `exchange:${params.cfg.connectorInstanceId}:${params.cfg.mailbox}:${messageId}`;
      const workspaceId = `exchange:${params.cfg.connectorInstanceId}:${params.cfg.mailbox}`;
      const receivedDateTime = typeof m?.receivedDateTime === "string" ? m.receivedDateTime : null;
      const fromAddr = m?.from?.emailAddress?.address;
      const toArr = Array.isArray(m?.toRecipients) ? m.toRecipients : [];
      const toJoined = toArr.map((x: any) => x?.emailAddress?.address).filter(Boolean).join(",");
      const subject = m?.subject;
      const bodyPreview = m?.bodyPreview;
      const hasAttachments = Boolean(m?.hasAttachments);

      const summary = {
        mailbox: params.cfg.mailbox,
        messageId,
        receivedDateTime,
        fromDigest: digestText(fromAddr),
        toDigest: digestText(toJoined),
        subjectDigest: digestText(subject),
        bodyDigest: { ...digestText(bodyPreview), alg: "sha256" },
        hasAttachments,
        attachmentsDigest: { count: 0 },
      };
      const bodyDigest = `sha256:${sha256Hex(JSON.stringify(summary))}`;
      const nonce = `msg:${messageId}`;

      const inserted = await params.pool.query(
        `
          INSERT INTO channel_ingress_events (
            tenant_id, provider, workspace_id, event_id, nonce, body_digest, body_json, request_id, trace_id, space_id, status
          )
          VALUES ($1,'exchange',$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'received')
          ON CONFLICT DO NOTHING
          RETURNING id
        `,
        [params.cfg.tenantId, workspaceId, eventId, nonce, bodyDigest, JSON.stringify(summary), params.runId, params.traceId, params.cfg.spaceId],
      );
      if (inserted.rowCount) insertedCount++;
      else dedupCount++;
    }

    nextLink = typeof data?.["@odata.nextLink"] === "string" ? data["@odata.nextLink"] : null;
    deltaLink = typeof data?.["@odata.deltaLink"] === "string" ? data["@odata.deltaLink"] : deltaLink;
    if (nextLink) cursorUrl = nextLink;
    else cursorUrl = null;
  }

  const watermarkAfter: ExchangeWatermark = { deltaLink: deltaLink ?? (w as any)?.deltaLink ?? null, nextLink: nextLink ?? null, lastSyncTime: new Date().toISOString() };
  if (!watermarkAfter.deltaLink && !watermarkAfter.nextLink) {
    watermarkAfter.deltaLink = (w as any)?.deltaLink ?? null;
  }

  const wDigest = {
    deltaLink: watermarkAfter.deltaLink ? { len: watermarkAfter.deltaLink.length, sha256_8: sha256_8(watermarkAfter.deltaLink) } : null,
    nextLink: watermarkAfter.nextLink ? { len: watermarkAfter.nextLink.length, sha256_8: sha256_8(watermarkAfter.nextLink) } : null,
  };

  return {
    summary: { insertedCount, dedupCount, scannedCount, watermarkAfter, watermarkNote } as ExchangePollSummary,
    watermarkDigest: wDigest,
  };
}
