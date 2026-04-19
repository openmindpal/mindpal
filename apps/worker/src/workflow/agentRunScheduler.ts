import type { Queue } from "bullmq";
import type Redis from "ioredis";
import type { Pool } from "pg";
import crypto from "node:crypto";
import { isToolAllowedForPolicy, tryTransitionRun, type RunStatus, StructuredLogger, resolveNumber } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "worker:agentRunScheduler" });

import { appendCollabEventOnce } from "../lib/collabEvents";
import { applyWorkerCollabState } from "./collabStateSync";

type SyncWorkerCollabStateSafe = (params: Parameters<typeof applyWorkerCollabState>[0]) => Promise<void>;

type StopRunParams = {
  jobId: string;
  runId: string;
  phase: string;
  tenantId?: string;
  collab?: {
    tenantId: string;
    spaceIdHint: string;
    collabRunId: string;
    taskId: string;
    reason: string;
    eventType?: string;
  };
};

type SchedulerDeps = {
  pool: Pool;
  queue: Queue;
  redis: Redis;
  syncWorkerCollabStateSafe: SyncWorkerCollabStateSafe;
};

export function createAgentRunScheduler(deps: SchedulerDeps) {
  const { pool, queue, redis, syncWorkerCollabStateSafe } = deps;

  async function stopRunWithBudget(p: StopRunParams) {
    const runRes = await pool.query<{ status: string; tenant_id: string }>(
      "SELECT status, tenant_id FROM runs WHERE run_id = $1 LIMIT 1",
      [p.runId],
    );
    if (!runRes.rowCount) return;
    const currentStatus = runRes.rows[0].status as RunStatus;
    const tid = p.tenantId || String(runRes.rows[0].tenant_id ?? "");
    const transition = tryTransitionRun(currentStatus, "stopped");
    if (!transition.ok) {
      _logger.warn("state transition rejected", { currentStatus, target: "stopped", runId: p.runId });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE runs SET status = 'stopped', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND tenant_id = $2",
        [p.runId, tid],
      );
      await client.query("UPDATE jobs SET status = 'stopped', updated_at = now() WHERE job_id = $1 AND tenant_id = $2", [p.jobId, tid]);
      await client.query(
        "UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status = 'pending'",
        [p.runId],
      );
      const spaceRes = await client.query(
        "SELECT (input->>'spaceId') AS space_id, r.tenant_id FROM steps s JOIN runs r ON r.run_id = s.run_id WHERE s.run_id = $1 AND s.seq = 1 LIMIT 1",
        [p.runId],
      );
      if (spaceRes.rowCount) {
        const spaceId = String(spaceRes.rows[0].space_id ?? "");
        const tenantId2 = String(spaceRes.rows[0].tenant_id ?? "");
        if (tenantId2 && spaceId) {
          await client.query(
            "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
            [tenantId2, spaceId, p.runId, p.phase],
          );
        }
      }
      if (p.collab) {
        await client.query(
          "UPDATE collab_runs SET status = 'stopped', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2",
          [p.collab.tenantId, p.collab.collabRunId],
        );
      }
      await client.query("COMMIT");
    } catch (txErr: any) {
      await client.query("ROLLBACK").catch(() => {});
      _logger.error("stopRunWithBudget tx rollback", { runId: p.runId, jobId: p.jobId, phase: p.phase, error: txErr?.message ?? String(txErr) });
      throw txErr;
    } finally {
      client.release();
    }

    if (p.collab) {
      await syncWorkerCollabStateSafe({
        pool,
        tenantId: p.collab.tenantId,
        collabRunId: p.collab.collabRunId,
        phase: "stopped",
        setCurrentRole: true,
        currentRole: null,
        updateType: "phase_change",
        sourceRole: "system",
        payload: { reason: p.collab.reason, runId: p.runId, budgetStop: true },
      });
      await appendCollabEventOnce({
        pool,
        redis,
        tenantId: p.collab.tenantId,
        spaceId: p.collab.spaceIdHint || null,
        collabRunId: p.collab.collabRunId,
        taskId: p.collab.taskId,
        type: p.collab.eventType ?? "collab.budget.exceeded",
        actorRole: null,
        runId: p.runId,
        stepId: null,
        payloadDigest: { reason: p.collab.reason },
      });
    }
  }

  async function scheduleNextAgentRunStep(params: { jobId: string; runId: string }) {
    const runRes = await pool.query(
      "SELECT tenant_id, status, input_digest, started_at, created_at FROM runs WHERE run_id = $1 LIMIT 1",
      [params.runId],
    );
    if (!runRes.rowCount) return;
    const tenantId = String(runRes.rows[0].tenant_id ?? "");
    const status = String(runRes.rows[0].status ?? "");
    if (["succeeded", "failed", "canceled", "stopped"].includes(status)) return;
    if (status === "needs_approval" || status === "needs_arbiter" || status === "needs_device") return;

    const inputDigest = (runRes.rows[0].input_digest as any) ?? null;
    const limits = (inputDigest?.limits as any) ?? null;
    const maxSteps = limits?.maxSteps ? Number(limits.maxSteps) : null;
    const maxWallTimeMs = limits?.maxWallTimeMs ? Number(limits.maxWallTimeMs) : null;
    const maxTokens = limits?.maxTokens ? Number(limits.maxTokens) : null;
    const maxCostUsd = limits?.maxCostUsd ? Number(limits.maxCostUsd) : null;
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
        FOR UPDATE SKIP LOCKED
      `,
      [params.runId],
    );
    if (!candidatesRes.rowCount) return;

    const spaceIdHint = (candidatesRes.rows[0]?.input as any)?.spaceId ? String((candidatesRes.rows[0].input as any).spaceId) : "";

    if (maxSteps && candidatesRes.rows[0] && Number(candidatesRes.rows[0].seq ?? 0) > maxSteps) {
      await stopRunWithBudget({
        jobId: params.jobId,
        runId: params.runId,
        phase: "stopped.limit_exceeded",
        collab: isCollab && tenantId ? { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: "maxSteps" } : undefined,
      });
      return;
    }

    if (maxWallTimeMs) {
      const startedAt = (runRes.rows[0].started_at as string | null) ?? (runRes.rows[0].created_at as string | null) ?? null;
      if (startedAt && Date.now() - new Date(startedAt).getTime() > maxWallTimeMs) {
        await stopRunWithBudget({
          jobId: params.jobId,
          runId: params.runId,
          phase: "stopped.timeout",
          collab: isCollab && tenantId ? { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: "timeout" } : undefined,
        });
        return;
      }
    }

    if ((maxTokens || maxCostUsd) && isCollab && tenantId) {
      const prefix = `collab:${collabRunId}:%`;
      const usedRes = await pool.query(
        `
          SELECT COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::bigint AS total
          FROM model_usage_events
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR space_id = $2)
            AND purpose LIKE $3
            AND created_at >= (now() - interval '14 days')
        `,
        [tenantId, spaceIdHint || null, prefix],
      );
      const usedTokens = Number(usedRes.rowCount ? usedRes.rows[0].total : 0) || 0;

      if (maxTokens && usedTokens >= maxTokens) {
        await stopRunWithBudget({
          jobId: params.jobId,
          runId: params.runId,
          phase: "stopped.limit_exceeded",
          collab: { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: "maxTokens" },
        });
        return;
      }

      if (maxCostUsd) {
        const usdPer1kTokens = resolveNumber("MODEL_USD_PER_1K_TOKENS").value;
        if (Number.isFinite(usdPer1kTokens) && usdPer1kTokens > 0) {
          const usedCostUsd = (usedTokens / 1000) * usdPer1kTokens;
          if (usedCostUsd >= maxCostUsd) {
            await stopRunWithBudget({
              jobId: params.jobId,
              runId: params.runId,
              phase: "stopped.limit_exceeded",
              collab: { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: "maxCostUsd" },
            });
            return;
          }
        }
      }
    }

    const completedPlanStepIds = new Set<string>();
    if (isCollab) {
      const doneRes = await pool.query(
        "SELECT (input->>'planStepId') AS plan_step_id FROM steps WHERE run_id = $1 AND status = 'succeeded'",
        [params.runId],
      );
      for (const r of doneRes.rows) {
        const v = r.plan_step_id ? String(r.plan_step_id) : "";
        if (v) completedPlanStepIds.add(v);
      }
    }

    let roleAllowed: Record<string, Set<string> | null> = {};
    let roleBudget: Record<string, { maxSteps?: number }> = {};
    if (isCollab && tenantId && spaceIdHint) {
      const ts = await pool.query(
        "SELECT plan FROM memory_task_states WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL LIMIT 1",
        [tenantId, spaceIdHint, params.runId],
      );
      const plan = ts.rowCount ? ((ts.rows[0] as any).plan as any) : null;
      const roles = Array.isArray(plan?.roles) ? plan.roles : [];
      for (const r of roles) {
        const rn = typeof r?.roleName === "string" ? String(r.roleName) : "";
        const allowed = Array.isArray(r?.toolPolicy?.allowedTools) ? r.toolPolicy.allowedTools.map((x: any) => String(x)) : null;
        if (rn) roleAllowed[rn] = allowed ? new Set<string>(allowed) : null;
        const rbMaxSteps = r?.budget?.maxSteps ? Number(r.budget.maxSteps) : null;
        if (rn && rbMaxSteps && Number.isFinite(rbMaxSteps) && rbMaxSteps > 0) {
          roleBudget[rn] = { maxSteps: Math.max(1, Math.min(100, Math.floor(rbMaxSteps))) };
        }
      }
    }

    let usedStepsByRole: Record<string, number> | null = null;
    const roleBudgetRoles = Object.keys(roleBudget);
    if (isCollab && roleBudgetRoles.length) {
      usedStepsByRole = {};
      const usedRes = await pool.query(
        `
          SELECT (input->>'actorRole') AS role_name, COUNT(*)::int AS cnt
          FROM steps
          WHERE run_id = $1 AND status = 'succeeded'
          GROUP BY (input->>'actorRole')
        `,
        [params.runId],
      );
      for (const r of usedRes.rows) {
        const rn = r.role_name ? String(r.role_name) : "";
        if (!rn) continue;
        usedStepsByRole[rn] = Number(r.cnt ?? 0) || 0;
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
        if (allowedSet && toolRef && !isToolAllowedForPolicy(allowedSet, toolRef)) {
          await stopRunWithBudget({
            jobId: params.jobId,
            runId: params.runId,
            phase: "stopped.policy_denied",
            tenantId,
            collab: tenantId
              ? { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: "tool_not_allowed", eventType: "collab.policy.denied" }
              : undefined,
          });
          return;
        }

        const rb = actorRole ? roleBudget[actorRole] ?? null : null;
        if (rb?.maxSteps && usedStepsByRole) {
          const used = Number(usedStepsByRole[actorRole] ?? 0) || 0;
          if (used + 1 > rb.maxSteps) {
            await stopRunWithBudget({
              jobId: params.jobId,
              runId: params.runId,
              phase: "stopped.limit_exceeded",
              collab: tenantId ? { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: `role.maxSteps:${actorRole}` } : undefined,
            });
            return;
          }
        }
      }
      ready.push({
        stepId,
        seq,
        toolRef,
        metaInput,
        policySnapshotRef: row.policy_snapshot_ref ?? null,
        inputDigest: row.input_digest ?? null,
      });
    }
    if (!ready.length) return;

    const first = ready[0]!;
    const firstActorRole = first.metaInput?.actorRole ? String(first.metaInput.actorRole) : null;
    const firstPlanStepId = first.metaInput?.planStepId ? String(first.metaInput.planStepId) : null;
    const tc = first.metaInput?.toolContract ?? null;
    const approvalRequired = Boolean(tc?.approvalRequired) || tc?.riskLevel === "high";
    if (approvalRequired) {
      const spaceId = first.metaInput?.spaceId ? String(first.metaInput.spaceId) : null;
      const subjectId = first.metaInput?.subjectId ? String(first.metaInput.subjectId) : null;
      const apClient = await pool.connect();
      try {
        await apClient.query("BEGIN");
        await apClient.query(
          `
            INSERT INTO approvals (tenant_id, space_id, run_id, step_id, status, requested_by_subject_id, tool_ref, policy_snapshot_ref, input_digest)
            VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8)
            ON CONFLICT (tenant_id, run_id) DO UPDATE SET status = 'pending', step_id = EXCLUDED.step_id, tool_ref = EXCLUDED.tool_ref, policy_snapshot_ref = EXCLUDED.policy_snapshot_ref, input_digest = EXCLUDED.input_digest, updated_at = now()
          `,
          [tenantId, spaceId, params.runId, first.stepId, subjectId ?? "unknown", first.toolRef, first.policySnapshotRef, first.inputDigest],
        );
        await apClient.query("UPDATE steps SET status = 'needs_approval', updated_at = now() WHERE step_id = $1", [first.stepId]);
        await apClient.query("UPDATE runs SET status = 'needs_approval', updated_at = now() WHERE run_id = $1", [params.runId]);
        await apClient.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE job_id = $1", [params.jobId]);
        if (tenantId && spaceId) {
          await apClient.query(
            "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
            [tenantId, spaceId, params.runId, "needs_approval"],
          );
        }
        if (isCollab && tenantId) {
          await apClient.query(
            "UPDATE collab_runs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2",
            [tenantId, collabRunId],
          );
        }
        await apClient.query("COMMIT");
      } catch (txErr: any) {
        await apClient.query("ROLLBACK").catch(() => {});
        _logger.error("approval tx rollback", { runId: params.runId, jobId: params.jobId, stepId: first.stepId, error: txErr?.message ?? String(txErr) });
        throw txErr;
      } finally {
        apClient.release();
      }
      if (isCollab && tenantId) {
        await syncWorkerCollabStateSafe({
          pool,
          tenantId,
          collabRunId,
          phase: "needs_approval",
          setCurrentRole: true,
          currentRole: firstActorRole,
          roleName: firstActorRole,
          roleStatus: "blocked",
          currentStepId: first.stepId,
          progress: 0,
          updateType: "phase_change",
          sourceRole: firstActorRole ?? "system",
          payload: {
            reason: "scheduler_selected_approval_required_step",
            stepId: first.stepId,
            planStepId: firstPlanStepId,
            toolRef: first.toolRef,
          },
        });
        await appendCollabEventOnce({
          pool,
          redis,
          tenantId,
          spaceId: spaceIdHint || null,
          collabRunId,
          taskId,
          type: "collab.run.needs_approval",
          actorRole: first.metaInput?.actorRole ? String(first.metaInput.actorRole) : null,
          runId: params.runId,
          stepId: first.stepId,
          payloadDigest: { toolRef: first.toolRef },
        });
      }
      return;
    }

    const maxParallel = isCollab ? 3 : 1;
    const enqueueSlice = ready.slice(0, maxParallel);
    const claimTokenByStepId = new Map<string, string>();
    const eqClient = await pool.connect();
    try {
      await eqClient.query("BEGIN");
      const revalidateRes = await eqClient.query(
        `SELECT step_id FROM steps
         WHERE step_id = ANY($1::uuid[]) AND status = 'pending' AND (queue_job_id IS NULL OR queue_job_id = '')
         FOR UPDATE SKIP LOCKED`,
        [enqueueSlice.map((n) => n.stepId)],
      );
      const lockedIds = new Set((revalidateRes.rows as any[]).map((r) => String(r.step_id)));
      for (const n of enqueueSlice) {
        if (!lockedIds.has(n.stepId)) continue;
        const claimToken = `sched:${crypto.randomUUID()}`;
        claimTokenByStepId.set(n.stepId, claimToken);
        await eqClient.query(
          "UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2 AND (queue_job_id IS NULL OR queue_job_id = '')",
          [claimToken, n.stepId],
        );
      }
      await eqClient.query("COMMIT");
    } catch (txErr: any) {
      await eqClient.query("ROLLBACK").catch(() => {});
      _logger.error("enqueue tx rollback", { runId: params.runId, jobId: params.jobId, stepCount: enqueueSlice.length, error: txErr?.message ?? String(txErr) });
      throw txErr;
    } finally {
      eqClient.release();
    }

    const queuedStepIds: string[] = [];
    for (const n of enqueueSlice) {
      const claimToken = claimTokenByStepId.get(n.stepId);
      if (!claimToken) continue;
      try {
        const bj = await queue.add(
          "step",
          { jobId: params.jobId, runId: params.runId, stepId: n.stepId },
          { attempts: 3, backoff: { type: "exponential", delay: 500 } },
        );
        await pool.query(
          "UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2 AND queue_job_id = $3",
          [String((bj as any).id), n.stepId, claimToken],
        );
        queuedStepIds.push(n.stepId);
      } catch (enqueueErr: any) {
        await pool.query(
          "UPDATE steps SET queue_job_id = NULL, updated_at = now() WHERE step_id = $1 AND queue_job_id = $2",
          [n.stepId, claimToken],
        ).catch(() => undefined);
        _logger.error("enqueue failed after claim commit", { runId: params.runId, jobId: params.jobId, stepId: n.stepId, error: enqueueErr?.message ?? String(enqueueErr) });
        throw enqueueErr;
      }
    }

    if (isCollab && tenantId) {
      const queuedPlanStepIds = enqueueSlice
        .filter((n) => queuedStepIds.includes(n.stepId))
        .map((n) => (n.metaInput?.planStepId ? String(n.metaInput.planStepId) : ""))
        .filter(Boolean);
      await syncWorkerCollabStateSafe({
        pool,
        tenantId,
        collabRunId,
        phase: "executing",
        setCurrentRole: true,
        currentRole: firstActorRole,
        roleName: firstActorRole,
        roleStatus: "active",
        currentStepId: first.stepId,
        progress: 0,
        metadata: { queuedStepIds, queuedPlanStepIds },
        updateType: "phase_change",
        sourceRole: "system",
        payload: {
          reason: "scheduler_enqueued_ready_steps",
          queuedStepIds,
          queuedPlanStepIds,
          activeRole: firstActorRole,
        },
      });
      for (const n of enqueueSlice.slice(1).filter((step) => queuedStepIds.includes(step.stepId))) {
        const roleName = n.metaInput?.actorRole ? String(n.metaInput.actorRole) : "";
        if (!roleName) continue;
        await syncWorkerCollabStateSafe({
          pool,
          tenantId,
          collabRunId,
          roleName,
          roleStatus: "waiting",
          currentStepId: n.stepId,
          progress: 0,
          metadata: {
            queuedByScheduler: true,
            queuedStepIds,
          },
          updateType: "role_status",
          sourceRole: "system",
          payload: {
            reason: "scheduler_enqueued_parallel_ready_step",
            roleName,
            stepId: n.stepId,
            planStepId: n.metaInput?.planStepId ?? null,
          },
        });
      }
    }
  }

  return { scheduleNextAgentRunStep };
}
