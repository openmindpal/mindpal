import crypto from "node:crypto";
import type { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";

function stable(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stable);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stable(v[k]);
  return out;
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

async function insertAuditEvent(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
  resourceType: string;
  action: string;
  inputDigest?: any;
  outputDigest?: any;
  result: "success" | "denied" | "error";
  traceId: string;
  errorCategory?: string | null;
  latencyMs?: number;
}) {
  await params.pool.query(
    `
      INSERT INTO audit_events (
        subject_id, tenant_id, space_id, resource_type, action,
        input_digest, output_digest, result, trace_id, error_category, latency_ms
      )
      VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
      params.resourceType,
      params.action,
      params.inputDigest ?? null,
      params.outputDigest ?? null,
      params.result,
      params.traceId,
      params.errorCategory ?? null,
      params.latencyMs ?? null,
    ],
  );
}

function computeBackoffMs(base: number, attemptCount: number) {
  const b = Math.max(0, Number(base) || 0);
  const exp = Math.max(0, attemptCount - 1);
  const ms = b * Math.pow(2, exp);
  return Math.min(ms, 60_000);
}

async function claimOne(params: { pool: Pool }) {
  await params.pool.query("BEGIN");
  try {
    const res = await params.pool.query(
      `
        SELECT
          e.*,
          c.space_id AS cfg_space_id,
          c.max_attempts AS cfg_max_attempts,
          c.backoff_ms_base AS cfg_backoff_ms_base
        FROM channel_ingress_events e
        JOIN channel_webhook_configs c
          ON c.tenant_id = e.tenant_id AND c.provider = e.provider AND c.workspace_id = e.workspace_id
        WHERE e.status IN ('queued','failed')
          AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= now())
          AND e.attempt_count < c.max_attempts
          AND c.delivery_mode = 'async'
        ORDER BY e.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );
    if (!res.rowCount) {
      await params.pool.query("COMMIT");
      return null;
    }
    const row = res.rows[0];
    const upd = await params.pool.query(
      `
        UPDATE channel_ingress_events
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            next_attempt_at = NULL,
            last_error_category = NULL,
            last_error_digest = NULL,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [row.id],
    );
    await params.pool.query("COMMIT");
    return { event: upd.rows[0], cfg: { spaceId: row.cfg_space_id ?? null, maxAttempts: Number(row.cfg_max_attempts ?? 8), backoffMsBase: Number(row.cfg_backoff_ms_base ?? 500) } };
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

async function hasMapping(params: { pool: Pool; tenantId: string; provider: string; workspaceId: string; channelUserId?: string | null; channelChatId?: string | null }) {
  if (params.channelUserId) {
    const res = await params.pool.query(
      "SELECT 1 FROM channel_accounts WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND channel_user_id = $4 AND status = 'active' LIMIT 1",
      [params.tenantId, params.provider, params.workspaceId, params.channelUserId],
    );
    if (res.rowCount) return true;
  }
  if (params.channelChatId) {
    const res = await params.pool.query(
      "SELECT 1 FROM channel_chat_bindings WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND channel_chat_id = $4 AND status = 'active' LIMIT 1",
      [params.tenantId, params.provider, params.workspaceId, params.channelChatId],
    );
    if (res.rowCount) return true;
  }
  return false;
}

export async function tickWebhookDeliveries(params: { pool: Pool; limit?: number }) {
  const limit = params.limit ?? 20;
  for (let i = 0; i < limit; i++) {
    const startedAtMs = Date.now();
    const traceId = uuidv4();
    const claimed = await claimOne({ pool: params.pool });
    if (!claimed) return { ok: true };

    const e = claimed.event;
    const cfg = claimed.cfg;

    const tenantId = e.tenant_id as string;
    const provider = e.provider as string;
    const workspaceId = e.workspace_id as string;
    const eventId = e.event_id as string;
    const attemptCount = Number(e.attempt_count ?? 0);
    const body = e.body_json ?? null;
    const text = typeof body?.text === "string" ? body.text : "";
    const channelUserId = typeof body?.channelUserId === "string" ? body.channelUserId : null;
    const channelChatId = typeof body?.channelChatId === "string" ? body.channelChatId : null;

    const inputDigest = { id: e.id, provider, workspaceId, eventId, attemptCount };

    try {
      const mapped = await hasMapping({ pool: params.pool, tenantId, provider, workspaceId, channelUserId, channelChatId });
      if (!mapped) {
        const errDigest = { reason: "mapping_missing", bodyDigest: e.body_digest };
        const backoffMs = computeBackoffMs(cfg.backoffMsBase, attemptCount);
        const willDeadletter = attemptCount >= cfg.maxAttempts;
        if (willDeadletter) {
          await params.pool.query(
            `
              UPDATE channel_ingress_events
              SET status = 'deadletter',
                  last_error_category = 'mapping_missing',
                  last_error_digest = $2::jsonb,
                  deadlettered_at = now(),
                  updated_at = now()
              WHERE id = $1
            `,
            [e.id, JSON.stringify(errDigest)],
          );
          await insertAuditEvent({ pool: params.pool, tenantId, spaceId: cfg.spaceId, resourceType: "channel", action: "webhook.deadletter", inputDigest, outputDigest: errDigest, result: "denied", traceId, errorCategory: "policy_violation", latencyMs: Date.now() - startedAtMs });
          continue;
        }
        await params.pool.query(
          `
            UPDATE channel_ingress_events
            SET status = 'failed',
                last_error_category = 'mapping_missing',
                last_error_digest = $2::jsonb,
                next_attempt_at = now() + ($3 || ' milliseconds')::interval,
                updated_at = now()
            WHERE id = $1
          `,
          [e.id, JSON.stringify(errDigest), backoffMs],
        );
        await insertAuditEvent({ pool: params.pool, tenantId, spaceId: cfg.spaceId, resourceType: "channel", action: "webhook.attempt", inputDigest, outputDigest: { status: "failed", error: errDigest, nextAttemptMs: backoffMs }, result: "denied", traceId, errorCategory: "policy_violation", latencyMs: Date.now() - startedAtMs });
        continue;
      }

      if (text.toLowerCase().includes("fail")) throw new Error("downstream_failed");

      const resp = { correlation: { requestId: e.request_id, traceId: e.trace_id }, status: "succeeded" as const };
      await params.pool.query(
        `
          UPDATE channel_ingress_events
          SET status = 'succeeded',
              response_status_code = 200,
              response_json = $2::jsonb,
              updated_at = now()
          WHERE id = $1
        `,
        [e.id, JSON.stringify(resp)],
      );
      await insertAuditEvent({ pool: params.pool, tenantId, spaceId: cfg.spaceId, resourceType: "channel", action: "webhook.delivered", inputDigest, outputDigest: { status: "succeeded" }, result: "success", traceId, latencyMs: Date.now() - startedAtMs });
    } catch (err: any) {
      const backoffMs = computeBackoffMs(cfg.backoffMsBase, attemptCount);
      const digest = { message: String(err?.message ?? "unknown"), messageLen: String(err?.message ?? "").length, sha256_8: sha256Hex(String(err?.message ?? "unknown")).slice(0, 8) };
      const willDeadletter = attemptCount >= cfg.maxAttempts;
      if (willDeadletter) {
        await params.pool.query(
          `
            UPDATE channel_ingress_events
            SET status = 'deadletter',
                last_error_category = 'internal',
                last_error_digest = $2::jsonb,
                deadlettered_at = now(),
                updated_at = now()
            WHERE id = $1
          `,
          [e.id, JSON.stringify(digest)],
        );
        await insertAuditEvent({ pool: params.pool, tenantId, spaceId: cfg.spaceId, resourceType: "channel", action: "webhook.deadletter", inputDigest, outputDigest: digest, result: "error", traceId, errorCategory: "internal", latencyMs: Date.now() - startedAtMs });
        continue;
      }
      await params.pool.query(
        `
          UPDATE channel_ingress_events
          SET status = 'failed',
              last_error_category = 'internal',
              last_error_digest = $2::jsonb,
              next_attempt_at = now() + ($3 || ' milliseconds')::interval,
              updated_at = now()
          WHERE id = $1
        `,
        [e.id, JSON.stringify(digest), backoffMs],
      );
      await insertAuditEvent({ pool: params.pool, tenantId, spaceId: cfg.spaceId, resourceType: "channel", action: "webhook.attempt", inputDigest, outputDigest: { status: "failed", error: digest, nextAttemptMs: backoffMs }, result: "error", traceId, errorCategory: "internal", latencyMs: Date.now() - startedAtMs });
    }
  }
  return { ok: true };
}

