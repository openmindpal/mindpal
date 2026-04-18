import { isPlainObject } from "./runtime";

export type PolicyLiteral = string | number | boolean | null;

export type PolicyOperand =
  | { kind: "subject"; key: "subjectId" | "tenantId" | "spaceId" }
  | { kind: "record"; key: "ownerSubjectId" }
  | { kind: "payload"; path: string }
  | { kind: "context"; path: string }
  | { kind: "env"; key: "ip" | "userAgent" | "deviceType" | "geoCountry" | "geoCity" }
  | { kind: "time"; key: "hourOfDay" | "dayOfWeek" | "isoDate" | "unixEpoch" | "timeZone" };

export type PolicyExpr =
  | { op: "and"; args: PolicyExpr[] }
  | { op: "or"; args: PolicyExpr[] }
  | { op: "not"; arg: PolicyExpr }
  | { op: "eq"; left: PolicyOperand; right: PolicyOperand | PolicyLiteral }
  | { op: "in"; left: PolicyOperand; right: { kind: "list"; values: PolicyLiteral[] } }
  | { op: "exists"; operand: PolicyOperand }
  | { op: "gte"; left: PolicyOperand; right: PolicyOperand | PolicyLiteral }
  | { op: "lte"; left: PolicyOperand; right: PolicyOperand | PolicyLiteral }
  | { op: "between"; operand: PolicyOperand; low: PolicyLiteral; high: PolicyLiteral }
  | { op: "ip_in_cidr"; operand: PolicyOperand; cidrs: string[] }
  | { op: "time_window"; timeZone: string; days: number[]; startHour: string; endHour: string }
  // v2: CEL风格操作符
  | { op: "regex"; operand: PolicyOperand; pattern: string; flags?: string }
  | { op: "contains"; operand: PolicyOperand; value: string }
  | { op: "starts_with"; operand: PolicyOperand; prefix: string }
  | { op: "ends_with"; operand: PolicyOperand; suffix: string }
  | { op: "gt"; left: PolicyOperand; right: PolicyOperand | PolicyLiteral }
  | { op: "lt"; left: PolicyOperand; right: PolicyOperand | PolicyLiteral }
  | { op: "neq"; left: PolicyOperand; right: PolicyOperand | PolicyLiteral }
  | { op: "size"; operand: PolicyOperand; comparator: "eq" | "gt" | "lt" | "gte" | "lte"; value: number }
  // v2: ABAC 层级操作符
  | { op: "hierarchy"; operand: PolicyOperand; ancestorValue: string; separator?: string }
  | { op: "attr_match"; attributes: Array<{ key: string; operand: PolicyOperand; value: PolicyLiteral }> };

export const POLICY_EXPR_JSON_SCHEMA_V1 = {
  $id: "openslin:policy-expr:v1",
  type: "object",
  oneOf: [
    { properties: { op: { const: "and" }, args: { type: "array", minItems: 1, items: { $ref: "openslin:policy-expr:v1" } } }, required: ["op", "args"] },
    { properties: { op: { const: "or" }, args: { type: "array", minItems: 1, items: { $ref: "openslin:policy-expr:v1" } } }, required: ["op", "args"] },
    { properties: { op: { const: "not" }, arg: { $ref: "openslin:policy-expr:v1" } }, required: ["op", "arg"] },
    {
      properties: {
        op: { const: "eq" },
        left: { $ref: "openslin:policy-operand:v1" },
        right: { oneOf: [{ $ref: "openslin:policy-operand:v1" }, { $ref: "openslin:policy-literal:v1" }] },
      },
      required: ["op", "left", "right"],
    },
    {
      properties: {
        op: { const: "in" },
        left: { $ref: "openslin:policy-operand:v1" },
        right: { type: "object", properties: { kind: { const: "list" }, values: { type: "array", minItems: 1, items: { $ref: "openslin:policy-literal:v1" } } }, required: ["kind", "values"] },
      },
      required: ["op", "left", "right"],
    },
    {
      properties: { op: { const: "exists" }, operand: { $ref: "openslin:policy-operand:v1" } },
      required: ["op", "operand"],
    },
  ],
  $defs: {
    "openslin:policy-literal:v1": { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] },
    "openslin:policy-operand:v1": {
      type: "object",
      oneOf: [
        { properties: { kind: { const: "subject" }, key: { enum: ["subjectId", "tenantId", "spaceId"] } }, required: ["kind", "key"] },
        { properties: { kind: { const: "record" }, key: { enum: ["ownerSubjectId"] } }, required: ["kind", "key"] },
        { properties: { kind: { const: "payload" }, path: { type: "string" } }, required: ["kind", "path"] },
        { properties: { kind: { const: "context" }, path: { type: "string" } }, required: ["kind", "path"] },
        { properties: { kind: { const: "env" }, key: { enum: ["ip", "userAgent", "deviceType", "geoCountry", "geoCity"] } }, required: ["kind", "key"] },
        { properties: { kind: { const: "time" }, key: { enum: ["hourOfDay", "dayOfWeek", "isoDate", "unixEpoch", "timeZone"] } }, required: ["kind", "key"] },
      ],
    },
  },
} as const;

