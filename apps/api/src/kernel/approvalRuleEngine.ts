/**
 * approvalRuleEngine.ts — 动态审批规则引擎
 *
 * OS 级设计：审批规则从数据库加载，运行时动态匹配，自带人话解释。
 * 替代 approvalManager.ts 和 changeSetCrud.ts 中的所有硬编码审批逻辑。
 *
 * 三类规则：
 * - tool_execution  ：工具执行时的风险评估（替代 assessOperationRisk 硬编码正则）
 * - changeset_gate  ：变更集提交时的门禁（替代 computeApprovalGate 硬编码 if/else）
 * - eval_admission  ：eval 准入门禁触发条件（替代 EVAL_ADMISSION_REQUIRED_KINDS 环境变量）
 */
import type { Pool } from "pg";

/* ================================================================== */
/*  Regex DoS Guard                                                     */
/* ================================================================== */

const MAX_PATTERN_LENGTH = 500;
const REGEX_TIMEOUT_MS = 100;

function safeRegex(pattern: string, flags?: string): RegExp | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return null;
  try {
    const re = new RegExp(pattern, flags ?? "i");
    // 简单预测试防止灾难性回溯
    const testStr = "a".repeat(50);
    const start = Date.now();
    re.test(testStr);
    if (Date.now() - start > REGEX_TIMEOUT_MS) return null;
    return re;
  } catch { return null; }
}

/* ================================================================== */
/*  Rule Cache                                                          */
/* ================================================================== */

const RULE_CACHE_TTL_MS = 60_000; // 60s, metadata-driven fallback
const ruleCache = new Map<string, { rules: ApprovalRule[]; ts: number }>();

export function invalidateRuleCache(tenantId?: string, ruleType?: string): void {
  if (tenantId && ruleType) {
    ruleCache.delete(`${tenantId}:${ruleType}`);
  } else {
    ruleCache.clear();
  }
}

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type ApprovalRuleType = "tool_execution" | "changeset_gate" | "eval_admission" | "debate_config";

export type RiskLevel = "low" | "medium" | "high";

/** DB 行映射 */
export interface ApprovalRule {
  ruleId: string;
  tenantId: string;
  ruleType: ApprovalRuleType;
  name: string;
  description: string;
  priority: number;
  enabled: boolean;
  matchCondition: MatchCondition;
  effect: RuleEffect;
  scopeType: string | null;
  scopeId: string | null;
  metadata: Record<string, unknown>;
}

/** 匹配条件（支持 AND/OR 递归组合，可表达任意复杂审批场景） */
export type MatchCondition =
  | { match: "tool_name_regex"; pattern: string; flags?: string }
  | { match: "input_content_regex"; pattern: string; flags?: string }
  | { match: "input_batch_size"; threshold: number }
  | { match: "input_field_gte"; field: string; threshold: number }
  | { match: "input_field_regex"; field: string; pattern: string; flags?: string }
  | { match: "item_kind_prefix"; pattern: string }
  | { match: "item_kind_exact"; pattern: string }
  | { match: "tool_scope"; scope: "read" | "write" }
  | { match: "time_range"; outsideHours?: [number, number]; daysOfWeek?: number[] }
  | { match: "always" }
  | { match: "and"; conditions: MatchCondition[] }
  | { match: "or"; conditions: MatchCondition[] };

/** 规则效果（可携带审批人路由和时效） */
export type RuleEffect =
  | {
      riskLevel?: RiskLevel;
      approvalRequired?: boolean;
      requiredApprovals?: number;
      /** 审批人角色列表（如 ["admin", "security_officer"]） */
      approverRoles?: string[];
      /** 审批时效（分钟），超时自动升级 */
      expiresInMinutes?: number;
    }
  | { evalRequired?: boolean };

/** 规则匹配结果（含自描述） */
export interface RuleMatchResult {
  matched: boolean;
  rule: ApprovalRule;
  /** 人话解释：为什么匹配了这条规则 */
  explanation: string;
}

/** 工具执行审批评估结果 */
export interface ToolExecutionAssessment {
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  riskFactors: string[];
  matchedRules: RuleMatchResult[];
  /** 面向终端用户的审批原因总结 */
  humanSummary: string;
  /** 需要几人审批 */
  requiredApprovals: number;
  /** 审批人角色列表 */
  approverRoles: string[];
  /** 审批时效（分钟） */
  expiresInMinutes: number | null;
}

