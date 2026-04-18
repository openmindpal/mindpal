/**
 * system.tool.* — 工具治理执行器
 *
 * 三个内核工具，用于通过对话管理工具白名单：
 *   system.tool.list    — 列出所有工具及其 rollout 状态
 *   system.tool.enable  — 启用指定工具（加入白名单）
 *   system.tool.disable — 禁用指定工具（移出白名单）
 *
 * 直接调用 toolGovernanceRepo 和 toolRepo 中的已有仓库函数。
 */
import type { Pool } from "pg";

// ── 仓库函数：直接写 SQL，避免跨 workspace 导入问题 ──

async function listToolDefinitions(pool: Pool, tenantId: string) {
  const res = await pool.query(
    `SELECT name, display_name, description, scope, resource_type, action, risk_level, approval_required, source_layer, created_at, updated_at
     FROM tool_definitions WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  );
  return res.rows.map((r: any) => ({
    name: r.name,
    displayName: r.display_name,
    description: r.description,
    scope: r.scope,
    resourceType: r.resource_type,
    action: r.action,
    riskLevel: r.risk_level,
    approvalRequired: r.approval_required,
    sourceLayer: r.source_layer,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

async function listToolRollouts(pool: Pool, tenantId: string, scopeType?: string, scopeId?: string) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [tenantId];
  let idx = 2;
  if (scopeType) {
    where.push(`scope_type = $${idx++}`);
    args.push(scopeType);
  }
  if (scopeId) {
    where.push(`scope_id = $${idx++}`);
    args.push(scopeId);
  }
  const res = await pool.query(
    `SELECT scope_type, scope_id, tool_ref, enabled, created_at, updated_at
     FROM tool_rollouts WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT 500`,
    args,
  );
  return res.rows.map((r: any) => ({
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    toolRef: r.tool_ref,
    enabled: r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

async function enableToolRollout(pool: Pool, tenantId: string, scopeType: "tenant" | "space", scopeId: string, toolRef: string) {
  const prev = await pool.query(
    `SELECT enabled FROM tool_rollouts WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND tool_ref = $4 LIMIT 1`,
    [tenantId, scopeType, scopeId, toolRef],
  );
  const previousEnabled = prev.rowCount ? Boolean(prev.rows[0].enabled) : null;

  await pool.query(
    `INSERT INTO tool_rollouts (tenant_id, scope_type, scope_id, tool_ref, enabled)
     VALUES ($1,$2,$3,$4,true)
     ON CONFLICT (tenant_id, scope_type, scope_id, tool_ref)
     DO UPDATE SET enabled = true, updated_at = now()`,
    [tenantId, scopeType, scopeId, toolRef],
  );

  return { enabled: true, toolRef, scopeType, scopeId, previousEnabled };
}

async function disableToolRollout(
  pool: Pool,
  tenantId: string,
  scopeType: "tenant" | "space",
  scopeId: string,
  toolRef: string,
  disableMode: "immediate" | "graceful" = "immediate",
  graceMinutes: number = 5,
) {
  const prev = await pool.query(
    `SELECT enabled FROM tool_rollouts WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND tool_ref = $4 LIMIT 1`,
    [tenantId, scopeType, scopeId, toolRef],
  );
  const previousEnabled = prev.rowCount ? Boolean(prev.rows[0].enabled) : null;

  const graceDeadline = disableMode === "graceful" ? new Date(Date.now() + graceMinutes * 60_000) : null;

  await pool.query(
    `INSERT INTO tool_rollouts (tenant_id, scope_type, scope_id, tool_ref, enabled, disable_mode, grace_deadline)
     VALUES ($1,$2,$3,$4,false,$5,$6)
     ON CONFLICT (tenant_id, scope_type, scope_id, tool_ref)
     DO UPDATE SET enabled = false, disable_mode = EXCLUDED.disable_mode, grace_deadline = EXCLUDED.grace_deadline, updated_at = now()`,
    [tenantId, scopeType, scopeId, toolRef, disableMode, graceDeadline],
  );

  return { enabled: false, toolRef, scopeType, scopeId, previousEnabled, disableMode, graceDeadline: graceDeadline?.toISOString() ?? null };
}

// ── 工具执行器 ──

export async function executeSystemToolList(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  toolInput: any;
}) {
  const scopeType = params.toolInput?.scopeType as string | undefined;
  const validScope = scopeType === "tenant" || scopeType === "space" ? scopeType : undefined;
  const scopeId = validScope === "space" ? (params.spaceId ?? params.tenantId) : validScope === "tenant" ? params.tenantId : undefined;

  const [tools, rollouts] = await Promise.all([
    listToolDefinitions(params.pool, params.tenantId),
    listToolRollouts(params.pool, params.tenantId, validScope, scopeId),
  ]);

  // 构建 rollout 映射，方便前端/LLM 理解每个工具的启用状态
  const rolloutMap = new Map<string, boolean>();
  for (const r of rollouts) {
    rolloutMap.set(r.toolRef, r.enabled);
  }

  const enrichedTools = tools.map((t: any) => {
    // 尝试匹配 toolRef 格式（name@version）
    const matchingRollouts = rollouts.filter((r: any) => r.toolRef.startsWith(t.name + "@"));
    const enabled = matchingRollouts.length > 0 ? matchingRollouts.some((r: any) => r.enabled) : null;
    return { ...t, enabled };
  });

  return { tools: enrichedTools, rollouts, totalTools: tools.length, totalRollouts: rollouts.length };
}

export async function executeSystemToolEnable(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  toolInput: any;
}) {
  const toolRef = String(params.toolInput?.toolRef ?? "").trim();
  if (!toolRef) throw new Error("missing_tool_ref: 请提供要启用的工具引用 (toolRef)，如 desktop.screen.capture@1");

  const scopeType: "tenant" | "space" = params.toolInput?.scopeType === "tenant" ? "tenant" : "space";
  const scopeId = scopeType === "space" ? (params.spaceId ?? params.tenantId) : params.tenantId;

  const result = await enableToolRollout(params.pool, params.tenantId, scopeType, scopeId, toolRef);
  console.log(`[system.tool.enable] ${toolRef} enabled for ${scopeType}:${scopeId} (was: ${result.previousEnabled})`);
  return result;
}

export async function executeSystemToolDisable(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  toolInput: any;
}) {
  const toolRef = String(params.toolInput?.toolRef ?? "").trim();
  if (!toolRef) throw new Error("missing_tool_ref: 请提供要禁用的工具引用 (toolRef)，如 desktop.screen.capture@1");

  const scopeType: "tenant" | "space" = params.toolInput?.scopeType === "tenant" ? "tenant" : "space";
  const scopeId = scopeType === "space" ? (params.spaceId ?? params.tenantId) : params.tenantId;
  const toolName = toolRef.split("@")[0] ?? toolRef;
  const disableMode: "immediate" | "graceful" = params.toolInput?.mode === "graceful" ? "graceful" : "immediate";
  const graceMinutes = Number(params.toolInput?.graceMinutes) || 5;

  // ── 影响分析：检查活跃任务 ──
  let impactWarning: string | null = null;
  try {
    const runRes = await params.pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT r.run_id) as count
       FROM runs r
       JOIN steps s ON r.run_id = s.run_id
       WHERE r.tenant_id = $1
         AND r.status IN ('created', 'running', 'queued')
         AND s.tool_ref LIKE $2`,
      [params.tenantId, `${toolName}%`]
    );
    const activeRunCount = parseInt(runRes.rows[0]?.count ?? "0", 10);
    if (activeRunCount > 0) {
      impactWarning = `注意：当前有 ${activeRunCount} 个活跃任务正在使用工具 ${toolName}，停用后这些任务可能失败`;
      console.warn(`[system.tool.disable] 影响分析: ${impactWarning}`);
    }
  } catch (err: any) {
    console.warn(`[system.tool.disable] 影响分析查询失败: ${err?.message}`);
  }

  const result = await disableToolRollout(params.pool, params.tenantId, scopeType, scopeId, toolRef, disableMode, graceMinutes);
  console.log(`[system.tool.disable] ${toolRef} disabled (mode=${disableMode}) for ${scopeType}:${scopeId} (was: ${result.previousEnabled})`);
  return { ...result, impactWarning };
}
