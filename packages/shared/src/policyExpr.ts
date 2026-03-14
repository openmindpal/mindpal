export type PolicyLiteral = string | number | boolean | null;

export type PolicyOperand =
  | { kind: "subject"; key: "subjectId" | "tenantId" | "spaceId" }
  | { kind: "record"; key: "ownerSubjectId" }
  | { kind: "payload"; path: string }
  | { kind: "context"; path: string };

export type PolicyExpr =
  | { op: "and"; args: PolicyExpr[] }
  | { op: "or"; args: PolicyExpr[] }
  | { op: "not"; arg: PolicyExpr }
  | { op: "eq"; left: PolicyOperand; right: PolicyOperand | PolicyLiteral }
  | { op: "in"; left: PolicyOperand; right: { kind: "list"; values: PolicyLiteral[] } }
  | { op: "exists"; operand: PolicyOperand };

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
      ],
    },
  },
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

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
    p === "resource.ownerSubjectId"
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
    const segs = parsePayloadPath(o.path);
    if (!segs) throw new Error("policy_violation:row_filter_field_invalid");
    const pathParam = pushTextArray(segs);
    return `(${payloadCol} #>> ${pathParam}::text[])`;
  };

  const literalSql = (v: PolicyLiteral): string => {
    if (v === null) return "NULL";
    return `${pushValue(String(v))}::text`;
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
    throw new Error("policy_violation:policy_expr_invalid");
  };

  return { sql: compile(expr), idx, usedPayloadPaths };
}
