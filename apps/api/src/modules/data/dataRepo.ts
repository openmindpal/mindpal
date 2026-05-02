import type { Pool, PoolClient } from "pg";
import { compilePolicyExprWhere, validatePolicyExpr, compileRowFiltersWhere } from "@mindpal/shared";

export type EntityRecord = {
  id: string;
  tenantId: string;
  spaceId: string | null;
  entityName: string;
  schemaName: string;
  schemaVersion: number;
  payload: any;
  ownerSubjectId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

function rowToRecord(r: any): EntityRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    entityName: r.entity_name,
    schemaName: r.schema_name,
    schemaVersion: r.schema_version,
    payload: r.payload,
    ownerSubjectId: r.owner_subject_id ?? null,
    revision: r.revision,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

function isSafeFieldName(name: string) {
  if (!name) return false;
  if (name.length > 100) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

export async function listRecords(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  limit: number;
  subjectId?: string;
  rowFilters?: any;
  policyContext?: any;
}) {
  const args: any[] = [params.tenantId, params.spaceId ?? null, params.entityName];
  const where: string[] = ["tenant_id = $1", "($2::text IS NULL OR space_id = $2)", "entity_name = $3"];
  let idx = 3;
  const rf = compileRowFiltersWhere(
    { rowFilters: params.rowFilters, subject: { subjectId: params.subjectId ?? null, tenantId: params.tenantId, spaceId: params.spaceId ?? null }, context: params.policyContext ?? null },
    args,
    idx,
  );
  idx = rf.idx;
  if (rf.sql !== "TRUE") where.push(rf.sql);
  args.push(params.limit);
  const res = await params.pool.query(
    `
      SELECT *
      FROM entity_records
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${++idx}
    `,
    args,
  );
  return res.rows.map(rowToRecord);
}

export async function getRecord(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  id: string;
  subjectId?: string;
  rowFilters?: any;
  policyContext?: any;
}) {
  const args: any[] = [params.tenantId, params.spaceId ?? null, params.entityName, params.id];
  const where: string[] = ["tenant_id = $1", "($2::text IS NULL OR space_id = $2)", "entity_name = $3", "id = $4"];
  let idx = 4;
  const rf = compileRowFiltersWhere(
    { rowFilters: params.rowFilters, subject: { subjectId: params.subjectId ?? null, tenantId: params.tenantId, spaceId: params.spaceId ?? null }, context: params.policyContext ?? null },
    args,
    idx,
  );
  idx = rf.idx;
  if (rf.sql !== "TRUE") where.push(rf.sql);
  const res = await params.pool.query(
    `
      SELECT *
      FROM entity_records
      WHERE ${where.join(" AND ")}
      LIMIT 1
    `,
    args,
  );
  if (res.rowCount === 0) return null;
  return rowToRecord(res.rows[0]);
}

export async function insertRecord(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  schemaName: string;
  schemaVersion: number;
  payload: any;
  ownerSubjectId: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO entity_records (tenant_id, space_id, entity_name, schema_name, schema_version, payload, owner_subject_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
      params.entityName,
      params.schemaName,
      params.schemaVersion,
      params.payload,
      params.ownerSubjectId,
    ],
  );
  return rowToRecord(res.rows[0]);
}

export async function updateRecord(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  id: string;
  patch: any;
  expectedRevision?: number;
  subjectId?: string;
  rowFilters?: any;
  policyContext?: any;
}) {
  const args: any[] = [
    params.tenantId,
    params.spaceId ?? null,
    params.entityName,
    params.id,
    params.patch,
    params.expectedRevision ?? null,
  ];
  const where: string[] = [
    "tenant_id = $1",
    "($2::text IS NULL OR space_id = $2)",
    "entity_name = $3",
    "id = $4",
    "($6::int IS NULL OR revision = $6)",
  ];
  let idx = 6;
  const rf = compileRowFiltersWhere(
    { rowFilters: params.rowFilters, subject: { subjectId: params.subjectId ?? null, tenantId: params.tenantId, spaceId: params.spaceId ?? null }, context: params.policyContext ?? null },
    args,
    idx,
  );
  idx = rf.idx;
  if (rf.sql !== "TRUE") where.push(rf.sql);
  const res = await params.pool.query(
    `
      UPDATE entity_records
      SET payload = payload || $5::jsonb,
          revision = revision + 1,
          updated_at = now()
      WHERE ${where.join(" AND ")}
      RETURNING *
    `,
    args,
  );
  if (res.rowCount === 0) return null;
  return rowToRecord(res.rows[0]);
}

