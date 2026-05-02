/**
 * AI Event Reasoning — Worker-side contribution.
 *
 * Provides:
 * 1. A BullMQ job handler for async LLM event reasoning (Tier 3)
 * 2. A ticker that scans unprocessed events from channel_ingress_events
 *    and submits them to the reasoning pipeline via the API.
 *
 * The ticker picks up events that have no corresponding reasoning log yet,
 * calls the API's /governance/event-reasoning/reason endpoint,
 * and if the decision is "execute", enqueues the resulting action.
 */
import type { Pool, PoolClient } from "pg";
import type { Queue } from "bullmq";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:aiEventReasoning" });

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────── Ticker: Scan and Submit Events ────────────────── */

/**
 * Scan recent channel_ingress_events that haven't been reasoned about yet,
 * and submit them to the reasoning pipeline.
 *
 * This uses a watermark pattern (like tickEvent.ts) to avoid reprocessing.
 * Events are submitted as BullMQ jobs for async processing.
 */
export async function tickEventReasoning(params: { pool: Pool; queue: Queue }) {
  // Check if AI event reasoning is enabled for any tenant
  const configRes = await params.pool.query(
    `SELECT DISTINCT tenant_id FROM event_reasoning_rules WHERE status = 'enabled' LIMIT 50`,
  );
  if (!configRes.rowCount) return; // No tenants have reasoning rules → skip

  const tenantIds = configRes.rows.map((r: any) => String(r.tenant_id));

  for (const tenantId of tenantIds) {
    await scanTenantEvents(params, tenantId);
  }
}

async function scanTenantEvents(params: { pool: Pool; queue: Queue }, tenantId: string) {
  // Get the watermark: last processed event timestamp for this tenant
  const wmRes = await params.pool.query(
    `SELECT MAX(created_at) AS last_at FROM event_reasoning_logs WHERE tenant_id = $1`,
    [tenantId],
  );
  const lastAt = wmRes.rows[0]?.last_at
    ? String(wmRes.rows[0].last_at)
    : "1970-01-01T00:00:00.000Z";

  // Fetch unprocessed events (events newer than last reasoning log)
  const evRes = await params.pool.query(
    `SELECT id, tenant_id, space_id, provider, workspace_id, event_id, body_json, created_at
     FROM channel_ingress_events
     WHERE tenant_id = $1 AND created_at > $2
     ORDER BY created_at ASC
     LIMIT 20`,
    [tenantId, lastAt],
  );

  for (const ev of evRes.rows as any[]) {
    const payload = ev.body_json ?? null;
    const eventType = payload && typeof payload === "object"
      ? String((payload as any).type ?? "unknown")
      : "unknown";

    // Check if this event was already reasoned about (idempotency)
    const existsRes = await params.pool.query(
      `SELECT 1 FROM event_reasoning_logs WHERE tenant_id = $1 AND event_source_id = $2 LIMIT 1`,
      [tenantId, String(ev.id)],
    );
    if (existsRes.rowCount) continue;

    // Enqueue for async reasoning
    await params.queue.add(
      "event.reasoning",
      {
        kind: "event.reasoning",
        tenantId,
        spaceId: ev.space_id ? String(ev.space_id) : null,
        eventSourceId: String(ev.id),
        eventType,
        provider: String(ev.provider ?? ""),
        workspaceId: String(ev.workspace_id ?? ""),
        payload,
      },
      {
        attempts: 2,
        backoff: { type: "exponential", delay: 2000 },
        // Prevent duplicate processing
        jobId: `event-reasoning:${tenantId}:${ev.id}`,
      },
    );
  }
}

/* ────────────────── Job Handler: Process Reasoning ────────────────── */

/**
 * BullMQ job handler for event reasoning.
 *
 * This runs the reasoning pipeline by calling the reasoning engine directly
 * (via DB queries + model invocation), without going through the HTTP API.
 */