/** 变更集门禁评估结果 */
export interface ChangesetGateAssessment {
  riskLevel: RiskLevel;
  requiredApprovals: number;
  evalAdmissionRequired: boolean;
  matchedRules: RuleMatchResult[];
  /** 面向终端用户的门禁原因总结 */
  humanSummary: string;
  /** 审批人角色列表 */
  approverRoles: string[];
  /** 审批时效（分钟） */
  expiresInMinutes: number | null;
}

/* ================================================================== */
/*  Rule Loading                                                        */
/* ================================================================== */

/** 从 DB 加载指定类型的审批规则（优先租户级 → 兜底 __default__） */
export async function loadApprovalRules(params: {
  pool: Pool;
  tenantId: string;
  ruleType: ApprovalRuleType;
}): Promise<ApprovalRule[]> {
  const { pool, tenantId, ruleType } = params;

  // ── 缓存命中检查
  const cacheKey = `${tenantId}:${ruleType}`;
  const cached = ruleCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < RULE_CACHE_TTL_MS) return cached.rules;

  const res = await pool.query(
    `SELECT * FROM approval_rules
     WHERE rule_type = $1 AND enabled = true
       AND (tenant_id = $2 OR tenant_id = '__default__')
     ORDER BY
       CASE WHEN tenant_id = $2 THEN 0 ELSE 1 END,
       priority ASC`,
    [ruleType, tenantId],
  );
  const rules = res.rows.map(toRule);
  ruleCache.set(cacheKey, { rules, ts: Date.now() });
  return rules;
}

function toRule(r: any): ApprovalRule {
  return {
    ruleId: r.rule_id,
    tenantId: r.tenant_id,
    ruleType: r.rule_type,
    name: r.name,
    description: r.description ?? "",
    priority: r.priority,
    enabled: r.enabled,
    matchCondition: r.match_condition,
    effect: r.effect,
    scopeType: r.scope_type ?? null,
    scopeId: r.scope_id ?? null,
    metadata: r.metadata ?? {},
  };
}

/* ================================================================== */
/*  Rule Matching                                                       */
/* ================================================================== */

/** 判断一条规则是否匹配工具执行上下文 */
function matchToolExecutionRule(
  rule: ApprovalRule,
  ctx: { toolName: string; inputStr: string; inputDraft: Record<string, unknown>; batchSize: number; toolScope?: string },
): RuleMatchResult {
  return evaluateCondition(rule, rule.matchCondition, ctx);
}

