/**
 * Tool Category & Priority Management Routes
 * 
 * 提供工具分类、优先级、标签的管理接口
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission } from "../modules/auth/guard";
import { PERM } from "@mindpal/shared";
import { deriveToolVisibility } from "../modules/tools/toolRepo";

export const toolCategoryRoutes: FastifyPluginAsync = async (app) => {
  
  // ─── 获取工具分类列表 ────────────────────────────────────────
  app.get("/governance/tools/categories", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "tool.category.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_READ });

    const result = await app.db.query(
      `SELECT
         category,
         name,
         priority,
         tags,
         approval_required,
         risk_level
       FROM tool_definitions
       WHERE tenant_id = $1
       ORDER BY priority DESC, category ASC, name ASC`,
      [subject.tenantId]
    );
    const categoryMap = new Map<string, {
      category: string;
      tool_count: number;
      total_priority: number;
      tool_names: string[];
      visibilitySummary: Record<string, number>;
    }>();
    for (const row of result.rows as any[]) {
      const category = row.category ?? "uncategorized";
      if (!categoryMap.has(category)) {
        categoryMap.set(category, { category, tool_count: 0, total_priority: 0, tool_names: [], visibilitySummary: {} });
      }
      const entry = categoryMap.get(category)!;
      entry.tool_count += 1;
      entry.total_priority += Number(row.priority ?? 0);
      entry.tool_names.push(String(row.name));
      const visibility = deriveToolVisibility({
        name: String(row.name),
        tags: Array.isArray(row.tags) ? row.tags : [],
        approvalRequired: Boolean(row.approval_required),
        riskLevel: row.risk_level ?? "low",
      });
      entry.visibilitySummary[visibility] = (entry.visibilitySummary[visibility] ?? 0) + 1;
    }
    const categories = Array.from(categoryMap.values())
      .map((entry) => ({
        category: entry.category,
        tool_count: entry.tool_count,
        avg_priority: entry.tool_count > 0 ? entry.total_priority / entry.tool_count : 0,
        tool_names: entry.tool_names,
        visibilitySummary: entry.visibilitySummary,
      }))
      .sort((a, b) => (b.avg_priority - a.avg_priority) || a.category.localeCompare(b.category));

    req.ctx.audit!.outputDigest = { categoryCount: categories.length };
    return { categories };
  });

  // ─── 更新工具分类和优先级 ────────────────────────────────────
  app.patch("/governance/tools/:toolName/metadata", async (req) => {
    const params = z.object({ toolName: z.string().min(1) }).parse(req.params);
    const subject = req.ctx.subject!;
    
    setAuditContext(req, { resourceType: "governance", action: "tool.metadata.update" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_MANAGE });

    const body = z.object({
      category: z.string().min(1).max(50).optional(),
      priority: z.number().int().min(1).max(10).optional(),
      tags: z.array(z.string().max(30)).max(20).optional(),
      visibility: z.enum(["public", "privileged", "internal"]).optional(),
    }).parse(req.body);

    // 构建动态更新语句
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (body.category !== undefined) {
      updates.push(`category = $${paramIndex}`);
      values.push(body.category);
      paramIndex++;
    }
    if (body.priority !== undefined) {
      updates.push(`priority = $${paramIndex}`);
      values.push(body.priority);
      paramIndex++;
    }
    const normalizedTags = body.tags ? [...body.tags] : undefined;
    if (body.visibility && body.tags === undefined) {
      const visibilityTagSet = new Set<string>();
      if (body.visibility === "privileged") visibilityTagSet.add("planner:hidden");
      if (body.visibility === "internal") visibilityTagSet.add("internal-only");
      updates.push(`tags = ARRAY(
        SELECT DISTINCT tag
        FROM unnest(COALESCE(tags, ARRAY[]::text[])) AS tag
        WHERE tag NOT IN ('planner:hidden', 'internal-only')
        UNION
        SELECT DISTINCT tag
        FROM unnest($${paramIndex}::text[]) AS tag
      )`);
      values.push(Array.from(visibilityTagSet));
      paramIndex++;
    } else if (normalizedTags !== undefined) {
      const visibilityTags = new Set(normalizedTags);
      visibilityTags.delete("planner:hidden");
      visibilityTags.delete("internal-only");
      if (body.visibility === "privileged") visibilityTags.add("planner:hidden");
      if (body.visibility === "internal") visibilityTags.add("internal-only");
      updates.push(`tags = $${paramIndex}`);
      values.push(Array.from(visibilityTags));
      paramIndex++;
    }

    if (updates.length === 0) {
      throw Errors.badRequest("至少需要提供一个更新字段");
    }

    updates.push(`updated_at = now()`);
    values.push(subject.tenantId);
    paramIndex++;
    values.push(params.toolName);

    const result = await app.db.query(
      `UPDATE tool_definitions 
       SET ${updates.join(", ")}
       WHERE tenant_id = $${paramIndex} AND name = $${paramIndex + 1}
       RETURNING name, category, priority, tags, approval_required, risk_level`,
      values
    );

    if (result.rows.length === 0) {
      throw Errors.notFound(`工具 ${params.toolName} 不存在`);
    }

    const visibility = deriveToolVisibility({
      name: result.rows[0].name,
      tags: result.rows[0].tags ?? [],
      approvalRequired: Boolean(result.rows[0].approval_required),
      riskLevel: result.rows[0].risk_level ?? "low",
    });

    req.ctx.audit!.outputDigest = { 
      toolName: params.toolName, 
      category: body.category, 
      priority: body.priority,
      visibility,
    };

    return { tool: { ...result.rows[0], visibility } };
  });

  // ─── 批量更新工具优先级 ──────────────────────────────────────
  app.post("/governance/tools/priorities/batch", async (req) => {
    const subject = req.ctx.subject!;
    
    setAuditContext(req, { resourceType: "governance", action: "tool.priority.batch_update" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_MANAGE });

    const body = z.object({
      updates: z.array(z.object({
        name: z.string().min(1),
        priority: z.number().int().min(1).max(10),
      })).max(100),
    }).parse(req.body);

    // 使用事务批量更新
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");

      const results = [];
      for (const update of body.updates) {
        const result = await client.query(
          `UPDATE tool_definitions 
           SET priority = $1, updated_at = now()
           WHERE tenant_id = $2 AND name = $3
           RETURNING name, priority`,
          [update.priority, subject.tenantId, update.name]
        );
        if (result.rows.length > 0) {
          results.push(result.rows[0]);
        }
      }

      await client.query("COMMIT");

      req.ctx.audit!.outputDigest = { updatedCount: results.length };
      return { updated: results };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  // ─── 获取工具使用统计 ────────────────────────────────────────
  app.get("/governance/tools/usage-stats", async (req) => {
    const subject = req.ctx.subject!;
    
    setAuditContext(req, { resourceType: "governance", action: "tool.usage.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_READ });

    const limit = z.coerce.number().int().min(1).max(100).default(50).parse((req.query as any)?.limit);

    // 从审计日志统计工具调用情况
    const result = await app.db.query(
      `SELECT 
         td.name,
         td.category,
         td.priority,
         td.tags,
         td.approval_required,
         td.risk_level,
         COUNT(ae.id) as call_count,
         MAX(ae.created_at) as last_called_at,
         AVG(
           CASE WHEN ae.output_digest IS NOT NULL 
           THEN (ae.output_digest->>'latencyMs')::float 
           ELSE NULL END
         ) as avg_latency_ms
       FROM tool_definitions td
       LEFT JOIN audit_events ae 
         ON ae.resource_type = 'tool' 
         AND ae.tool_ref LIKE td.name || '%'
         AND ae.tenant_id = td.tenant_id
       WHERE td.tenant_id = $1
       GROUP BY td.name, td.category, td.priority, td.tags, td.approval_required, td.risk_level
       ORDER BY call_count DESC, td.priority DESC
       LIMIT $2`,
      [subject.tenantId, limit]
    );

    const stats = result.rows.map((row: any) => ({
      ...row,
      visibility: deriveToolVisibility({
        name: row.name,
        tags: row.tags ?? [],
        approvalRequired: Boolean(row.approval_required),
        riskLevel: row.risk_level ?? "low",
      }),
    }));

    req.ctx.audit!.outputDigest = { toolCount: stats.length };
    return { stats };
  });

  // ─── 获取分类工具列表（支持分页） ────────────────────────────
  app.get("/governance/tools/by-category/:category", async (req) => {
    const params = z.object({ 
      category: z.string().min(1).max(50) 
    }).parse(req.params);
    
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      visibility: z.enum(["public", "privileged", "internal"]).optional(),
    }).parse(req.query);

    const subject = req.ctx.subject!;
    
    setAuditContext(req, { resourceType: "governance", action: "tool.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_TOOL_READ });

    const result = await app.db.query(
      `SELECT 
         name,
         display_name,
         description,
         category,
         priority,
         tags,
         approval_required,
         risk_level,
         source_layer,
         usage_count,
         last_used_at
       FROM tool_definitions
       WHERE tenant_id = $1 AND category = $2
       ORDER BY priority DESC, name ASC`,
      [subject.tenantId, params.category]
    );

    const matchedTools = result.rows.map((row: any) => ({
      ...row,
      visibility: deriveToolVisibility({
        name: row.name,
        tags: row.tags ?? [],
        approvalRequired: Boolean(row.approval_required),
        riskLevel: row.risk_level ?? "low",
      }),
    })).filter((row: any) => !query.visibility || row.visibility === query.visibility);
    const tools = matchedTools.slice(query.offset, query.offset + query.limit);

    // 获取总数
    const countResult = await app.db.query(
      `SELECT COUNT(*) FROM tool_definitions 
       WHERE tenant_id = $1 AND category = $2`,
      [subject.tenantId, params.category]
    );

    req.ctx.audit!.outputDigest = { 
      category: params.category, 
      count: tools.length 
    };

    return { 
      category: params.category,
      tools,
      total: query.visibility ? matchedTools.length : parseInt(countResult.rows[0].count),
      limit: query.limit,
      offset: query.offset,
    };
  });
};