function isSafePathSegment(seg: string) {
  if (!seg) return false;
  if (seg.length > 100) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(seg);
}

function parsePayloadPath(path: string) {
  const raw = String(path ?? "").trim();
  if (!raw) return null;
  if (raw.length > 300) return null;
  const segs = raw.split(".").map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0 || segs.length > 10) return null;
  if (!segs.every(isSafePathSegment)) return null;
  return segs;
}

function isAllowedContextPath(segs: string[]) {
  const p = segs.join(".");
  return (
    p === "subject.id" ||
    p === "subject.type" ||
    p === "tenant.id" ||
    p === "space.id" ||
    p === "request.method" ||
    p === "request.path" ||
    p === "request.traceId" ||
    p === "resource.type" ||
    p === "resource.id" ||
    p === "resource.ownerSubjectId" ||
    p === "env.ip" ||
    p === "env.userAgent" ||
    p === "env.deviceType" ||
    p === "env.geoCountry" ||
    p === "env.geoCity" ||
    p === "time.hourOfDay" ||
    p === "time.dayOfWeek" ||
    p === "time.isoDate" ||
    p === "time.unixEpoch" ||
    p === "time.timeZone"
  );
}

function parseContextPath(path: string) {
  const segs = parsePayloadPath(path);
  if (!segs) return null;
  if (!isAllowedContextPath(segs)) return null;
  return segs;
}

function parseLiteral(v: unknown): PolicyLiteral | null {
  if (v === null) return null;
  const t = typeof v;
  if (t === "string") return v as string;
  if (t === "number" && Number.isFinite(v as number)) return v as number;
  if (t === "boolean") return v as boolean;
  return null;
}

function parseOperand(v: unknown): PolicyOperand | null {
  if (!isPlainObject(v)) return null;
  const kind = String(v.kind ?? "");
  if (kind === "subject") {
    const key = String(v.key ?? "");
    if (key === "subjectId" || key === "tenantId" || key === "spaceId") return { kind: "subject", key };
    return null;
  }
  if (kind === "record") {
    const key = String(v.key ?? "");
    if (key === "ownerSubjectId") return { kind: "record", key };
    return null;
  }
  if (kind === "payload") {
    const path = String(v.path ?? "");
    const segs = parsePayloadPath(path);
    if (!segs) return null;
    return { kind: "payload", path: segs.join(".") };
  }
  if (kind === "context") {
    const path = String(v.path ?? "");
    const segs = parseContextPath(path);
    if (!segs) return null;
    return { kind: "context", path: segs.join(".") };
  }
  if (kind === "env") {
    const key = String(v.key ?? "");
    if (key === "ip" || key === "userAgent" || key === "deviceType" || key === "geoCountry" || key === "geoCity") return { kind: "env", key };
    return null;
  }
  if (kind === "time") {
    const key = String(v.key ?? "");
    if (key === "hourOfDay" || key === "dayOfWeek" || key === "isoDate" || key === "unixEpoch" || key === "timeZone") return { kind: "time", key };
    return null;
  }
  return null;
}

export type PolicyExprValidationResult =
  | { ok: true; expr: PolicyExpr; usedPayloadPaths: string[] }
  | { ok: false; errorCode: "POLICY_EXPR_INVALID"; message: string };