/** 递归评估匹配条件（支持 AND/OR 组合） */
function evaluateCondition(
  rule: ApprovalRule,
  mc: MatchCondition,
  ctx: { toolName: string; inputStr: string; inputDraft: Record<string, unknown>; batchSize: number; toolScope?: string; tenantTimezoneOffsetMin?: number },
): RuleMatchResult {
  // ── AND 组合：所有子条件均匹配
  if (mc.match === "and") {
    const subs = mc.conditions.map((c) => evaluateCondition(rule, c, ctx));
    const allMatched = subs.every((s) => s.matched);
    if (allMatched) {
      return { matched: true, rule, explanation: `组合条件全部满足「${rule.name}」：${subs.map((s) => s.explanation).join(" + ")}` };
    }
    return { matched: false, rule, explanation: "" };
  }

  // ── OR 组合：任一子条件匹配
  if (mc.match === "or") {
    for (const c of mc.conditions) {
      const sub = evaluateCondition(rule, c, ctx);
      if (sub.matched) return sub;
    }
    return { matched: false, rule, explanation: "" };
  }

  if (mc.match === "tool_name_regex") {
    const re = safeRegex(mc.pattern, mc.flags);
    if (!re) return { matched: false, rule, explanation: `Regex pattern rejected (too long or unsafe): ${rule.name}` };
    try {
      if (re.test(ctx.toolName)) {
        return { matched: true, rule, explanation: `工具名称「${ctx.toolName}」匹配了规则「${rule.name}」` };
      }
    } catch { /* runtime error, skip */ }
    return { matched: false, rule, explanation: "" };
  }

  if (mc.match === "input_content_regex") {
    const re = safeRegex(mc.pattern, mc.flags);
    if (!re) return { matched: false, rule, explanation: `Regex pattern rejected (too long or unsafe): ${rule.name}` };
    try {
      if (re.test(ctx.inputStr)) {
        return { matched: true, rule, explanation: `输入内容触发了规则「${rule.name}」：${rule.description}` };
      }
    } catch { /* runtime error, skip */ }
    return { matched: false, rule, explanation: "" };
  }

  if (mc.match === "input_batch_size") {
    if (ctx.batchSize > (mc.threshold ?? 10)) {
      return { matched: true, rule, explanation: `批量操作包含 ${ctx.batchSize} 条项目，超过阈值 ${mc.threshold}` };
    }
    return { matched: false, rule, explanation: "" };
  }

  if (mc.match === "input_field_gte") {
    const val = getNestedField(ctx.inputDraft, mc.field);
    if (typeof val === "number" && val >= mc.threshold) {
      return { matched: true, rule, explanation: `字段「${mc.field}」值为 ${val}，达到阈值 ${mc.threshold}，触发规则「${rule.name}」` };
    }
    return { matched: false, rule, explanation: "" };
  }

  if (mc.match === "input_field_regex") {
    const val = getNestedField(ctx.inputDraft, mc.field);
    if (typeof val === "string") {
      const re = safeRegex(mc.pattern, mc.flags);
      if (!re) return { matched: false, rule, explanation: `Regex pattern rejected (too long or unsafe): ${rule.name}` };
      try {
        if (re.test(val)) {
          return { matched: true, rule, explanation: `字段「${mc.field}」匹配规则「${rule.name}」` };
        }
      } catch { /* runtime error, skip */ }
    }
    return { matched: false, rule, explanation: "" };
  }

  if (mc.match === "tool_scope") {
    if (ctx.toolScope === mc.scope) {
      return { matched: true, rule, explanation: `工具操作类型为「${mc.scope}」，匹配规则「${rule.name}」` };
    }
    return { matched: false, rule, explanation: "" };
  }

  if (mc.match === "time_range") {
    // 从上下文获取租户时区偏移（分钟），fallback UTC
    const tzOffsetMin = ctx.tenantTimezoneOffsetMin ?? 0;
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
    const tenantNow = new Date(utcMs + tzOffsetMin * 60_000);
    const hour = tenantNow.getHours();
    const day = tenantNow.getDay(); // 0=Sun
    let triggered = false;
    let reason = "";
    if (mc.outsideHours) {
      const [start, end] = mc.outsideHours;
      if (hour < start || hour >= end) {
        triggered = true;
        reason = `当前时间 ${hour}:00 不在工作时段 ${start}:00-${end}:00 内`;
      }
    }
    if (mc.daysOfWeek && mc.daysOfWeek.includes(day)) {
      triggered = true;
      reason = reason ? reason + "，且为指定日期" : `当前星期 ${day} 在规则指定日期内`;
    }
    if (triggered) {
      return { matched: true, rule, explanation: `${reason}，触发规则「${rule.name}」` };
    }
    return { matched: false, rule, explanation: "" };
  }

  if (mc.match === "always") {
    return { matched: true, rule, explanation: `全局规则「${rule.name}」始终生效` };
  }

  return { matched: false, rule, explanation: "" };
}

/** 判断一条规则是否匹配变更集 item kind（复用 evaluateCondition 支持 AND/OR） */
function matchItemKindRule(
  rule: ApprovalRule,
  kind: string,
): RuleMatchResult {
  // 将 kind 放入虚拟上下文，复用通用评估器
  const virtualCtx = { toolName: kind, inputStr: "", inputDraft: {} as Record<string, unknown>, batchSize: 0 };
  const mc = rule.matchCondition;

  // 对 item_kind_* 类型做专门处理
  if (mc.match === "item_kind_prefix") {
    if (kind === mc.pattern || kind.startsWith(mc.pattern)) {
      return { matched: true, rule, explanation: `变更类型「${kind}」匹配了规则「${rule.name}」：${rule.description}` };
    }
    return { matched: false, rule, explanation: "" };
  }

  if (mc.match === "item_kind_exact") {
    if (kind === mc.pattern) {
      return { matched: true, rule, explanation: `变更类型「${kind}」精确匹配规则「${rule.name}」` };
    }
    return { matched: false, rule, explanation: "" };
  }

  // AND/OR/always 走通用评估器
  if (mc.match === "and" || mc.match === "or" || mc.match === "always") {
    return evaluateCondition(rule, mc, virtualCtx);
  }

  return { matched: false, rule, explanation: "" };
}