export async function deleteRecord(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  id: string;
  subjectId?: string;
  rowFilters?: any;
  policyContext?: any;
}) {
  const args: any[] = [params.tenantId, params.spaceId ?? null, params.entityName, params.id];
  const where: string[] = ["tenant_id = $1", "($2::text IS NULL OR space_id = $2)", "entity_name = $3", "id = $4"];
  let idx = 4;
  const rf = compileRowFiltersWhere(
    { rowFilters: params.rowFilters, subject: { subjectId: params.subjectId ?? null, tenantId: params.tenantId, spaceId: params.spaceId ?? null }, context: params.policyContext ?? null },
    args,
    idx,
  );
  idx = rf.idx;
  if (rf.sql !== "TRUE") where.push(rf.sql);
  const res = await params.pool.query(
    `
      DELETE FROM entity_records
      WHERE ${where.join(" AND ")}
      RETURNING *
    `,
    args,
  );
  if (res.rowCount === 0) return null;
  return rowToRecord(res.rows[0]);
}

function compileFilters(params: {
  expr: any;
  idxStart: number;
  args: any[];
  fieldTypes: Record<string, string>;
}) {
  let idx = params.idxStart;
  const args = params.args;
  const types = params.fieldTypes;

  const fieldExpr = (field: string) => {
    args.push(field);
    return `(payload->>$${++idx})`;
  };

  const typedExpr = (field: string) => {
    const base = fieldExpr(field);
    const t = types[field];
    if (t === "number") return `NULLIF(${base}, '')::numeric`;
    if (t === "datetime") return `NULLIF(${base}, '')::timestamptz`;
    if (t === "boolean") return `NULLIF(${base}, '')::boolean`;
    return base;
  };

  const pushValue = (value: any) => {
    args.push(value);
    return `$${++idx}`;
  };

  const compileCond = (e: any) => {
    const field = String(e.field ?? "");
    const op = String(e.op ?? "");
    const value = (e as any).value;
    if (!field || !op) return "TRUE";

    if (op === "eq") {
      const left = typedExpr(field);
      const right = pushValue(value);
      const t = types[field];
      if (t === "number") return `${left} = ${right}::numeric`;
      if (t === "datetime") return `${left} = ${right}::timestamptz`;
      if (t === "boolean") return `${left} = ${right}::boolean`;
      return `${left} = ${right}::text`;
    }

    if (op === "contains") {
      const left = typedExpr(field);
      const right = pushValue(String(value ?? ""));
      return `${left} ILIKE '%' || ${right}::text || '%'`;
    }

    if (op === "in") {
      if (!Array.isArray(value) || value.length === 0) throw new Error("in_value_invalid");
      const left = typedExpr(field);
      const right = pushValue(value);
      const t = types[field];
      if (t === "number") return `${left} = ANY(${right}::numeric[])`;
      if (t === "datetime") return `${left} = ANY(${right}::timestamptz[])`;
      if (t === "boolean") return `${left} = ANY(${right}::boolean[])`;
      return `${left} = ANY(${right}::text[])`;
    }

    if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
      const left = typedExpr(field);
      const right = pushValue(value);
      const t = types[field];
      const opSql = op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
      if (t === "number") return `${left} ${opSql} ${right}::numeric`;
      if (t === "datetime") return `${left} ${opSql} ${right}::timestamptz`;
      return "TRUE";
    }

    return "TRUE";
  };

  const compile = (e: any): string => {
    if (!e) return "TRUE";
    if (e.and && Array.isArray(e.and)) return `(${e.and.map((x: any) => compile(x)).join(" AND ")})`;
    if (e.or && Array.isArray(e.or)) return `(${e.or.map((x: any) => compile(x)).join(" OR ")})`;
    return compileCond(e);
  };

  return { sql: compile(params.expr), idx, args };
}