export function validatePolicyExpr(input: unknown): PolicyExprValidationResult {
  const usedPayloadPaths = new Set<string>();

  const parseExpr = (v: unknown): PolicyExpr | null => {
    if (!isPlainObject(v)) return null;
    const op = String(v.op ?? "");
    if (op === "and" || op === "or") {
      const args = (v as any).args;
      if (!Array.isArray(args) || args.length === 0 || args.length > 50) return null;
      const out: PolicyExpr[] = [];
      for (const a of args) {
        const child = parseExpr(a);
        if (!child) return null;
        out.push(child);
      }
      return { op, args: out } as any;
    }
    if (op === "not") {
      const arg = parseExpr((v as any).arg);
      if (!arg) return null;
      return { op: "not", arg };
    }
    if (op === "eq") {
      const left = parseOperand((v as any).left);
      if (!left) return null;
      const rightRaw = (v as any).right;
      const rightOp = parseOperand(rightRaw);
      const rightLit = rightOp ? null : parseLiteral(rightRaw);
      if (!rightOp && rightLit === null) return null;
      if (left.kind === "payload") usedPayloadPaths.add(left.path);
      if (rightOp?.kind === "payload") usedPayloadPaths.add(rightOp.path);
      return { op: "eq", left, right: (rightOp ?? rightLit) as any };
    }
    if (op === "in") {
      const left = parseOperand((v as any).left);
      if (!left) return null;
      const right = (v as any).right;
      if (!isPlainObject(right) || String(right.kind ?? "") !== "list") return null;
      const values = (right as any).values;
      if (!Array.isArray(values) || values.length === 0 || values.length > 200) return null;
      const out: PolicyLiteral[] = [];
      for (const it of values) {
        const lit = parseLiteral(it);
        if (lit === null && it !== null) return null;
        out.push(lit);
      }
      if (left.kind === "payload") usedPayloadPaths.add(left.path);
      return { op: "in", left, right: { kind: "list", values: out } };
    }
    if (op === "exists") {
      const operand = parseOperand((v as any).operand);
      if (!operand) return null;
      if (operand.kind !== "payload") return null;
      usedPayloadPaths.add(operand.path);
      return { op: "exists", operand };
    }
    if (op === "gte" || op === "lte") {
      const left = parseOperand((v as any).left);
      if (!left) return null;
      const rightRaw = (v as any).right;
      const rightOp = parseOperand(rightRaw);
      const rightLit = rightOp ? null : parseLiteral(rightRaw);
      if (!rightOp && rightLit === null) return null;
      if (left.kind === "payload") usedPayloadPaths.add(left.path);
      if (rightOp?.kind === "payload") usedPayloadPaths.add(rightOp.path);
      return { op, left, right: (rightOp ?? rightLit) as any };
    }
    if (op === "between") {
      const operand = parseOperand((v as any).operand);
      if (!operand) return null;
      const low = parseLiteral((v as any).low);
      const high = parseLiteral((v as any).high);
      if (low === null || high === null) return null;
      if (operand.kind === "payload") usedPayloadPaths.add(operand.path);
      return { op: "between", operand, low, high };
    }
    if (op === "ip_in_cidr") {
      const operand = parseOperand((v as any).operand);
      if (!operand) return null;
      const cidrs = (v as any).cidrs;
      if (!Array.isArray(cidrs) || cidrs.length === 0 || cidrs.length > 100) return null;
      const out = cidrs.map(String).filter(Boolean);
      if (!out.length) return null;
      return { op: "ip_in_cidr", operand, cidrs: out };
    }
    if (op === "time_window") {
      const tz = String((v as any).timeZone ?? "UTC");
      const days = (v as any).days;
      if (!Array.isArray(days) || days.some((d: any) => typeof d !== "number")) return null;
      const startHour = String((v as any).startHour ?? "");
      const endHour = String((v as any).endHour ?? "");
      if (!startHour || !endHour) return null;
      return { op: "time_window", timeZone: tz, days: days.map(Number), startHour, endHour };
    }
    // v2: CEL 风格操作符
    if (op === "regex") {
      const operand = parseOperand((v as any).operand);
      if (!operand) return null;
      const pattern = String((v as any).pattern ?? "");
      if (!pattern) return null;
      // 安全检查: 限制正则复杂度
      if (pattern.length > 500) return null;
      const flags = String((v as any).flags ?? "");
      if (operand.kind === "payload") usedPayloadPaths.add(operand.path);
      return { op: "regex", operand, pattern, flags: flags || undefined };
    }
    if (op === "contains") {
      const operand = parseOperand((v as any).operand);
      if (!operand) return null;
      const value = String((v as any).value ?? "");
      if (!value) return null;
      if (operand.kind === "payload") usedPayloadPaths.add(operand.path);
      return { op: "contains", operand, value };
    }
    if (op === "starts_with") {
      const operand = parseOperand((v as any).operand);
      if (!operand) return null;
      const prefix = String((v as any).prefix ?? "");
      if (!prefix) return null;
      if (operand.kind === "payload") usedPayloadPaths.add(operand.path);
      return { op: "starts_with", operand, prefix };
    }
    if (op === "ends_with") {
      const operand = parseOperand((v as any).operand);
      if (!operand) return null;
      const suffix = String((v as any).suffix ?? "");
      if (!suffix) return null;
      if (operand.kind === "payload") usedPayloadPaths.add(operand.path);
      return { op: "ends_with", operand, suffix };
    }
    if (op === "gt" || op === "lt" || op === "neq") {
      const left = parseOperand((v as any).left);
      if (!left) return null;
      const rightRaw = (v as any).right;
      const rightOp = parseOperand(rightRaw);
      const rightLit = rightOp ? null : parseLiteral(rightRaw);
      if (!rightOp && rightLit === null) return null;
      if (left.kind === "payload") usedPayloadPaths.add(left.path);
      if (rightOp?.kind === "payload") usedPayloadPaths.add(rightOp.path);
      return { op, left, right: (rightOp ?? rightLit) as any };
    }
    if (op === "size") {
      const operand = parseOperand((v as any).operand);
      if (!operand) return null;
      const comparator = String((v as any).comparator ?? "");
      if (!["eq", "gt", "lt", "gte", "lte"].includes(comparator)) return null;
      const value = Number((v as any).value);
      if (!Number.isFinite(value)) return null;
      if (operand.kind === "payload") usedPayloadPaths.add(operand.path);
      return { op: "size", operand, comparator: comparator as any, value };
    }
    if (op === "hierarchy") {
      const operand = parseOperand((v as any).operand);
      if (!operand) return null;
      const ancestorValue = String((v as any).ancestorValue ?? "");
      if (!ancestorValue) return null;
      const separator = String((v as any).separator ?? "/");
      if (operand.kind === "payload") usedPayloadPaths.add(operand.path);
      return { op: "hierarchy", operand, ancestorValue, separator };
    }
    if (op === "attr_match") {
      const attributes = (v as any).attributes;
      if (!Array.isArray(attributes) || attributes.length === 0 || attributes.length > 20) return null;
      const parsed: Array<{ key: string; operand: PolicyOperand; value: PolicyLiteral }> = [];
      for (const attr of attributes) {
        const key = String(attr?.key ?? "");
        if (!key) return null;
        const operand = parseOperand(attr?.operand);
        if (!operand) return null;
        const value = parseLiteral(attr?.value);
        if (value === null && attr?.value !== null) return null;
        if (operand.kind === "payload") usedPayloadPaths.add(operand.path);
        parsed.push({ key, operand, value });
      }
      return { op: "attr_match", attributes: parsed };
    }
    return null;
  };

  const expr = parseExpr(input);
  if (!expr) return { ok: false, errorCode: "POLICY_EXPR_INVALID", message: "无效或不支持的 PolicyExpr" };
  return { ok: true, expr, usedPayloadPaths: Array.from(usedPayloadPaths) };
}