/* ================================================================== */
/*  Public API: Tool Execution Assessment                               */
/* ================================================================== */

/**
 * 评估工具执行的风险等级和审批要求（数据驱动版本）。
 *
 * 优先使用工具自身声明的 riskLevel/approvalRequired 作为基准，
 * 然后叠加 approval_rules 表中的动态规则。
 */
export async function assessToolExecutionRisk(params: {
  pool: Pool;
  tenantId: string;
  toolRef: string;
  inputDraft: Record<string, unknown>;
  toolDefinition?: {
    riskLevel?: RiskLevel;
    approvalRequired?: boolean;
    scope?: string;
  };
}): Promise<ToolExecutionAssessment> {
  const { pool, tenantId, toolRef, inputDraft, toolDefinition } = params;

  // 基准：工具自身声明
  let riskLevel: RiskLevel = toolDefinition?.riskLevel ?? "low";
  let approvalRequired = toolDefinition?.approvalRequired ?? false;
  let requiredApprovals = 1;
  const approverRoles: string[] = [];
  let expiresInMinutes: number | null = null;
  const riskFactors: string[] = [];
  const matchedRules: RuleMatchResult[] = [];

  // 加载规则
  const rules = await loadApprovalRules({ pool, tenantId, ruleType: "tool_execution" });

  // 构建上下文
  const toolName = toolRef.split("@")[0] ?? "";
  const inputStr = JSON.stringify(inputDraft);
  const batchSize = Array.isArray(inputDraft.items) ? inputDraft.items.length : 0;
  const toolScope = toolDefinition?.scope;

  // 逐条匹配
  for (const rule of rules) {
    const result = matchToolExecutionRule(rule, { toolName, inputStr, inputDraft, batchSize, toolScope });
    if (result.matched) {
      matchedRules.push(result);
      const eff = rule.effect as { riskLevel?: RiskLevel; approvalRequired?: boolean; requiredApprovals?: number; approverRoles?: string[]; expiresInMinutes?: number };

      if (eff.riskLevel) {
        const w = riskWeight(eff.riskLevel);
        if (w > riskWeight(riskLevel)) {
          riskLevel = eff.riskLevel;
        }
        riskFactors.push(`rule:${rule.name}`);
      }
      if (eff.approvalRequired) {
        approvalRequired = true;
      }
      if (eff.requiredApprovals && eff.requiredApprovals > requiredApprovals) {
        requiredApprovals = eff.requiredApprovals;
      }
      if (eff.approverRoles) {
        for (const r of eff.approverRoles) {
          if (!approverRoles.includes(r)) approverRoles.push(r);
        }
      }
      if (eff.expiresInMinutes != null && (expiresInMinutes === null || eff.expiresInMinutes < expiresInMinutes)) {
        expiresInMinutes = eff.expiresInMinutes;
      }
    }
  }

  // 兆底：高风险强制审批
  if (riskLevel === "high") {
    approvalRequired = true;
  }

  // 生成人话总结
  const humanSummary = matchedRules.length > 0
    ? matchedRules.map((r) => r.explanation).join("；")
    : "该操作无需审批";

  return { riskLevel, approvalRequired, riskFactors, matchedRules, humanSummary, requiredApprovals, approverRoles, expiresInMinutes };
}

/* ================================================================== */
/*  Public API: Changeset Gate Assessment                               */
/* ================================================================== */

/**
 * 评估变更集的门禁要求（数据驱动版本）。
 *
 * 遍历所有 changeset items，对每个 item.kind 匹配 changeset_gate 和 eval_admission 规则。
 */