export async function processEventReasoningJob(params: {
  pool: Pool;
  queue: Queue;
  data: any;
}) {
  const d = params.data;
  const tenantId = String(d.tenantId ?? "");
  const spaceId = d.spaceId ? String(d.spaceId) : null;
  const eventSourceId = String(d.eventSourceId ?? "");
  const eventType = String(d.eventType ?? "unknown");
  const provider = String(d.provider ?? "");
  const workspaceId = String(d.workspaceId ?? "");
  const payload = d.payload ?? null;

  if (!tenantId || !eventSourceId) {
    _logger.warn("event.reasoning job: missing tenantId or eventSourceId, skipping");
    return;
  }

  // Idempotency: check if already processed
  const existsRes = await params.pool.query(
    `SELECT 1 FROM event_reasoning_logs WHERE tenant_id = $1 AND event_source_id = $2 LIMIT 1`,
    [tenantId, eventSourceId],
  );
  if (existsRes.rowCount) return;

  const startMs = Date.now();

  // ── Tier 1: Fast Rules ──
  const rulesRes = await params.pool.query(
    `SELECT * FROM event_reasoning_rules
     WHERE tenant_id = $1 AND status = 'enabled' AND tier = 'rule'
     ORDER BY priority ASC LIMIT 100`,
    [tenantId],
  );

  for (const rule of rulesRes.rows as any[]) {
    const matched = matchRuleSimple(rule, eventType, provider, payload);
    if (matched) {
      const latencyMs = Date.now() - startMs;
      const actionResult =
        String(rule.decision ?? "") === "execute" && rule.action_ref
          ? await enqueueAction(params, tenantId, spaceId, eventSourceId, rule)
          : null;
      await insertLog(params.pool, {
        tenantId, spaceId, eventSourceId, eventType, provider, workspaceId,
        payload, tier: "rule", decision: String(rule.decision ?? "execute"),
        confidence: 1.0, matchedRuleId: String(rule.rule_id),
        matchDigest: { ruleName: String(rule.name) },
        actionKind: rule.action_kind, actionRef: rule.action_ref,
        actionInput: rule.action_input_template,
        runId: actionResult?.runId ?? null,
        stepId: actionResult?.stepId ?? null,
        latencyMs,
      });
      return;
    }
  }

  // ── Tier 2: Pattern Match ──
  const patternsRes = await params.pool.query(
    `SELECT * FROM event_reasoning_rules
     WHERE tenant_id = $1 AND status = 'enabled' AND tier = 'pattern'
     ORDER BY priority ASC LIMIT 50`,
    [tenantId],
  );

  for (const pattern of patternsRes.rows as any[]) {
    const matched = matchRuleSimple(pattern, eventType, provider, payload);
    if (matched) {
      const latencyMs = Date.now() - startMs;
      const actionResult =
        String(pattern.decision ?? "") === "execute" && pattern.action_ref
          ? await enqueueAction(params, tenantId, spaceId, eventSourceId, pattern)
          : null;
      await insertLog(params.pool, {
        tenantId, spaceId, eventSourceId, eventType, provider, workspaceId,
        payload, tier: "pattern", decision: String(pattern.decision ?? "execute"),
        confidence: 0.85, matchedRuleId: String(pattern.rule_id),
        matchDigest: { patternName: String(pattern.name) },
        actionKind: pattern.action_kind, actionRef: pattern.action_ref,
        actionInput: pattern.action_input_template,
        runId: actionResult?.runId ?? null,
        stepId: actionResult?.stepId ?? null,
        latencyMs,
      });
      return;
    }
  }

  // ── Tier 3: No rule/pattern matched → log as "escalate" for LLM processing ──
  // LLM reasoning is handled by the API-side (routes.ts /reason endpoint)
  // Worker just marks it as needing escalation
  const latencyMs = Date.now() - startMs;
  await insertLog(params.pool, {
    tenantId, spaceId, eventSourceId, eventType, provider, workspaceId,
    payload, tier: "pattern", decision: "escalate",
    confidence: null, matchedRuleId: null,
    matchDigest: { reason: "no_rule_or_pattern_matched" },
    actionKind: null, actionRef: null, actionInput: null,
    latencyMs,
  });
}

/* ────────────────── Helpers ────────────────── */

