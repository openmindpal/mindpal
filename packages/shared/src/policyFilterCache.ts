/**
 * policyFilterCache — 统一行过滤编译器与缓存
 *
 * 功能目标：消除 apps/api/src/modules/data/dataRepo.ts 和
 * apps/worker/src/workflow/processor/entity.ts 中的重复 compileRowFiltersWhere 逻辑。
 *
 * 统一实现支持所有 RowFilterKind：
 *   owner_only, payload_field_eq_subject, payload_field_eq_literal,
 *   space_member, org_hierarchy, expr, or, and, not
 */

import { compilePolicyExprWhere, validatePolicyExpr } from "./policyExpr";

// ── 工具函数 ──────────────────────────────────────────────────────────────

function isSafeFieldName(name: string): boolean {
  if (!name) return false;
  if (name.length > 100) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

// ── PolicyExpr 验证缓存（LRU-style，上限 500） ──

const policyExprValidatedCache = new Map<string, { expr: any; usedPayloadPaths: string[] }>();

function getCachedValidatedExpr(exprRaw: any, epochKey: string): { expr: any; usedPayloadPaths: string[] } {
  const exprKey = `${epochKey}|${JSON.stringify(exprRaw)}`;
  let validated = policyExprValidatedCache.get(exprKey);
  if (!validated) {
    const v = validatePolicyExpr(exprRaw);
    if (!v.ok) throw new Error("policy_violation:policy_expr_invalid");
    validated = { expr: v.expr as any, usedPayloadPaths: v.usedPayloadPaths };
    policyExprValidatedCache.set(exprKey, validated);
    if (policyExprValidatedCache.size > 500) {
      const first = policyExprValidatedCache.keys().next().value;
      if (first) policyExprValidatedCache.delete(first);
    }
  }
  return validated;
}

// ── 主编译函数 ────────────────────────────────────────────────────────────

export interface RowFilterSubject {
  subjectId?: string | null;
  tenantId?: string | null;
  spaceId?: string | null;
}

export interface CompileRowFiltersParams {
  rowFilters?: any;
  subject: RowFilterSubject;
  context?: any;
  /** 实体表名，用于 space_member JOIN（默认 "entity_records"） */
  entityTable?: string;
  /** owner 列名（默认 "owner_subject_id"） */
  ownerColumn?: string;
  /** payload 列名（默认 "payload"） */
  payloadColumn?: string;
}

export interface CompileRowFiltersResult {
  sql: string;
  idx: number;
}

/**
 * 编译 RowFilterKind 树为 SQL WHERE 片段。
 *
 * @param params - 行过滤参数
 * @param args - SQL 参数数组（会被 push）
 * @param idxStart - 当前参数索引起始值
 */
export function compileRowFiltersWhere(
  params: CompileRowFiltersParams,
  args: any[],
  idxStart: number,
): CompileRowFiltersResult {
  let idx = idxStart;
  const ownerCol = params.ownerColumn ?? "owner_subject_id";
  const payloadCol = params.payloadColumn ?? "payload";
  const entityTable = params.entityTable ?? "entity_records";

  const fieldExpr = (field: string) => {
    args.push(field);
    return `(${payloadCol}->>$${++idx})`;
  };
  const pushValue = (value: any) => {
    args.push(value);
    return `$${++idx}`;
  };

  const compileOne = (rf: any): string => {
    if (!rf) return "TRUE";
    if (typeof rf !== "object" || Array.isArray(rf)) throw new Error("policy_violation:unsupported_row_filters");
    const kind = String((rf as any).kind ?? "");

    if (kind === "owner_only") {
      const subjectId = params.subject.subjectId ?? null;
      if (!subjectId) throw new Error("policy_violation:missing_subject_id");
      const right = pushValue(subjectId);
      return `${ownerCol} = ${right}`;
    }

    if (kind === "payload_field_eq_subject") {
      const subjectId = params.subject.subjectId ?? null;
      if (!subjectId) throw new Error("policy_violation:missing_subject_id");
      const field = String((rf as any).field ?? "");
      if (!isSafeFieldName(field)) throw new Error("policy_violation:row_filter_field_invalid");
      const left = fieldExpr(field);
      const right = pushValue(subjectId);
      return `${left} = ${right}::text`;
    }

    if (kind === "payload_field_eq_literal") {
      const field = String((rf as any).field ?? "");
      if (!isSafeFieldName(field)) throw new Error("policy_violation:row_filter_field_invalid");
      const value = (rf as any).value;
      const t = typeof value;
      if (t !== "string" && t !== "number" && t !== "boolean") throw new Error("policy_violation:row_filter_value_invalid");
      const left = fieldExpr(field);
      const right = pushValue(String(value));
      return `${left} = ${right}::text`;
    }

    if (kind === "or") {
      const rules = (rf as any).rules;
      if (!Array.isArray(rules) || rules.length === 0) return "TRUE";
      return `(${rules.map((x: any) => `(${compileOne(x)})`).join(" OR ")})`;
    }

    if (kind === "and") {
      const rules = (rf as any).rules;
      if (!Array.isArray(rules) || rules.length === 0) return "TRUE";
      return `(${rules.map((x: any) => `(${compileOne(x)})`).join(" AND ")})`;
    }

    if (kind === "not") {
      const rule = (rf as any).rule;
      if (!rule) return "TRUE";
      return `(NOT (${compileOne(rule)}))`;
    }

    if (kind === "space_member") {
      const subjectId = params.subject.subjectId ?? null;
      const tenantId = params.subject.tenantId ?? null;
      if (!subjectId || !tenantId) throw new Error("policy_violation:missing_subject_id");
      const roles = (rf as any).roles;
      if (Array.isArray(roles) && roles.length > 0) {
        const tParam = pushValue(tenantId);
        const sParam = pushValue(subjectId);
        const rParam = pushValue(roles);
        return `EXISTS (SELECT 1 FROM space_members sm WHERE sm.tenant_id = ${tParam} AND sm.subject_id = ${sParam} AND sm.space_id = COALESCE(${entityTable}.space_id, '') AND sm.role = ANY(${rParam}::text[]))`;
      }
      const tParam = pushValue(tenantId);
      const sParam = pushValue(subjectId);
      return `EXISTS (SELECT 1 FROM space_members sm WHERE sm.tenant_id = ${tParam} AND sm.subject_id = ${sParam} AND sm.space_id = COALESCE(${entityTable}.space_id, ''))`;
    }

    if (kind === "org_hierarchy") {
      const orgField = String((rf as any).orgField ?? "orgUnitId");
      if (!isSafeFieldName(orgField)) throw new Error("policy_violation:row_filter_field_invalid");
      const includeDescendants = Boolean((rf as any).includeDescendants ?? true);
      const subjectId = params.subject.subjectId ?? null;
      const tenantId = params.subject.tenantId ?? null;
      if (!subjectId || !tenantId) throw new Error("policy_violation:missing_subject_id");
      const recordOrgExpr = fieldExpr(orgField);
      const tParam = pushValue(tenantId);
      const sParam = pushValue(subjectId);
      if (includeDescendants) {
        return `EXISTS (SELECT 1 FROM subject_org_assignments soa JOIN org_units ou ON ou.org_unit_id = soa.org_unit_id JOIN org_units target_ou ON target_ou.org_unit_id::text = ${recordOrgExpr} WHERE soa.tenant_id = ${tParam} AND soa.subject_id = ${sParam} AND target_ou.org_path LIKE ou.org_path || '%')`;
      }
      return `EXISTS (SELECT 1 FROM subject_org_assignments soa WHERE soa.tenant_id = ${tParam} AND soa.subject_id = ${sParam} AND soa.org_unit_id::text = ${recordOrgExpr})`;
    }

    if (kind === "expr") {
      const epochKey = JSON.stringify(params.context?.policyCacheEpoch ?? null);
      const exprRaw = (rf as any).expr ?? null;
      const validated = getCachedValidatedExpr(exprRaw, epochKey);
      const compiled = compilePolicyExprWhere({
        expr: exprRaw,
        validated,
        subject: params.subject,
        context: params.context,
        args,
        idxStart: idx,
        ownerColumn: ownerCol,
        payloadColumn: payloadCol,
      });
      idx = compiled.idx;
      return compiled.sql;
    }

    throw new Error("policy_violation:unsupported_row_filters");
  };

  const sql = compileOne(params.rowFilters);
  return { sql, idx };
}

/** 清除内部 PolicyExpr 验证缓存（用于测试） */
export function clearPolicyExprCache(): void {
  policyExprValidatedCache.clear();
}