export async function assessChangesetGate(params: {
  pool: Pool;
  tenantId: string;
  itemKinds: string[];
  /** 供 tool.* 类 item 查询工具定义用 */
  getToolDef?: (name: string) => Promise<{ riskLevel?: string; approvalRequired?: boolean } | null>;
}): Promise<ChangesetGateAssessment> {
  const { pool, tenantId, itemKinds, getToolDef } = params;

  let riskLevel: RiskLevel = "low";
  let requiredApprovals = 1;
  let evalAdmissionRequired = false;
  const approverRoles: string[] = [];
  let expiresInMinutes: number | null = null;
  const matchedRules: RuleMatchResult[] = [];

  // 加载门禁规则和 eval 准入规则
  const [gateRules, evalRules] = await Promise.all([
    loadApprovalRules({ pool, tenantId, ruleType: "changeset_gate" }),
    loadApprovalRules({ pool, tenantId, ruleType: "eval_admission" }),
  ]);

  for (const kind of itemKinds) {
    // 匹配 changeset_gate 规则
    for (const rule of gateRules) {
      const result = matchItemKindRule(rule, kind);
      if (result.matched) {
        matchedRules.push(result);
        const eff = rule.effect as { riskLevel?: RiskLevel; requiredApprovals?: number; approverRoles?: string[]; expiresInMinutes?: number };
        if (eff.riskLevel && riskWeight(eff.riskLevel) > riskWeight(riskLevel)) {
          riskLevel = eff.riskLevel;
        }
        if (eff.requiredApprovals && eff.requiredApprovals > requiredApprovals) {
          requiredApprovals = eff.requiredApprovals;
        }
        if (eff.approverRoles) {
          for (const r of eff.approverRoles) {
            if (!approverRoles.includes(r)) approverRoles.push(r);
          }
        }
        if (eff.expiresInMinutes != null && (expiresInMinutes === null || eff.expiresInMinutes < expiresInMinutes)) {
          expiresInMinutes = eff.expiresInMinutes;
        }
      }
    }

    // 匹配 eval_admission 规则
    for (const rule of evalRules) {
      const result = matchItemKindRule(rule, kind);
      if (result.matched) {
        matchedRules.push(result);
        const eff = rule.effect as { evalRequired?: boolean };
        if (eff.evalRequired) {
          evalAdmissionRequired = true;
        }
      }
    }
  }

  // 对 tool.* 类 item，额外查询工具定义的 riskLevel
  if (getToolDef) {
    for (const kind of itemKinds) {
      if (!kind.startsWith("tool.")) continue;
      // 从 kind 无法直接得到 toolName，这部分由调用方补充
    }
  }

  // 如果高风险但审批人数不足2，提升到2
  if (riskLevel === "high" && requiredApprovals < 2) {
    requiredApprovals = 2;
  }

  const humanSummary = matchedRules.length > 0
    ? matchedRules.map((r) => r.explanation).filter(Boolean).join("；")
    : "该变更集无需特殊审批";

  return { riskLevel, requiredApprovals, evalAdmissionRequired, matchedRules, humanSummary, approverRoles, expiresInMinutes };
}

/* ================================================================== */
/*  Public API: Eval Admission Check                                    */
/* ================================================================== */

/**
 * 检查某个 item kind 是否触发 eval 准入门禁（数据驱动版本）。
 */
export async function checkEvalAdmission(params: {
  pool: Pool;
  tenantId: string;
  kind: string;
}): Promise<{ required: boolean; matchedRule: ApprovalRule | null; explanation: string }> {
  const rules = await loadApprovalRules({ pool: params.pool, tenantId: params.tenantId, ruleType: "eval_admission" });

  for (const rule of rules) {
    const result = matchItemKindRule(rule, params.kind);
    if (result.matched) {
      return { required: true, matchedRule: rule, explanation: result.explanation };
    }
  }

  return { required: false, matchedRule: null, explanation: "" };
}

/* ================================================================== */
/*  Helpers                                                             */
/* ================================================================== */

function riskWeight(level: RiskLevel): number {
  if (level === "high") return 3;
  if (level === "medium") return 2;
  return 1;
}

/** 安全取嵌套字段值（如 "payload.amount" → inputDraft.payload.amount） */
function getNestedField(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/* ================================================================== */
/*  Audit helper                                                        */
/* ================================================================== */

async function insertAudit(
  pool: Pool,
  ruleId: string,
  tenantId: string,
  action: string,
  prevSnapshot: Record<string, unknown> | null,
  newSnapshot: Record<string, unknown> | null,
  changedBy: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO approval_rule_audit (rule_id, tenant_id, action, prev_snapshot, new_snapshot, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ruleId, tenantId, action, prevSnapshot ? JSON.stringify(prevSnapshot) : null, newSnapshot ? JSON.stringify(newSnapshot) : null, changedBy],
  );
}

