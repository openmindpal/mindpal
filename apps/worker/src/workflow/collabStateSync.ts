import { collabStreamRedisChannel, createCollabStreamSignal } from "@mindpal/shared";
import type { Pool } from "pg";

export type WorkerCollabPhase =
  | "initializing"
  | "planning"
  | "executing"
  | "reviewing"
  | "needs_approval"
  | "needs_device"
  | "needs_arbiter"
  | "paused"
  | "replanning"
  | "succeeded"
  | "failed"
  | "stopped";

export type WorkerRoleStatus = "idle" | "active" | "waiting" | "blocked" | "completed" | "failed";

function uniqueStrings(values: string[] | null | undefined) {
  return Array.from(new Set((values ?? []).map((value) => String(value)).filter(Boolean)));
}

export async function applyWorkerCollabState(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
  tenantId: string;
  collabRunId: string;
  taskId?: string | null;
  phase?: WorkerCollabPhase;
  setCurrentRole?: boolean;
  currentRole?: string | null;
  roleName?: string | null;
  roleStatus?: WorkerRoleStatus;
  currentStepId?: string | null;
  progress?: number | null;
  metadata?: Record<string, unknown> | null;
  addCompletedStepIds?: string[];
  addFailedStepIds?: string[];
  removePendingStepIds?: string[];
  updateType: "role_status" | "step_progress" | "phase_change" | "error" | "replan";
  sourceRole?: string | null;
  payload?: Record<string, unknown>;
}) {
  const { pool, tenantId, collabRunId } = params;
  if (!tenantId || !collabRunId) return { ok: false, reason: "missing_collab_identity" as const };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{
      version: number;
      phase: string;
      active_role: string | null;
      role_states: Record<string, any>;
      completed_step_ids: string[];
      failed_step_ids: string[];
      pending_step_ids: string[];
    }>(
      `SELECT version, phase, active_role, role_states, completed_step_ids, failed_step_ids, pending_step_ids
       FROM collab_global_state
       WHERE tenant_id = $1 AND collab_run_id = $2
       FOR UPDATE`,
      [tenantId, collabRunId],
    );
    if (!res.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "state_not_found" as const };
    }

    const row = res.rows[0]!;
    const now = new Date().toISOString();
    const roleStates = row.role_states && typeof row.role_states === "object" ? { ...row.role_states } : {};
    const roleName = params.roleName ? String(params.roleName) : "";
    if (roleName) {
      const current = roleStates[roleName] && typeof roleStates[roleName] === "object"
        ? roleStates[roleName]
        : { roleName };
      const next: Record<string, unknown> = { ...current, roleName, lastUpdateAt: now };
      if (params.roleStatus !== undefined) next.status = params.roleStatus;
      if (params.currentStepId !== undefined) next.currentStepId = params.currentStepId;
      if (params.progress !== undefined) next.progress = params.progress;
      if (params.metadata !== undefined) next.metadata = params.metadata;
      roleStates[roleName] = next;
    }

    const addCompleted = uniqueStrings(params.addCompletedStepIds);
    const addFailed = uniqueStrings(params.addFailedStepIds);
    const removePending = new Set(uniqueStrings(params.removePendingStepIds));
    const completedStepIds = uniqueStrings([...(Array.isArray(row.completed_step_ids) ? row.completed_step_ids : []), ...addCompleted]);
    const failedStepIds = uniqueStrings([...(Array.isArray(row.failed_step_ids) ? row.failed_step_ids : []), ...addFailed]);
    const pendingStepIds = uniqueStrings(Array.isArray(row.pending_step_ids) ? row.pending_step_ids : []).filter((stepId) => !removePending.has(stepId));
    const nextPhase = params.phase ?? (String(row.phase ?? "executing") as WorkerCollabPhase);
    const nextCurrentRole = params.setCurrentRole ? (params.currentRole ?? null) : (row.active_role ? String(row.active_role) : null);
    const nextVersion = Number(row.version ?? 0) + 1;
    const sourceRole = (params.sourceRole ?? params.roleName ?? params.currentRole ?? "system") || "system";
    const payload = params.payload ?? {};

    await client.query(
      `UPDATE collab_global_state
       SET phase = $3,
           active_role = $4,
           role_states = $5::jsonb,
           completed_step_ids = $6::jsonb,
           failed_step_ids = $7::jsonb,
           pending_step_ids = $8::jsonb,
           last_updated_at = $9,
           version = $10
       WHERE tenant_id = $1 AND collab_run_id = $2`,
      [
        tenantId,
        collabRunId,
        nextPhase,
        nextCurrentRole,
        JSON.stringify(roleStates),
        JSON.stringify(completedStepIds),
        JSON.stringify(failedStepIds),
        JSON.stringify(pendingStepIds),
        now,
        nextVersion,
      ],
    );
    await client.query(
      `INSERT INTO collab_state_updates
       (tenant_id, collab_run_id, source_role, update_type, payload, version, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())`,
      [tenantId, collabRunId, sourceRole, params.updateType, JSON.stringify(payload), nextVersion],
    );
    await client.query("COMMIT");
    if (params.redis) {
      await params.redis.publish(
        collabStreamRedisChannel(collabRunId),
        JSON.stringify(createCollabStreamSignal({
          collabRunId,
          tenantId,
          taskId: params.taskId ?? null,
          kind: params.updateType === "error" ? "event" : "state",
          source: "worker",
        })),
      ).catch(() => {});
    }
    return { ok: true, version: nextVersion };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function mapRunStatusToCollabPhase(status: string | null | undefined): WorkerCollabPhase | null {
  switch (String(status ?? "").trim()) {
    case "planning":
      return "planning";
    case "queued":
    case "running":
    case "executing":
    case "compensating":
      return "executing";
    case "needs_approval":
      return "needs_approval";
    case "needs_device":
      return "needs_device";
    case "needs_arbiter":
      return "needs_arbiter";
    case "paused":
      return "paused";
    case "replanning":
      return "replanning";
    case "reviewing":
      return "reviewing";
    case "succeeded":
    case "compensated":
      return "succeeded";
    case "failed":
      return "failed";
    case "stopped":
    case "canceled":
      return "stopped";
    default:
      return null;
  }
}