export type CompiledWhere = { sql: string; idx: number; usedPayloadPaths: string[] };

export function compilePolicyExprWhere(params: {
  expr: unknown;
  validated?: { expr: PolicyExpr; usedPayloadPaths: string[] };
  subject: { subjectId?: string | null; tenantId?: string | null; spaceId?: string | null };
  context?: any;
  args: any[];
  idxStart: number;
  ownerColumn?: string;
  payloadColumn?: string;
}): CompiledWhere {
  const validated = params.validated ?? validatePolicyExpr(params.expr);
  if (!validated || typeof validated !== "object" || (validated as any).ok === false) throw new Error("policy_violation:policy_expr_invalid");
  const expr = (validated as any).expr as PolicyExpr;
  const usedPayloadPaths = (validated as any).usedPayloadPaths as string[];

  const ownerCol = params.ownerColumn ?? "owner_subject_id";
  const payloadCol = params.payloadColumn ?? "payload";
  let idx = params.idxStart;

  const pushValue = (v: any) => {
    params.args.push(v);
    return `$${++idx}`;
  };
  const pushTextArray = (arr: string[]) => {
    params.args.push(arr);
    return `$${++idx}`;
  };

  const getContextValue = (path: string) => {
    if (path === "subject.id") return params.subject.subjectId ?? null;
    if (path === "subject.type") return (params.context && typeof params.context === "object" && (params.context as any)?.subject?.type) ? String((params.context as any).subject.type) : "user";
    if (path === "tenant.id") return params.subject.tenantId ?? null;
    if (path === "space.id") return params.subject.spaceId ?? null;
    if (path === "resource.ownerSubjectId") return "__COLUMN_OWNER__";
    const segs = parseContextPath(path);
    if (!segs) throw new Error("policy_violation:policy_expr_invalid");
    let cur: any = params.context;
    for (const s of segs) {
      if (!cur || typeof cur !== "object") return null;
      cur = cur[s];
    }
    if (cur === null || cur === undefined) return null;
    const t = typeof cur;
    if (t === "string" || t === "number" || t === "boolean") return String(cur);
    return null;
  };

  const resolveEnvValue = (key: string): string | null => {
    const ctx = params.context;
    if (!ctx || typeof ctx !== "object") return null;
    const env = (ctx as any).env;
    if (!env || typeof env !== "object") return null;
    const v = env[key];
    if (v === null || v === undefined) return null;
    return String(v);
  };

  const resolveTimeValue = (key: string): string | null => {
    const now = new Date();
    if (key === "hourOfDay") return String(now.getHours());
    if (key === "dayOfWeek") return String(now.getDay());
    if (key === "isoDate") return now.toISOString().slice(0, 10);
    if (key === "unixEpoch") return String(Math.floor(now.getTime() / 1000));
    if (key === "timeZone") return Intl.DateTimeFormat().resolvedOptions().timeZone;
    return null;
  };

  const operandSql = (o: PolicyOperand): string => {
    if (o.kind === "record") {
      if (o.key === "ownerSubjectId") return ownerCol;
      throw new Error("policy_violation:policy_expr_invalid");
    }
    if (o.kind === "subject") {
      const v =
        o.key === "subjectId"
          ? params.subject.subjectId
          : o.key === "tenantId"
            ? params.subject.tenantId
            : params.subject.spaceId;
      if (!v) throw new Error("policy_violation:missing_subject_id");
      return `${pushValue(v)}::text`;
    }
    if (o.kind === "context") {
      const v = getContextValue(o.path);
      if (v === "__COLUMN_OWNER__") return ownerCol;
      if (v === null) return "NULL";
      return `${pushValue(v)}::text`;
    }
    if (o.kind === "env") {
      const v = resolveEnvValue(o.key);
      if (v === null) return "NULL";
      return `${pushValue(v)}::text`;
    }
    if (o.kind === "time") {
      const v = resolveTimeValue(o.key);
      if (v === null) return "NULL";
      return `${pushValue(v)}::text`;
    }
    if (o.kind === "payload") {
      const segs = parsePayloadPath(o.path);
      if (!segs) throw new Error("policy_violation:row_filter_field_invalid");
      const pathParam = pushTextArray(segs);
      return `(${payloadCol} #>> ${pathParam}::text[])`;
    }
    throw new Error("policy_violation:policy_expr_invalid");
  };

  const literalSql = (v: PolicyLiteral): string => {
    if (v === null) return "NULL";
    return `${pushValue(String(v))}::text`;
  };

  /**
   * Detect whether a comparison should use numeric semantics.
   * Numeric when: (a) right-side literal is a number, or
   *               (b) either operand is time.hourOfDay / time.dayOfWeek / time.unixEpoch.
   */
  const isNumericCompare = (left: PolicyOperand, right: PolicyOperand | PolicyLiteral): boolean => {
    if (!isPlainObject(right) && typeof right === "number") return true;
    if (left.kind === "time" && (left.key === "hourOfDay" || left.key === "dayOfWeek" || left.key === "unixEpoch")) return true;
    if (isPlainObject(right)) {
      const ro = right as PolicyOperand;
      if (ro.kind === "time" && (ro.key === "hourOfDay" || ro.key === "dayOfWeek" || ro.key === "unixEpoch")) return true;
    }
    return false;
  };
  const numCast = (sql: string) => `NULLIF((${sql})::text, '')::numeric`;

  /** Simple IPv4 CIDR check (compile-time evaluation). */
  const ipToLong = (ip: string): number => {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return -1;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  };
  const isIpInCidr = (ip: string, cidr: string): boolean => {
    const [network, prefixStr] = cidr.split("/");
    const prefix = parseInt(prefixStr ?? "32", 10);
    if (prefix < 0 || prefix > 32) return false;
    const ipL = ipToLong(ip);
    const netL = ipToLong(network);
    if (ipL < 0 || netL < 0) return false;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipL & mask) === (netL & mask);
  };

  const compile = (e: PolicyExpr): string => {
    if (e.op === "and") return `(${e.args.map((x) => `(${compile(x)})`).join(" AND ")})`;
    if (e.op === "or") return `(${e.args.map((x) => `(${compile(x)})`).join(" OR ")})`;
    if (e.op === "not") return `(NOT (${compile(e.arg)}))`;
    if (e.op === "exists") {
      const op = e.operand;
      if (op.kind !== "payload") throw new Error("policy_violation:policy_expr_invalid");
      const segs = parsePayloadPath(op.path);
      if (!segs) throw new Error("policy_violation:row_filter_field_invalid");
      const pathParam = pushTextArray(segs);
      return `(${payloadCol} #> ${pathParam}::text[]) IS NOT NULL`;
    }
    if (e.op === "eq") {
      const left = operandSql(e.left);
      const right = isPlainObject(e.right) ? operandSql(e.right as any) : literalSql(e.right as any);
      return `(${left})::text = (${right})::text`;
    }
    if (e.op === "in") {
      const left = operandSql(e.left);
      const values = e.right.values.map((v) => (v === null ? null : String(v))).filter((v) => v !== null) as string[];
      if (values.length === 0) return "FALSE";
      const listParam = pushValue(values);
      return `(${left})::text = ANY(${listParam}::text[])`;
    }
    if (e.op === "gte") {
      const left = operandSql(e.left);
      const right = isPlainObject(e.right) ? operandSql(e.right as any) : literalSql(e.right as any);
      if (isNumericCompare(e.left, e.right)) return `${numCast(left)} >= ${numCast(right)}`;
      return `(${left})::text >= (${right})::text`;
    }
    if (e.op === "lte") {
      const left = operandSql(e.left);
      const right = isPlainObject(e.right) ? operandSql(e.right as any) : literalSql(e.right as any);
      if (isNumericCompare(e.left, e.right)) return `${numCast(left)} <= ${numCast(right)}`;
      return `(${left})::text <= (${right})::text`;
    }
    if (e.op === "between") {
      const opSql = operandSql(e.operand);
      const low = literalSql(e.low);
      const high = literalSql(e.high);
      const numericCtx = typeof e.low === "number" || typeof e.high === "number"
        || (e.operand.kind === "time" && (e.operand.key === "hourOfDay" || e.operand.key === "dayOfWeek" || e.operand.key === "unixEpoch"));
      if (numericCtx) return `${numCast(opSql)} >= ${numCast(low)} AND ${numCast(opSql)} <= ${numCast(high)}`;
      return `(${opSql})::text >= (${low})::text AND (${opSql})::text <= (${high})::text`;
    }
    if (e.op === "ip_in_cidr") {
      // Compile-time evaluation: resolve client IP from context and check against CIDRs
      const envIp = resolveEnvValue("ip");
      if (envIp && envIp.includes(".")) {
        const match = e.cidrs.some((cidr) => isIpInCidr(envIp, cidr));
        return match ? "TRUE" : "FALSE";
      }
      // No IP context available — permissive fallback
      return "TRUE";
    }
    if (e.op === "time_window") {
      // Compile-time evaluation: resolve current time and check window
      const now = new Date();
      let hour: number;
      try {
        const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: e.timeZone || "UTC" }).format(now);
        hour = parseInt(parts, 10);
      } catch {
        hour = now.getUTCHours();
      }
      let dow: number;
      try {
        dow = parseInt(new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: e.timeZone || "UTC" }).format(now), 10);
        if (isNaN(dow)) dow = now.getDay();
      } catch {
        dow = now.getDay();
      }
      const dayOk = !e.days || e.days.length === 0 || e.days.includes(dow);
      const sh = parseInt(e.startHour, 10);
      const eh = parseInt(e.endHour, 10);
      const hourOk = sh <= eh ? (hour >= sh && hour < eh) : (hour >= sh || hour < eh);
      return dayOk && hourOk ? "TRUE" : "FALSE";
    }
    // v2: CEL 风格操作符编译
    if (e.op === "regex") {
      const opSql = operandSql(e.operand);
      const patternParam = pushValue(e.pattern);
      return `(${opSql})::text ~ ${patternParam}`;
    }
    if (e.op === "contains") {
      const opSql = operandSql(e.operand);
      const valueParam = pushValue(`%${e.value}%`);
      return `(${opSql})::text ILIKE ${valueParam}`;
    }
    if (e.op === "starts_with") {
      const opSql = operandSql(e.operand);
      const prefixParam = pushValue(`${e.prefix}%`);
      return `(${opSql})::text ILIKE ${prefixParam}`;
    }
    if (e.op === "ends_with") {
      const opSql = operandSql(e.operand);
      const suffixParam = pushValue(`%${e.suffix}`);
      return `(${opSql})::text ILIKE ${suffixParam}`;
    }
    if (e.op === "gt") {
      const left = operandSql(e.left);
      const right = isPlainObject(e.right) ? operandSql(e.right as any) : literalSql(e.right as any);
      if (isNumericCompare(e.left, e.right)) return `${numCast(left)} > ${numCast(right)}`;
      return `(${left})::text > (${right})::text`;
    }
    if (e.op === "lt") {
      const left = operandSql(e.left);
      const right = isPlainObject(e.right) ? operandSql(e.right as any) : literalSql(e.right as any);
      if (isNumericCompare(e.left, e.right)) return `${numCast(left)} < ${numCast(right)}`;
      return `(${left})::text < (${right})::text`;
    }
    if (e.op === "neq") {
      const left = operandSql(e.left);
      const right = isPlainObject(e.right) ? operandSql(e.right as any) : literalSql(e.right as any);
      return `(${left})::text <> (${right})::text`;
    }
    if (e.op === "size") {
      const opSql = operandSql(e.operand);
      const sizeExpr = `jsonb_array_length((${opSql})::jsonb)`;
      const valParam = pushValue(e.value);
      const cmp = e.comparator;
      const op = cmp === "eq" ? "=" : cmp === "gt" ? ">" : cmp === "lt" ? "<" : cmp === "gte" ? ">=" : "<=";
      return `${sizeExpr} ${op} ${valParam}::int`;
    }
    if (e.op === "hierarchy") {
      // 层级匹配: 检查值是否以 ancestorValue 开头 (路径分隔符)
      const opSql = operandSql(e.operand);
      const sep = e.separator ?? "/";
      const prefixParam = pushValue(`${e.ancestorValue}${sep}%`);
      const exactParam = pushValue(e.ancestorValue);
      return `((${opSql})::text = ${exactParam} OR (${opSql})::text LIKE ${prefixParam})`;
    }
    if (e.op === "attr_match") {
      // ABAC 属性匹配: 所有属性均匹配
      const conditions = e.attributes.map(attr => {
        const opSql = operandSql(attr.operand);
        const valParam = literalSql(attr.value);
        return `(${opSql})::text = (${valParam})::text`;
      });
      return `(${conditions.join(" AND ")})`;
    }
    throw new Error("policy_violation:policy_expr_invalid");
  };

  return { sql: compile(expr), idx, usedPayloadPaths };
}