/**
 * 通过记录 ID 查找该记录的 entity_name。
 * 用于 LLM 生成的工具调用缺少 entityName 时的自动推断。
 */
export async function lookupEntityNameByRecordId(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  id: string;
}): Promise<string | null> {
  const res = await params.pool.query(
    `SELECT entity_name FROM entity_records 
     WHERE tenant_id = $1 AND ($2::text IS NULL OR space_id = $2) AND id = $3 
     LIMIT 1`,
    [params.tenantId, params.spaceId ?? null, params.id],
  );
  return res.rows[0]?.entity_name ?? null;
}

export async function queryRecords(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  limit: number;
  filters?: any;
  orderBy?: { field: string; direction: "asc" | "desc" }[];
  cursor?: { updatedAt: string; id: string };
  select?: string[];
  fieldTypes: Record<string, string>;
  subjectId?: string;
  rowFilters?: any;
  policyContext?: any;
}) {
  const args: any[] = [params.tenantId, params.spaceId ?? null, params.entityName];
  let idx = 3;
  const where: string[] = [
    "tenant_id = $1",
    "($2::text IS NULL OR space_id = $2)",
    "entity_name = $3",
  ];
  const rf = compileRowFiltersWhere(
    { rowFilters: params.rowFilters, subject: { subjectId: params.subjectId ?? null, tenantId: params.tenantId, spaceId: params.spaceId ?? null }, context: params.policyContext ?? null },
    args,
    idx,
  );
  idx = rf.idx;
  if (rf.sql !== "TRUE") where.push(rf.sql);

  if (params.filters) {
    const c = compileFilters({ expr: params.filters, idxStart: idx, args, fieldTypes: params.fieldTypes });
    idx = c.idx;
    where.push(c.sql);
  }

  const order = params.orderBy && params.orderBy.length ? params.orderBy : [{ field: "updatedAt", direction: "desc" as const }];
  const orderSql = order
    .map((o) => {
      if (o.field === "updatedAt") return `updated_at ${o.direction.toUpperCase()}`;
      if (o.field === "createdAt") return `created_at ${o.direction.toUpperCase()}`;
      if (o.field === "id") return `id ${o.direction.toUpperCase()}`;
      const t = params.fieldTypes[o.field];
      args.push(o.field);
      const base = `(payload->>$${++idx})`;
      const expr =
        t === "number"
          ? `NULLIF(${base}, '')::numeric`
          : t === "datetime"
            ? `NULLIF(${base}, '')::timestamptz`
            : t === "boolean"
              ? `NULLIF(${base}, '')::boolean`
              : base;
      return `${expr} ${o.direction.toUpperCase()}`;
    })
    .join(", ");

  if (params.cursor) {
    args.push(params.cursor.updatedAt);
    args.push(params.cursor.id);
    where.push(`(updated_at, id) < ($${++idx}::timestamptz, $${++idx}::uuid)`);
  }

  args.push(params.limit + 1);
  const sql = `
    SELECT *
    FROM entity_records
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderSql}, id DESC
    LIMIT $${++idx}
  `;

  const res = await params.pool.query(sql, args);
  const rows = res.rows.map(rowToRecord);
  const hasMore = rows.length > params.limit;
  const items = hasMore ? rows.slice(0, params.limit) : rows;
  const last = items.length ? items[items.length - 1] : null;
  const nextCursor = hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null;
  return { items, nextCursor };
}
