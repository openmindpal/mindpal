/**
 * policyEngine.ts — ABAC 评估引擎
 *
 * 基于属性的访问控制 (Attribute-Based Access Control) 引擎，
 * 扩展现有 RBAC 系统，支持：
 * - 属性策略定义与评估
 * - 多条件组合 (AND/OR/NOT)
 * - 资源层级继承
 * - 环境上下文感知 (时间/IP/设备)
 * - 策略冲突解决 (deny-overrides / permit-overrides / first-applicable)
 *
 * @module policyEngine
 */
import type { PolicyExpr, PolicyOperand, PolicyLiteral } from "./policyExpr";
import { validatePolicyExpr } from "./policyExpr";

// ─── ABAC 类型定义 ──────────────────────────────────────────────

/** 属性类别 */
export type AttributeCategory = "subject" | "resource" | "action" | "environment";

/** 属性定义 */
export interface AttributeDefinition {
  /** 属性名称 */
  name: string;
  /** 属性类别 */
  category: AttributeCategory;
  /** 属性类型 */
  type: "string" | "number" | "boolean" | "string[]" | "json";
  /** 是否必需 */
  required?: boolean;
  /** 默认值 */
  defaultValue?: string | number | boolean;
  /** 描述 */
  description?: string;
}

/** ABAC 策略规则 */
export interface AbacPolicyRule {
  /** 规则ID */
  ruleId: string;
  /** 规则名称 */
  name: string;
  /** 规则描述 */
  description?: string;
  /** 目标资源类型 */
  resourceType: string;
  /** 目标操作 */
  actions: string[];
  /** 规则优先级 (数值越小越高) */
  priority: number;
  /** 效果 */
  effect: "allow" | "deny";
  /** 条件表达式 (PolicyExpr) */
  condition: PolicyExpr;
  /** 规则状态 */
  enabled: boolean;
  /** 适用的租户 */
  tenantId?: string;
  /** 适用的空间 */
  spaceId?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/** ABAC 策略集 */
export interface AbacPolicySet {
  /** 策略集ID */
  policySetId: string;
  /** 策略集名称 */
  name: string;
  /** 版本号 */
  version: number;
  /** 包含的规则 */
  rules: AbacPolicyRule[];
  /** 冲突解决策略 */
  combiningAlgorithm: PolicyCombiningAlgorithm;
  /** 目标资源类型 */
  resourceType: string;
  /** 状态 */
  status: "draft" | "active" | "deprecated";
}

/** 策略冲突解决算法 */
export type PolicyCombiningAlgorithm =
  | "deny_overrides"       // 任一 deny → deny
  | "permit_overrides"     // 任一 allow → allow
  | "first_applicable"     // 第一个匹配的规则生效
  | "deny_unless_permit"   // 默认 deny，除非有 allow
  | "permit_unless_deny";  // 默认 allow，除非有 deny

/** ABAC 评估请求 */
export interface AbacEvaluationRequest {
  /** 主体属性 */
  subject: {
    subjectId: string;
    tenantId: string;
    spaceId?: string;
    roles?: string[];
    groups?: string[];
    department?: string;
    clearanceLevel?: number;
    attributes?: Record<string, unknown>;
  };
  /** 资源属性 */
  resource: {
    resourceType: string;
    resourceId?: string;
    ownerSubjectId?: string;
    classification?: string;
    tags?: string[];
    hierarchy?: string;
    attributes?: Record<string, unknown>;
  };
  /** 操作 */
  action: string;
  /** 环境属性 */
  environment?: {
    ip?: string;
    userAgent?: string;
    deviceType?: string;
    geoCountry?: string;
    geoCity?: string;
    timestamp?: string;
    attributes?: Record<string, unknown>;
  };
}

/** ABAC 评估结果 */
export interface AbacEvaluationResult {
  /** 最终决策 */
  decision: "allow" | "deny";
  /** 决策原因 */
  reason: string;
  /** 匹配的规则 */
  matchedRules: Array<{
    ruleId: string;
    name: string;
    effect: "allow" | "deny";
    matched: boolean;
  }>;
  /** 使用的冲突解决算法 */
  combiningAlgorithm: PolicyCombiningAlgorithm;
  /** 评估耗时(ms) */
  evaluationMs: number;
  /** 属性解析结果 */
  resolvedAttributes?: Record<string, unknown>;
}

// ─── 阶段2: 策略集倒排索引 ────────────────────────────────────

/**
 * 策略集倒排索引
 * 预构建 action → rules 、resourceType → rules 的映射,
 * 避免每次评估都遍历全部规则。
 */
export interface PolicySetIndex {
  /** action → 规则列表(已按 priority 排序) */
  byAction: Map<string, AbacPolicyRule[]>;
  /** resourceType → 规则列表(已按 priority 排序) */
  byResourceType: Map<string, AbacPolicyRule[]>;
  /** 通配规则(包含 "*" action 或所有 action 覆盖的规则) */
  wildcardRules: AbacPolicyRule[];
}

/**
 * 为策略集预构建倒排索引
 * 应在策略集加载时调用一次,缓存索引对象复用。
 */
export function buildPolicySetIndex(policySet: AbacPolicySet): PolicySetIndex {
  const byAction = new Map<string, AbacPolicyRule[]>();
  const byResourceType = new Map<string, AbacPolicyRule[]>();
  const wildcardRules: AbacPolicyRule[] = [];

  // 只索引已启用的规则
  const enabledRules = policySet.rules.filter(r => r.enabled).sort((a, b) => a.priority - b.priority);

  for (const rule of enabledRules) {
    // resourceType 索引
    const rtList = byResourceType.get(rule.resourceType);
    if (rtList) rtList.push(rule);
    else byResourceType.set(rule.resourceType, [rule]);

    // action 索引
    if (rule.actions.includes("*")) {
      wildcardRules.push(rule);
    } else {
      for (const action of rule.actions) {
        const aList = byAction.get(action);
        if (aList) aList.push(rule);
        else byAction.set(action, [rule]);
      }
    }
  }

  return { byAction, byResourceType, wildcardRules };
}

/**
 * 使用索引快速筛选适用规则
 * 将 O(n) 的全遍历优化为索引查找 + 合并去重
 */
function resolveApplicableRules(
  policySet: AbacPolicySet,
  action: string,
  resourceType: string,
  index?: PolicySetIndex,
): AbacPolicyRule[] {
  if (!index) {
    // 无索引: 回退原始的遍历方式
    return policySet.rules
      .filter(r => r.enabled && r.actions.includes(action) && r.resourceType === resourceType)
      .sort((a, b) => a.priority - b.priority);
  }

  // 从索引中获取匹配 action 的规则 + 通配规则
  const actionRules = index.byAction.get(action) ?? [];
  const wildcardRules = index.wildcardRules;

  // 合并并按 resourceType 筛选
  const seen = new Set<string>();
  const result: AbacPolicyRule[] = [];

  for (const rule of actionRules) {
    if (rule.resourceType === resourceType && !seen.has(rule.ruleId)) {
      seen.add(rule.ruleId);
      result.push(rule);
    }
  }
  for (const rule of wildcardRules) {
    if (rule.resourceType === resourceType && !seen.has(rule.ruleId)) {
      seen.add(rule.ruleId);
      result.push(rule);
    }
  }

  // 已按 priority 预排序,但合并后需重新排序
  result.sort((a, b) => a.priority - b.priority);
  return result;
}

// ─── ABAC 评估引擎 ──────────────────────────────────────────────

/**
 * 评估 ABAC 策略条件
 *
 * 将 PolicyExpr 在运行时评估（纯内存，不编译 SQL），
 * 用于 API 请求级别的实时访问控制。
 */
export function evaluateAbacCondition(
  expr: PolicyExpr,
  context: AbacEvaluationRequest,
): boolean {
  const resolve = (operand: PolicyOperand): string | null => {
    if (operand.kind === "subject") {
      if (operand.key === "subjectId") return context.subject.subjectId;
      if (operand.key === "tenantId") return context.subject.tenantId;
      if (operand.key === "spaceId") return context.subject.spaceId ?? null;
      return null;
    }
    if (operand.kind === "record") {
      if (operand.key === "ownerSubjectId") return context.resource.ownerSubjectId ?? null;
      return null;
    }
    if (operand.kind === "payload") {
      // 从资源属性中解析
      const segs = operand.path.split(".");
      let cur: any = context.resource.attributes ?? {};
      for (const seg of segs) {
        if (!cur || typeof cur !== "object") return null;
        cur = cur[seg];
      }
      return cur === null || cur === undefined ? null : String(cur);
    }
    if (operand.kind === "context") {
      const segs = operand.path.split(".");
      const root = segs[0];
      const key = segs.slice(1).join(".");
      if (root === "subject") {
        if (key === "id") return context.subject.subjectId;
        if (key === "type") return "user";
        const val = (context.subject.attributes as any)?.[key];
        return val === undefined ? null : String(val);
      }
      if (root === "resource") {
        if (key === "type") return context.resource.resourceType;
        if (key === "id") return context.resource.resourceId ?? null;
        if (key === "ownerSubjectId") return context.resource.ownerSubjectId ?? null;
        return null;
      }
      if (root === "env") return (context.environment as any)?.[key] ?? null;
      return null;
    }
    if (operand.kind === "env") {
      return (context.environment as any)?.[operand.key] ?? null;
    }
    if (operand.kind === "time") {
      const now = new Date();
      if (operand.key === "hourOfDay") return String(now.getHours());
      if (operand.key === "dayOfWeek") return String(now.getDay());
      if (operand.key === "isoDate") return now.toISOString().slice(0, 10);
      if (operand.key === "unixEpoch") return String(Math.floor(now.getTime() / 1000));
      return null;
    }
    return null;
  };

  const evaluateExpr = (e: PolicyExpr): boolean => {
    if (e.op === "and") return e.args.every(a => evaluateExpr(a));
    if (e.op === "or") return e.args.some(a => evaluateExpr(a));
    if (e.op === "not") return !evaluateExpr(e.arg);
    if (e.op === "eq") {
      const left = resolve(e.left);
      const right = typeof (e.right as any)?.kind === "string" ? resolve(e.right as PolicyOperand) : String(e.right ?? "");
      return left === right;
    }
    if (e.op === "neq") {
      const left = resolve(e.left);
      const right = typeof (e.right as any)?.kind === "string" ? resolve(e.right as PolicyOperand) : String(e.right ?? "");
      return left !== right;
    }
    if (e.op === "in") {
      const left = resolve(e.left);
      if (left === null) return false;
      return e.right.values.map(v => String(v ?? "")).includes(left);
    }
    if (e.op === "exists") {
      return resolve(e.operand) !== null;
    }
    if (e.op === "contains") {
      const val = resolve(e.operand);
      return val !== null && val.toLowerCase().includes(e.value.toLowerCase());
    }
    if (e.op === "starts_with") {
      const val = resolve(e.operand);
      return val !== null && val.toLowerCase().startsWith(e.prefix.toLowerCase());
    }
    if (e.op === "ends_with") {
      const val = resolve(e.operand);
      return val !== null && val.toLowerCase().endsWith(e.suffix.toLowerCase());
    }
    if (e.op === "regex") {
      const val = resolve(e.operand);
      if (val === null) return false;
      try {
        return new RegExp(e.pattern, e.flags).test(val);
      } catch { return false; }
    }
    if (e.op === "gte" || e.op === "lte" || e.op === "gt" || e.op === "lt") {
      const left = Number(resolve(e.left));
      const right = Number(typeof (e.right as any)?.kind === "string" ? resolve(e.right as PolicyOperand) : e.right);
      if (isNaN(left) || isNaN(right)) return false;
      if (e.op === "gte") return left >= right;
      if (e.op === "lte") return left <= right;
      if (e.op === "gt") return left > right;
      return left < right;
    }
    if (e.op === "between") {
      const val = Number(resolve(e.operand));
      return !isNaN(val) && val >= Number(e.low) && val <= Number(e.high);
    }
    if (e.op === "hierarchy") {
      const val = resolve(e.operand);
      if (val === null) return false;
      const sep = e.separator ?? "/";
      return val === e.ancestorValue || val.startsWith(e.ancestorValue + sep);
    }
    if (e.op === "attr_match") {
      return e.attributes.every(attr => {
        const val = resolve(attr.operand);
        return val === String(attr.value ?? "");
      });
    }
    // ip_in_cidr / time_window: 运行时评估不支持，安全默认拒绝
    // 这些操作符仅在 SQL 编译路径 (compilePolicyExprWhere) 中处理
    if (e.op === "ip_in_cidr" || e.op === "time_window" || e.op === "size") {
      // 已知的仅 SQL 编译时操作符 → 运行时无法评估，保守拒绝
      return false;
    }
    // 未知操作符 → 安全默认拒绝（防止新操作符遗漏导致权限绕过）
    return false;
  };

  return evaluateExpr(expr);
}

/**
 * 评估 ABAC 策略集
 *
 * 支持可选的预构建索引以加速规则筛选,
 * 并对每种冲突解决算法实现短路评估以减少不必要的规则匹配。
 */
export function evaluateAbacPolicySet(
  policySet: AbacPolicySet,
  request: AbacEvaluationRequest,
  index?: PolicySetIndex,
): AbacEvaluationResult {
  const startTime = performance.now();
  const matchedRules: AbacEvaluationResult["matchedRules"] = [];

  // 阶段2: 使用索引快速筛选适用规则(或回退到遍历)
  const applicableRules = resolveApplicableRules(
    policySet,
    request.action,
    request.resource.resourceType,
    index,
  );

  let allows = 0;
  let denies = 0;
  let firstApplicable: "allow" | "deny" | null = null;

  // 阶段2: 短路评估 —— 根据算法尽早结束
  const algo = policySet.combiningAlgorithm;

  for (const rule of applicableRules) {
    const matched = evaluateAbacCondition(rule.condition, request);
    matchedRules.push({ ruleId: rule.ruleId, name: rule.name, effect: rule.effect, matched });

    if (matched) {
      if (rule.effect === "allow") allows++;
      if (rule.effect === "deny") denies++;
      if (firstApplicable === null) firstApplicable = rule.effect;

      // 短路: deny_overrides 遇到第一个 deny 就可以立即返回
      if (algo === "deny_overrides" && rule.effect === "deny") {
        return {
          decision: "deny",
          reason: `deny_overrides: 规则 [${rule.name}] 匹配拒绝，短路返回`,
          matchedRules,
          combiningAlgorithm: algo,
          evaluationMs: Math.round((performance.now() - startTime) * 1000) / 1000,
        };
      }

      // 短路: permit_overrides 遇到第一个 allow 就可以立即返回
      if (algo === "permit_overrides" && rule.effect === "allow") {
        return {
          decision: "allow",
          reason: `permit_overrides: 规则 [${rule.name}] 匹配允许，短路返回`,
          matchedRules,
          combiningAlgorithm: algo,
          evaluationMs: Math.round((performance.now() - startTime) * 1000) / 1000,
        };
      }

      // 短路: first_applicable 遇到第一个匹配规则就立即返回
      if (algo === "first_applicable") {
        return {
          decision: rule.effect,
          reason: `first_applicable: 规则 [${rule.name}] 首个匹配，效果为 ${rule.effect}`,
          matchedRules,
          combiningAlgorithm: algo,
          evaluationMs: Math.round((performance.now() - startTime) * 1000) / 1000,
        };
      }

      // 短路: permit_unless_deny 遇到第一个 deny 就可以立即返回
      if (algo === "permit_unless_deny" && rule.effect === "deny") {
        return {
          decision: "deny",
          reason: `permit_unless_deny: 规则 [${rule.name}] 匹配拒绝，短路返回`,
          matchedRules,
          combiningAlgorithm: algo,
          evaluationMs: Math.round((performance.now() - startTime) * 1000) / 1000,
        };
      }
    }
  }

  // 无短路命中,按原算法计算最终结果
  let decision: "allow" | "deny";
  let reason: string;

  switch (algo) {
    case "deny_overrides":
      // 已经短路过 deny,走到这里意味着没有 deny
      decision = allows > 0 ? "allow" : "deny";
      reason = allows > 0 ? `${allows} 条 allow 规则匹配` : "无匹配规则，默认拒绝";
      break;
    case "permit_overrides":
      // 已经短路过 allow,走到这里意味着没有 allow —— 默认拒绝
      decision = "deny";
      reason = denies > 0 ? `${denies} 条 deny 规则匹配，无 allow 规则` : "无匹配规则，默认拒绝";
      break;
    case "first_applicable":
      // 已经短路过,走到这里意味着没有任何匹配
      decision = "deny";
      reason = "无匹配规则，默认拒绝";
      break;
    case "deny_unless_permit":
      decision = allows > 0 ? "allow" : "deny";
      reason = allows > 0 ? `deny_unless_permit: ${allows} 条 allow 规则匹配` : "无 allow 规则匹配，默认拒绝";
      break;
    case "permit_unless_deny":
      // 已经短路过 deny,走到这里意味着没有 deny
      decision = "allow";
      reason = "无 deny 规则匹配，默认允许";
      break;
    default:
      decision = "deny";
      reason = "未知的冲突解决算法";
  }

  return {
    decision,
    reason,
    matchedRules,
    combiningAlgorithm: algo,
    evaluationMs: Math.round((performance.now() - startTime) * 1000) / 1000,
  };
}

/**
 * 验证 ABAC 策略规则
 */
export function validateAbacPolicyRule(rule: unknown): { ok: boolean; error?: string } {
  if (!rule || typeof rule !== "object") return { ok: false, error: "规则必须是对象" };
  const r = rule as Record<string, unknown>;

  if (typeof r.ruleId !== "string" || !r.ruleId) return { ok: false, error: "缺少 ruleId" };
  if (typeof r.name !== "string" || !r.name) return { ok: false, error: "缺少 name" };
  if (typeof r.resourceType !== "string" || !r.resourceType) return { ok: false, error: "缺少 resourceType" };
  if (!Array.isArray(r.actions) || r.actions.length === 0) return { ok: false, error: "actions 不能为空" };
  if (r.effect !== "allow" && r.effect !== "deny") return { ok: false, error: "effect 必须是 allow 或 deny" };

  // 验证条件表达式
  const conditionResult = validatePolicyExpr(r.condition);
  if (!conditionResult.ok) return { ok: false, error: `条件表达式无效: ${(conditionResult as any).message}` };

  return { ok: true };
}

/**
 * 资源层级检查
 * 判断一个路径是否属于指定祖先路径的子路径
 */
export function isInHierarchy(value: string, ancestor: string, separator = "/"): boolean {
  if (value === ancestor) return true;
  return value.startsWith(ancestor + separator);
}

/**
 * 从层级路径中提取所有祖先
 */
export function getHierarchyAncestors(path: string, separator = "/"): string[] {
  const parts = path.split(separator).filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    ancestors.push(parts.slice(0, i).join(separator));
  }
  return ancestors;
}