function globMatch(pattern: string, value: string): boolean {
  if (!pattern) return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function matchRuleSimple(
  rule: any,
  eventType: string,
  provider: string,
  _payload: any,
): boolean {
  const typePattern = rule.event_type_pattern ? String(rule.event_type_pattern) : null;
  if (typePattern && !globMatch(typePattern, eventType)) return false;

  const providerPattern = rule.provider_pattern ? String(rule.provider_pattern) : null;
  if (providerPattern && provider && !globMatch(providerPattern, provider)) return false;

  // Condition expression evaluation (simplified for worker side)
  const condExpr = rule.condition_expr;
  if (condExpr && typeof condExpr === "object") {
    // Basic condition: { path, op, value }
    if (typeof condExpr.path === "string" && _payload && typeof _payload === "object") {
      const segs = String(condExpr.path).split(".").filter(Boolean);
      let cur: any = _payload;
      for (const s of segs) {
        if (!cur || typeof cur !== "object") { cur = undefined; break; }
        cur = cur[s];
      }
      const op = String(condExpr.op ?? "eq");
      const expected = condExpr.value;
      if (op === "eq" && JSON.stringify(cur) !== JSON.stringify(expected)) return false;
      if (op === "neq" && JSON.stringify(cur) === JSON.stringify(expected)) return false;
      if (op === "gt" && !(Number(cur) > Number(expected))) return false;
      if (op === "gte" && !(Number(cur) >= Number(expected))) return false;
      if (op === "lt" && !(Number(cur) < Number(expected))) return false;
      if (op === "lte" && !(Number(cur) <= Number(expected))) return false;
      if (op === "exists" && (cur === undefined || cur === null)) return false;
    }
  }

  return true;
}

async function insertLog(pool: Pool, p: {
  tenantId: string; spaceId: string | null; eventSourceId: string;
  eventType: string; provider: string; workspaceId: string;
  payload: any; tier: string; decision: string;
  confidence: number | null; matchedRuleId: string | null;
  matchDigest: any; actionKind: string | null;
  actionRef: string | null; actionInput: any;
  runId?: string | null; stepId?: string | null;
  errorCategory?: string | null; errorDigest?: any;
  latencyMs: number;
}) {
  await pool.query(
    `INSERT INTO event_reasoning_logs (
       tenant_id, space_id, event_source_id, event_type, provider, workspace_id,
       event_payload, tier, decision, confidence,
       action_kind, action_ref, action_input, run_id, step_id,
       matched_rule_id, match_digest, latency_ms, error_category, error_digest
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17::jsonb,$18,$19,$20::jsonb)`,
    [
      p.tenantId, p.spaceId, p.eventSourceId, p.eventType, p.provider, p.workspaceId,
      p.payload ? JSON.stringify(p.payload) : null,
      p.tier, p.decision, p.confidence,
      p.actionKind, p.actionRef,
      p.actionInput ? JSON.stringify(p.actionInput) : null,
      p.runId ?? null, p.stepId ?? null,
      p.matchedRuleId, p.matchDigest ? JSON.stringify(p.matchDigest) : null,
      p.latencyMs,
      p.errorCategory ?? null,
      p.errorDigest ? JSON.stringify(p.errorDigest) : null,
    ],
  );
}

async function enqueueAction(
  params: { pool: Pool; queue: Queue },
  tenantId: string,
  spaceId: string | null,
  eventSourceId: string,
  rule: any,
) {
  const actionKind = String(rule.action_kind ?? "");
  const actionRef = String(rule.action_ref ?? "");
  const ruleId = String(rule.rule_id ?? "");
  const queueJobId = `event-reasoning-action:${tenantId}:${eventSourceId}:${ruleId || actionRef || actionKind}`;
  const idempotencyKey = `event-reasoning:${eventSourceId}:${ruleId || actionRef || actionKind}`;

  if (actionKind === "workflow" || actionKind === "tool") {
    const jobType = actionKind === "workflow" ? "tool.execute" : actionRef;
    const input = rule.action_input_template ?? {};
    let created = await createJobRunStepForReasoning({
      pool: params.pool,
      tenantId,
      jobType,
      toolRef: actionRef,
      trigger: `ai-event-reasoning:${ruleId || "rule"}`,
      idempotencyKey,
      input: {
        ...input,
        tenantId,
        spaceId,
        toolRef: actionRef,
        trigger: `ai-event-reasoning:${ruleId || "rule"}`,
      },
    });
    if (created.alreadyQueued) {
      return created;
    }
    try {
      const job = await params.queue.add("step", { jobId: created.jobId, runId: created.runId, stepId: created.stepId }, {
        attempts: 3,
        backoff: { type: "exponential", delay: 500 },
        jobId: queueJobId,
      });
      await params.pool.query(
        "UPDATE steps SET queue_job_id = $2, updated_at = now() WHERE step_id = $1",
        [created.stepId, String((job as any).id ?? queueJobId)],
      );
      created = { ...created, queueJobId: String((job as any).id ?? queueJobId) };
      return created;
    } catch (err: any) {
      await markCreatedActionFailed({
        pool: params.pool,
        tenantId,
        runId: created.runId,
        jobId: created.jobId,
        stepId: created.stepId,
        errorMessage: String(err?.message ?? err).slice(0, 1000),
      });
      throw err;
    }
  }

  if (actionKind === "notify") {
    // Enqueue notification
    await params.pool.query(
      `INSERT INTO notification_outbox (tenant_id, template_ref, status, payload)
       VALUES ($1, $2, 'pending', $3::jsonb)
       ON CONFLICT DO NOTHING`,
      [tenantId, actionRef, JSON.stringify(rule.action_input_template ?? {})],
    );
    return null;
  }

  return null;
}

async function createJobRunStepForReasoning(params: {
  pool: Pool;
  tenantId: string;
  jobType: string;
  toolRef: string;
  trigger: string;
  idempotencyKey: string;
  input: any;
}) {
  return withTransaction(params.pool, async (client) => {
    const runRes = await client.query(
      `
        INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key, trigger)
        VALUES ($1, 'created', $2, $3, $4, $5)
        ON CONFLICT (tenant_id, idempotency_key, tool_ref) WHERE idempotency_key IS NOT NULL AND tool_ref IS NOT NULL
        DO UPDATE SET updated_at = now()
        RETURNING run_id
      `,
      [params.tenantId, params.toolRef, params.input ?? null, params.idempotencyKey, params.trigger],
    );
    const runId = String(runRes.rows[0].run_id);
    const existing = await client.query(
      `
        SELECT j.job_id, s.step_id, s.status AS step_status, s.queue_job_id
        FROM jobs j
        JOIN steps s ON s.run_id = j.run_id AND s.seq = 1
        WHERE j.tenant_id = $1 AND j.run_id = $2
        ORDER BY j.created_at DESC
        LIMIT 1
      `,
      [params.tenantId, runId],
    );
    if (existing.rowCount) {
      const row = existing.rows[0] as any;
      const jobId = String(row.job_id);
      const stepId = String(row.step_id);
      const stepStatus = String(row.step_status ?? "");
      const existingQueueJobId = row.queue_job_id ? String(row.queue_job_id) : null;
      const retryQueueError = stepStatus === "failed" && !existingQueueJobId;
      if (retryQueueError) {
        await client.query(
          "UPDATE runs SET status = 'created', updated_at = now(), finished_at = NULL WHERE tenant_id = $1 AND run_id = $2",
          [params.tenantId, runId],
        );
        await client.query(
          "UPDATE jobs SET status = 'queued', updated_at = now(), result_summary = NULL WHERE tenant_id = $1 AND job_id = $2",
          [params.tenantId, jobId],
        );
        await client.query(
          `UPDATE steps
           SET status = 'pending',
               updated_at = now(),
               finished_at = NULL,
               deadlettered_at = NULL,
               error_category = NULL,
               last_error = NULL,
               queue_job_id = NULL
           WHERE step_id = $1`,
          [stepId],
        );
      }
      return {
        jobId,
        runId,
        stepId,
        queueJobId: existingQueueJobId,
        alreadyQueued: Boolean(existingQueueJobId && !retryQueueError),
      };
    }

    const jobRes = await client.query(
      "INSERT INTO jobs (tenant_id, job_type, status, run_id) VALUES ($1, $2, 'queued', $3) RETURNING job_id",
      [params.tenantId, params.jobType, runId],
    );
    const jobId = String(jobRes.rows[0].job_id);
    const stepRes = await client.query(
      `INSERT INTO steps (run_id, seq, tool_ref, status, input, input_digest)
       VALUES ($1, 1, $2, 'pending', $3::jsonb, $4::jsonb) RETURNING step_id`,
      [runId, params.toolRef, JSON.stringify(params.input), JSON.stringify(params.input)],
    );
    return {
      jobId,
      runId,
      stepId: String(stepRes.rows[0].step_id),
      queueJobId: null,
      alreadyQueued: false,
    };
  });
}

async function markCreatedActionFailed(params: {
  pool: Pool;
  tenantId: string;
  runId: string;
  jobId: string;
  stepId: string;
  errorMessage: string;
}) {
  await params.pool.query(
    "UPDATE runs SET status = 'failed', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE tenant_id = $1 AND run_id = $2",
    [params.tenantId, params.runId],
  ).catch(() => undefined);
  await params.pool.query(
    "UPDATE jobs SET status = 'failed', updated_at = now(), result_summary = $3::jsonb WHERE tenant_id = $1 AND job_id = $2",
    [params.tenantId, params.jobId, JSON.stringify({ error: params.errorMessage })],
  ).catch(() => undefined);
  await params.pool.query(
    `UPDATE steps
     SET status = 'failed',
         updated_at = now(),
         finished_at = COALESCE(finished_at, now()),
         error_category = 'queue_error',
         last_error = $2,
         queue_job_id = NULL
     WHERE step_id = $1`,
    [params.stepId, params.errorMessage],
  ).catch(() => undefined);
}
