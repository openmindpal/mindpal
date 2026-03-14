import { Queue, Worker } from "bullmq";
import "./otel";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { loadConfig } from "./config";
import { createPool } from "./db/pool";
import { attachJobTraceCarrier, extractJobTraceContext } from "./lib/tracing";
import { processKnowledgeIndexJob } from "./knowledge/processor";
import { processKnowledgeEmbeddingJob } from "./knowledge/embedding";
import { processKnowledgeIngestJob } from "./knowledge/ingest";
import { processAuditExport } from "./audit/exportProcessor";
import { processMediaJob } from "./media/processor";
import { reencryptSecrets } from "./keyring/reencrypt";
import { processStep } from "./workflow/processor";
import { markWorkflowStepDeadletter } from "./workflow/deadletter";
import { tickSubscriptions } from "./subscriptions/ticker";
import { tickWebhookDeliveries } from "./channels/webhookDelivery";
import { tickEmailDeliveries } from "./notifications/smtpDelivery";
import { tickWorkflowStepPayloadPurge } from "./workflow/payloadPurge";
import { tickAuditSiemWebhookExport } from "./audit/siemWebhook";
import { tickTriggers } from "./triggers/ticker";

const tracer = trace.getTracer("openslin-worker");

async function main() {
  const isProd = process.env.NODE_ENV === "production";
  const masterKey = String(process.env.API_MASTER_KEY ?? "").trim();
  if (isProd && (!masterKey || masterKey === "dev-master-key-change-me")) {
    throw new Error("API_MASTER_KEY is required in production");
  }
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg);
  const connection = { host: cfg.redis.host, port: cfg.redis.port };
  const queue = new Queue("workflow", { connection });
  const origAdd = queue.add.bind(queue);
  (queue as any).add = (name: string, data: any, opts: any) => origAdd(name, attachJobTraceCarrier(data ?? {}), opts);
  const redis = await queue.client;

  setInterval(() => {
    redis.set("worker:heartbeat:ts", String(Date.now()), "PX", 60_000).catch(() => {
    });
  }, 10_000).unref();

  async function scheduleNextAgentRunStep(params: { jobId: string; runId: string }) {
    const runRes = await pool.query("SELECT tenant_id, status, input_digest, started_at, created_at FROM runs WHERE run_id = $1 LIMIT 1", [params.runId]);
    if (!runRes.rowCount) return;
    const tenantId = String(runRes.rows[0].tenant_id ?? "");
    const status = String(runRes.rows[0].status ?? "");
    if (["succeeded", "failed", "canceled", "stopped"].includes(status)) return;
    if (status === "needs_approval") return;

    const inputDigest = (runRes.rows[0].input_digest as any) ?? null;
    const limits = (inputDigest?.limits as any) ?? null;
    const maxSteps = limits?.maxSteps ? Number(limits.maxSteps) : null;
    const maxWallTimeMs = limits?.maxWallTimeMs ? Number(limits.maxWallTimeMs) : null;
    const collabRunId = typeof inputDigest?.collabRunId === "string" ? String(inputDigest.collabRunId) : "";
    const taskId = typeof inputDigest?.taskId === "string" ? String(inputDigest.taskId) : "";
    const isCollab = String(inputDigest?.kind ?? "") === "collab.run" && collabRunId && taskId;

    const candidatesRes = await pool.query(
      `
        SELECT step_id, seq, tool_ref, input, policy_snapshot_ref, input_digest
        FROM steps
        WHERE run_id = $1 AND status = 'pending' AND (queue_job_id IS NULL OR queue_job_id = '')
        ORDER BY seq ASC
        LIMIT 20
      `,
      [params.runId],
    );
    if (!candidatesRes.rowCount) return;

    const spaceIdHint = (candidatesRes.rows[0]?.input as any)?.spaceId ? String((candidatesRes.rows[0].input as any).spaceId) : "";

    if (maxSteps && candidatesRes.rows[0] && Number(candidatesRes.rows[0].seq ?? 0) > maxSteps) {
      await pool.query("UPDATE runs SET status = 'stopped', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
      await pool.query("UPDATE jobs SET status = 'stopped', updated_at = now() WHERE job_id = $1", [params.jobId]);
      await pool.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status = 'pending'", [params.runId]);
      const spaceRes = await pool.query("SELECT (input->>'spaceId') AS space_id, r.tenant_id FROM steps s JOIN runs r ON r.run_id = s.run_id WHERE s.run_id = $1 AND s.seq = 1 LIMIT 1", [
        params.runId,
      ]);
      if (spaceRes.rowCount) {
        const spaceId = String(spaceRes.rows[0].space_id ?? "");
        const tenantId2 = String(spaceRes.rows[0].tenant_id ?? "");
        if (tenantId2 && spaceId) {
          await pool.query(
            "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
            [tenantId2, spaceId, params.runId, "stopped.limit_exceeded"],
          );
        }
      }
      if (isCollab && tenantId) {
        await pool.query("UPDATE collab_runs SET status = 'stopped', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId]);
        const ex = await pool.query("SELECT 1 FROM collab_run_events WHERE tenant_id = $1 AND collab_run_id = $2 AND type = $3 AND run_id = $4 LIMIT 1", [
          tenantId,
          collabRunId,
          "collab.budget.exceeded",
          params.runId,
        ]);
        if (!ex.rowCount) {
          await pool.query(
            "INSERT INTO collab_run_events (tenant_id, space_id, collab_run_id, task_id, type, actor_role, run_id, step_id, payload_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [tenantId, spaceIdHint || null, collabRunId, taskId, "collab.budget.exceeded", null, params.runId, null, { reason: "maxSteps" }],
          );
        }
      }
      return;
    }

    if (maxWallTimeMs) {
      const startedAt = (runRes.rows[0].started_at as string | null) ?? (runRes.rows[0].created_at as string | null) ?? null;
      if (startedAt) {
        const elapsedMs = Date.now() - new Date(startedAt).getTime();
        if (elapsedMs > maxWallTimeMs) {
          await pool.query("UPDATE runs SET status = 'stopped', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
          await pool.query("UPDATE jobs SET status = 'stopped', updated_at = now() WHERE job_id = $1", [params.jobId]);
          await pool.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status = 'pending'", [params.runId]);
          const spaceRes = await pool.query(
            "SELECT (input->>'spaceId') AS space_id, r.tenant_id FROM steps s JOIN runs r ON r.run_id = s.run_id WHERE s.run_id = $1 AND s.seq = 1 LIMIT 1",
            [params.runId],
          );
          if (spaceRes.rowCount) {
            const spaceId = String(spaceRes.rows[0].space_id ?? "");
            const tenantId2 = String(spaceRes.rows[0].tenant_id ?? "");
            if (tenantId2 && spaceId) {
              await pool.query(
                "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
                [tenantId2, spaceId, params.runId, "stopped.timeout"],
              );
            }
          }
          if (isCollab && tenantId) {
            await pool.query("UPDATE collab_runs SET status = 'stopped', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId]);
            const ex = await pool.query("SELECT 1 FROM collab_run_events WHERE tenant_id = $1 AND collab_run_id = $2 AND type = $3 AND run_id = $4 LIMIT 1", [
              tenantId,
              collabRunId,
              "collab.budget.exceeded",
              params.runId,
            ]);
            if (!ex.rowCount) {
              await pool.query(
                "INSERT INTO collab_run_events (tenant_id, space_id, collab_run_id, task_id, type, actor_role, run_id, step_id, payload_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                [tenantId, spaceIdHint || null, collabRunId, taskId, "collab.budget.exceeded", null, params.runId, null, { reason: "timeout" }],
              );
            }
          }
          return;
        }
      }
    }

    const completedPlanStepIds = new Set<string>();
    if (isCollab) {
      const doneRes = await pool.query("SELECT (input->>'planStepId') AS plan_step_id FROM steps WHERE run_id = $1 AND status = 'succeeded'", [params.runId]);
      for (const r of doneRes.rows) {
        const v = r.plan_step_id ? String(r.plan_step_id) : "";
        if (v) completedPlanStepIds.add(v);
      }
    }

    let roleAllowed: Record<string, Set<string> | null> = {};
    if (isCollab && tenantId && spaceIdHint) {
      const ts = await pool.query("SELECT plan FROM memory_task_states WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL LIMIT 1", [
        tenantId,
        spaceIdHint,
        params.runId,
      ]);
      const plan = ts.rowCount ? ((ts.rows[0] as any).plan as any) : null;
      const roles = Array.isArray(plan?.roles) ? plan.roles : [];
      roleAllowed = {};
      for (const r of roles) {
        const rn = typeof r?.roleName === "string" ? String(r.roleName) : "";
        const allowed = Array.isArray(r?.toolPolicy?.allowedTools) ? r.toolPolicy.allowedTools.map((x: any) => String(x)) : null;
        if (rn) roleAllowed[rn] = allowed ? new Set<string>(allowed) : null;
      }
    }

    const ready: Array<{ stepId: string; seq: number; toolRef: string | null; metaInput: any; policySnapshotRef: any; inputDigest: any }> = [];
    for (const row of candidatesRes.rows) {
      const stepId = String(row.step_id ?? "");
      const seq = Number(row.seq ?? 0);
      if (!stepId || !seq) continue;
      if (maxSteps && seq > maxSteps) continue;
      const toolRef = row.tool_ref ? String(row.tool_ref) : null;
      const metaInput = (row.input as any) ?? null;
      if (isCollab) {
        const dependsOn = Array.isArray(metaInput?.dependsOn) ? metaInput.dependsOn.map((x: any) => String(x)) : [];
        const ok = dependsOn.every((d: string) => completedPlanStepIds.has(d));
        if (!ok) continue;
        const actorRole = metaInput?.actorRole ? String(metaInput.actorRole) : "";
        const allowedSet = actorRole ? roleAllowed[actorRole] ?? null : null;
        if (allowedSet && toolRef && !allowedSet.has(toolRef)) {
          await pool.query("UPDATE runs SET status = 'stopped', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
          await pool.query("UPDATE jobs SET status = 'stopped', updated_at = now() WHERE job_id = $1", [params.jobId]);
          await pool.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status = 'pending'", [params.runId]);
          if (tenantId && spaceIdHint) {
            await pool.query(
              "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
              [tenantId, spaceIdHint, params.runId, "stopped.policy_denied"],
            );
          }
          await pool.query("UPDATE collab_runs SET status = 'stopped', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId]);
          const ex = await pool.query("SELECT 1 FROM collab_run_events WHERE tenant_id = $1 AND collab_run_id = $2 AND type = $3 AND run_id = $4 AND step_id = $5 LIMIT 1", [
            tenantId,
            collabRunId,
            "collab.policy.denied",
            params.runId,
            stepId,
          ]);
          if (!ex.rowCount) {
            await pool.query(
              "INSERT INTO collab_run_events (tenant_id, space_id, collab_run_id, task_id, type, actor_role, run_id, step_id, payload_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
              [tenantId, spaceIdHint || null, collabRunId, taskId, "collab.policy.denied", actorRole || null, params.runId, stepId, { toolRef, reason: "tool_not_allowed" }],
            );
          }
          return;
        }
      }
      ready.push({ stepId, seq, toolRef, metaInput, policySnapshotRef: row.policy_snapshot_ref ?? null, inputDigest: row.input_digest ?? null });
    }
    if (!ready.length) return;

    const first = ready[0]!;
    const tc = first.metaInput?.toolContract ?? null;
    const approvalRequired = Boolean(tc?.approvalRequired) || tc?.riskLevel === "high";
    if (approvalRequired) {
      const spaceId = first.metaInput?.spaceId ? String(first.metaInput.spaceId) : null;
      const subjectId = first.metaInput?.subjectId ? String(first.metaInput.subjectId) : null;
      await pool.query(
        `
          INSERT INTO approvals (tenant_id, space_id, run_id, step_id, status, requested_by_subject_id, tool_ref, policy_snapshot_ref, input_digest)
          VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8)
          ON CONFLICT (tenant_id, run_id) DO UPDATE SET status = 'pending', step_id = EXCLUDED.step_id, tool_ref = EXCLUDED.tool_ref, policy_snapshot_ref = EXCLUDED.policy_snapshot_ref, input_digest = EXCLUDED.input_digest, updated_at = now()
        `,
        [tenantId, spaceId, params.runId, first.stepId, subjectId ?? "unknown", first.toolRef, first.policySnapshotRef, first.inputDigest],
      );
      await pool.query("UPDATE runs SET status = 'needs_approval', updated_at = now() WHERE run_id = $1", [params.runId]);
      await pool.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE job_id = $1", [params.jobId]);
      if (tenantId && spaceId) {
        await pool.query(
          "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
          [tenantId, spaceId, params.runId, "needs_approval"],
        );
      }
      if (isCollab && tenantId) {
        await pool.query("UPDATE collab_runs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId]);
        const ex = await pool.query("SELECT 1 FROM collab_run_events WHERE tenant_id = $1 AND collab_run_id = $2 AND type = $3 AND run_id = $4 AND step_id = $5 LIMIT 1", [
          tenantId,
          collabRunId,
          "collab.run.needs_approval",
          params.runId,
          first.stepId,
        ]);
        if (!ex.rowCount) {
          await pool.query(
            "INSERT INTO collab_run_events (tenant_id, space_id, collab_run_id, task_id, type, actor_role, run_id, step_id, payload_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [tenantId, spaceIdHint || null, collabRunId, taskId, "collab.run.needs_approval", first.metaInput?.actorRole ? String(first.metaInput.actorRole) : null, params.runId, first.stepId, { toolRef: first.toolRef }],
          );
        }
      }
      return;
    }

    const maxParallel = isCollab ? 3 : 1;
    for (const n of ready.slice(0, maxParallel)) {
      const bj = await queue.add("step", { jobId: params.jobId, runId: params.runId, stepId: n.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
      await pool.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2 AND (queue_job_id IS NULL OR queue_job_id = '')", [
        String((bj as any).id),
        n.stepId,
      ]);
    }
  }

  const worker = new Worker(
    "workflow",
    async (job) => {
      const data = job.data as any;
      const jobCtx = extractJobTraceContext(data);
      return await context.with(jobCtx, async () => {
        if (data?.kind === "audit.export") {
          await processAuditExport({ pool, tenantId: String(data.tenantId), exportId: String(data.exportId), subjectId: String(data.subjectId), spaceId: data.spaceId ? String(data.spaceId) : null });
          return;
        }
        if (data?.kind === "media.process") {
          await processMediaJob({ pool, tenantId: String(data.tenantId), jobId: String(data.jobId), fsRootDir: cfg.media.fsRootDir });
          return;
        }
        if (data?.kind === "keyring.reencrypt") {
          await reencryptSecrets({
            pool,
            tenantId: String(data.tenantId),
            scopeType: String(data.scopeType),
            scopeId: String(data.scopeId),
            limit: Number(data.limit ?? 500),
          });
          return;
        }
        if (data?.kind === "knowledge.index") {
          const out = await processKnowledgeIndexJob({ pool, indexJobId: data.indexJobId });
          if (out && out.chunkCount > 0) {
            const embeddingModelRef = String(process.env.KNOWLEDGE_EMBEDDING_MODEL_REF ?? "").trim() || "minhash:16@1";
            const ins = await pool.query(
              `
                INSERT INTO knowledge_embedding_jobs (tenant_id, space_id, document_id, document_version, embedding_model_ref, status)
                VALUES ($1,$2,$3,$4,$5,'queued')
                ON CONFLICT (tenant_id, space_id, document_id, document_version, embedding_model_ref)
                DO UPDATE SET updated_at = now()
                RETURNING id
              `,
              [out.tenantId, out.spaceId, out.documentId, out.documentVersion, embeddingModelRef],
            );
            const embeddingJobId = ins.rowCount ? String(ins.rows[0].id) : "";
            if (embeddingJobId) {
              await queue.add("knowledge.embed", { kind: "knowledge.embed", embeddingJobId }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
            }
          }
          return;
        }
        if (data?.kind === "knowledge.embed") {
          await processKnowledgeEmbeddingJob({ pool, embeddingJobId: data.embeddingJobId });
          return;
        }
        if (data?.kind === "knowledge.ingest") {
          const out = await processKnowledgeIngestJob({ pool, ingestJobId: data.ingestJobId });
          if (out?.indexJobId) {
            await queue.add("knowledge.index", { kind: "knowledge.index", indexJobId: out.indexJobId }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
          }
          return;
        }
      let collabMeta: { tenantId: string; spaceId: string | null; collabRunId: string; taskId: string; actorRole: string | null; stepId: string; runId: string } | null = null;
      try {
        const metaRes = await pool.query(
          `
            SELECT r.tenant_id, (s.input->>'spaceId') AS space_id, (s.input->>'collabRunId') AS collab_run_id, (s.input->>'taskId') AS task_id, (s.input->>'actorRole') AS actor_role
            FROM steps s
            JOIN runs r ON r.run_id = s.run_id
            WHERE s.step_id = $1
            LIMIT 1
          `,
          [String(data.stepId ?? "")],
        );
        if (metaRes.rowCount) {
          const collabRunId = String(metaRes.rows[0].collab_run_id ?? "");
          const taskId = String(metaRes.rows[0].task_id ?? "");
          if (collabRunId && taskId) {
            collabMeta = {
              tenantId: String(metaRes.rows[0].tenant_id ?? ""),
              spaceId: metaRes.rows[0].space_id ? String(metaRes.rows[0].space_id) : null,
              collabRunId,
              taskId,
              actorRole: metaRes.rows[0].actor_role ? String(metaRes.rows[0].actor_role) : null,
              stepId: String(data.stepId ?? ""),
              runId: String(data.runId ?? ""),
            };
            const ex = await pool.query("SELECT 1 FROM collab_run_events WHERE tenant_id = $1 AND collab_run_id = $2 AND type = $3 AND step_id = $4 LIMIT 1", [
              collabMeta.tenantId,
              collabMeta.collabRunId,
              "collab.step.started",
              collabMeta.stepId,
            ]);
            if (!ex.rowCount) {
              const tool = await pool.query("SELECT tool_ref, seq, (input->>'planStepId') AS plan_step_id FROM steps WHERE step_id = $1 LIMIT 1", [collabMeta.stepId]);
              const toolRef = tool.rowCount ? (tool.rows[0].tool_ref ? String(tool.rows[0].tool_ref) : null) : null;
              const seq = tool.rowCount ? Number(tool.rows[0].seq ?? 0) : 0;
              const planStepId = tool.rowCount ? (tool.rows[0].plan_step_id ? String(tool.rows[0].plan_step_id) : null) : null;
              await pool.query(
                "INSERT INTO collab_run_events (tenant_id, space_id, collab_run_id, task_id, type, actor_role, run_id, step_id, payload_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                [collabMeta.tenantId, collabMeta.spaceId, collabMeta.collabRunId, collabMeta.taskId, "collab.step.started", collabMeta.actorRole, collabMeta.runId, collabMeta.stepId, { toolRef, seq, planStepId }],
              );
            }
          }
        }
      } catch {
      }
      try {
        const span = tracer.startSpan("workflow.step.process", { attributes: { jobId: String(data.jobId ?? ""), runId: String(data.runId ?? ""), stepId: String(data.stepId ?? ""), kind: "step" } });
        try {
          await context.with(trace.setSpan(context.active(), span), async () => {
            await processStep({ pool, jobId: data.jobId, runId: data.runId, stepId: data.stepId });
          });
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (e: any) {
          span.recordException(e);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw e;
        } finally {
          span.end();
        }
        redis.incr("worker:workflow:step:success").catch(() => {
        });
        redis.incr("worker:tool_execute:success").catch(() => {
        });
      } catch (e) {
        redis.incr("worker:workflow:step:error").catch(() => {
        });
        redis.incr("worker:tool_execute:error").catch(() => {
        });
        throw e;
      }
      try {
        if (collabMeta) {
          const st = await pool.query("SELECT status, tool_ref, seq, error_category, last_error_digest, output_digest, (input->>'planStepId') AS plan_step_id FROM steps WHERE step_id = $1 LIMIT 1", [
            collabMeta.stepId,
          ]);
          if (st.rowCount) {
            const s = String(st.rows[0].status ?? "");
            const toolRef = st.rows[0].tool_ref ? String(st.rows[0].tool_ref) : null;
            const seq = Number(st.rows[0].seq ?? 0);
            const planStepId = st.rows[0].plan_step_id ? String(st.rows[0].plan_step_id) : null;
            const type = s === "succeeded" ? "collab.step.completed" : s === "failed" ? "collab.step.failed" : "";
            if (type) {
              const ex = await pool.query("SELECT 1 FROM collab_run_events WHERE tenant_id = $1 AND collab_run_id = $2 AND type = $3 AND step_id = $4 LIMIT 1", [
                collabMeta.tenantId,
                collabMeta.collabRunId,
                type,
                collabMeta.stepId,
              ]);
              if (!ex.rowCount) {
                const payload =
                  type === "collab.step.completed"
                    ? { toolRef, seq, planStepId, outputDigest: st.rows[0].output_digest ?? null }
                    : { toolRef, seq, planStepId, errorCategory: st.rows[0].error_category ?? null, lastErrorDigest: st.rows[0].last_error_digest ?? null };
                await pool.query(
                  "INSERT INTO collab_run_events (tenant_id, space_id, collab_run_id, task_id, type, actor_role, run_id, step_id, payload_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                  [collabMeta.tenantId, collabMeta.spaceId, collabMeta.collabRunId, collabMeta.taskId, type, collabMeta.actorRole, collabMeta.runId, collabMeta.stepId, payload],
                );
              }
            }
          }
        }
      } catch {
      }
      try {
        const jobTypeRes = await pool.query("SELECT job_type FROM jobs WHERE job_id = $1 LIMIT 1", [String(data.jobId ?? "")]);
        const jobType = jobTypeRes.rowCount ? String(jobTypeRes.rows[0].job_type ?? "") : "";
        if (jobType === "agent.run") {
          await scheduleNextAgentRunStep({ jobId: String(data.jobId ?? ""), runId: String(data.runId ?? "") });
        }
      } catch {
      }
      try {
        const r = await pool.query("SELECT status, input_digest, tenant_id FROM runs WHERE run_id = $1 LIMIT 1", [String(data.runId ?? "")]);
        if (r.rowCount) {
          const st = String(r.rows[0].status ?? "");
          const inputDigest = (r.rows[0].input_digest as any) ?? null;
          const collabRunId = typeof inputDigest?.collabRunId === "string" ? String(inputDigest.collabRunId) : "";
          const taskId = typeof inputDigest?.taskId === "string" ? String(inputDigest.taskId) : "";
          const kind = String(inputDigest?.kind ?? "");
          const tenantId = String(r.rows[0].tenant_id ?? "");
          if (kind === "collab.run" && collabRunId && taskId && ["succeeded", "failed", "canceled", "stopped"].includes(st)) {
            await pool.query("UPDATE collab_runs SET status = $3, updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId, st]);
            const ex = await pool.query("SELECT 1 FROM collab_run_events WHERE tenant_id = $1 AND collab_run_id = $2 AND type = $3 AND run_id = $4 LIMIT 1", [
              tenantId,
              collabRunId,
              `collab.run.${st}`,
              String(data.runId ?? ""),
            ]);
            if (!ex.rowCount) {
              await pool.query(
                "INSERT INTO collab_run_events (tenant_id, space_id, collab_run_id, task_id, type, actor_role, run_id, step_id, payload_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                [tenantId, collabMeta?.spaceId ?? null, collabRunId, taskId, `collab.run.${st}`, null, String(data.runId ?? ""), null, null],
              );
            }
          }
        }
      } catch {
      }
      });
    },
    { connection, concurrency: 5 },
  );

  worker.on("failed", async (job, err) => {
    console.error("job failed", job?.id, err);
    try {
      if (!job) return;
      if (job.name !== "step") return;
      const data = job.data as any;
      const stepId = data?.stepId ? String(data.stepId) : null;
      const runId = data?.runId ? String(data.runId) : null;
      const jobId = data?.jobId ? String(data.jobId) : null;
      if (!stepId || !runId || !jobId) return;

      const maxAttempts = Number(job.opts.attempts ?? 1);
      const attemptsMade = Number(job.attemptsMade ?? 0);
      if (attemptsMade < maxAttempts) return;
      await markWorkflowStepDeadletter({ pool, jobId, runId, stepId, queueJobId: String(job.id), err });
    } catch (e) {
      console.error("deadletter mark failed", e);
    }
  });

  setInterval(() => {
    tickSubscriptions({ pool }).catch((err) => console.error("subscription tick failed", err));
  }, 5_000);

  setInterval(() => {
    tickTriggers({ pool, queue }).catch((err) => console.error("trigger tick failed", err));
  }, 5_000);

  setInterval(() => {
    (async () => {
      const pendingRes = await pool.query(
        "SELECT count(*)::int AS c FROM knowledge_ingest_jobs WHERE status IN ('queued','running')",
      );
      const pending = Number(pendingRes.rows[0]?.c ?? 0);
      if (pending > 200) return;

      const res = await pool.query(
        `
          WITH candidates AS (
            SELECT e.tenant_id, e.space_id, e.provider, e.workspace_id, e.event_id, e.id AS source_event_pk
            FROM channel_ingress_events e
            WHERE e.created_at > now() - interval '7 days'
              AND e.status = 'received'
              AND e.provider IN ('imap','exchange','mock')
              AND e.space_id IS NOT NULL
            ORDER BY e.created_at DESC
            LIMIT 50
          )
          INSERT INTO knowledge_ingest_jobs (tenant_id, space_id, provider, workspace_id, event_id, source_event_pk, status)
          SELECT c.tenant_id, c.space_id, c.provider, c.workspace_id, c.event_id, c.source_event_pk, 'queued'
          FROM candidates c
          ON CONFLICT (tenant_id, provider, workspace_id, event_id)
          DO NOTHING
          RETURNING id
        `,
        [],
      );
      for (const r of res.rows as any[]) {
        const ingestJobId = String(r.id ?? "");
        if (!ingestJobId) continue;
        await queue.add("knowledge.ingest", { kind: "knowledge.ingest", ingestJobId }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
      }
    })().catch((err) => console.error("knowledge ingest tick failed", err));
  }, 10_000);

  setInterval(() => {
    tickWebhookDeliveries({ pool }).catch((err) => console.error("webhook delivery tick failed", err));
  }, 2_000);

  setInterval(() => {
    tickEmailDeliveries({ pool }).catch((err) => console.error("email delivery tick failed", err));
  }, 2_000);

  setInterval(() => {
    tickWorkflowStepPayloadPurge({ pool }).catch((err) => console.error("workflow step payload purge tick failed", err));
  }, 60_000);

  setInterval(() => {
    tickAuditSiemWebhookExport({ pool }).catch((err) => console.error("audit siem export tick failed", err));
  }, 2_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