/* ================================================================== */
/*  Rule CRUD with audit                                                */
/* ================================================================== */

/** 创建审批规则 */
export async function createApprovalRule(params: {
  pool: Pool;
  tenantId: string;
  ruleType: ApprovalRuleType;
  name: string;
  description?: string;
  priority?: number;
  matchCondition: MatchCondition;
  effect: RuleEffect;
  changedBy?: string;
}): Promise<ApprovalRule> {
  const { pool, tenantId, ruleType, name, description, priority, matchCondition, effect, changedBy } = params;
  const res = await pool.query(
    `INSERT INTO approval_rules (tenant_id, rule_type, name, description, priority, match_condition, effect)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [tenantId, ruleType, name, description ?? "", priority ?? 100, JSON.stringify(matchCondition), JSON.stringify(effect)],
  );
  const rule = toRule(res.rows[0]);
  await insertAudit(pool, rule.ruleId, tenantId, "create", null, res.rows[0], changedBy ?? "system");
  invalidateRuleCache(tenantId, ruleType);
  return rule;
}

/** 更新审批规则 */
export async function updateApprovalRule(params: {
  pool: Pool;
  ruleId: string;
  tenantId: string;
  updates: Partial<Pick<ApprovalRule, "name" | "description" | "priority" | "matchCondition" | "effect" | "enabled">>;
  changedBy?: string;
}): Promise<ApprovalRule | null> {
  const { pool, ruleId, tenantId, updates, changedBy } = params;
  // snapshot before
  const prev = await pool.query(`SELECT * FROM approval_rules WHERE rule_id = $1 AND tenant_id = $2`, [ruleId, tenantId]);
  if (prev.rows.length === 0) return null;
  const prevRow = prev.rows[0];

  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;
  if (updates.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(updates.name); }
  if (updates.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(updates.description); }
  if (updates.priority !== undefined) { sets.push(`priority = $${idx++}`); vals.push(updates.priority); }
  if (updates.matchCondition !== undefined) { sets.push(`match_condition = $${idx++}`); vals.push(JSON.stringify(updates.matchCondition)); }
  if (updates.effect !== undefined) { sets.push(`effect = $${idx++}`); vals.push(JSON.stringify(updates.effect)); }
  if (updates.enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(updates.enabled); }
  if (sets.length === 0) return toRule(prevRow);

  sets.push(`updated_at = now()`);
  vals.push(ruleId, tenantId);
  const res = await pool.query(
    `UPDATE approval_rules SET ${sets.join(", ")} WHERE rule_id = $${idx++} AND tenant_id = $${idx++} RETURNING *`,
    vals,
  );
  if (res.rows.length === 0) return null;
  await insertAudit(pool, ruleId, tenantId, "update", prevRow, res.rows[0], changedBy ?? "system");
  invalidateRuleCache(tenantId);
  return toRule(res.rows[0]);
}

/** 删除审批规则 */
export async function deleteApprovalRule(params: {
  pool: Pool;
  ruleId: string;
  tenantId: string;
  changedBy?: string;
}): Promise<boolean> {
  const { pool, ruleId, tenantId, changedBy } = params;
  const prev = await pool.query(`SELECT * FROM approval_rules WHERE rule_id = $1 AND tenant_id = $2`, [ruleId, tenantId]);
  if (prev.rows.length === 0) return false;
  await pool.query(`DELETE FROM approval_rules WHERE rule_id = $1 AND tenant_id = $2`, [ruleId, tenantId]);
  await insertAudit(pool, ruleId, tenantId, "delete", prev.rows[0], null, changedBy ?? "system");
  invalidateRuleCache(tenantId);
  return true;
}

/** 启用/禁用审批规则 */
export async function toggleApprovalRule(params: {
  pool: Pool;
  ruleId: string;
  tenantId: string;
  enabled: boolean;
  changedBy?: string;
}): Promise<ApprovalRule | null> {
  return updateApprovalRule({
    pool: params.pool,
    ruleId: params.ruleId,
    tenantId: params.tenantId,
    updates: { enabled: params.enabled },
    changedBy: params.changedBy,
  });
}
