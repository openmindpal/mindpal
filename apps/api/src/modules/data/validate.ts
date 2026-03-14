import type { SchemaDef } from "../metadata/schemaModel";

type ValidationError = { ok: false; reason: string };
type ValidationOk = { ok: true };

export type ValidationResult = ValidationOk | ValidationError;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function checkType(type: string, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "datetime":
      return typeof value === "string";
    case "json":
      return true;
    default:
      return false;
  }
}

export function validateEntityPayload(params: {
  schema: SchemaDef;
  entityName: string;
  payload: unknown;
}): ValidationResult {
  const entity = params.schema.entities?.[params.entityName];
  if (!entity) return { ok: false, reason: `未知实体：${params.entityName}` };
  if (!isPlainObject(params.payload)) return { ok: false, reason: "payload 必须是对象" };

  const fields = entity.fields ?? {};
  for (const [fieldName, def] of Object.entries(fields)) {
    const v = (params.payload as any)[fieldName];
    if (def.required && (v === undefined || v === null)) {
      return { ok: false, reason: `缺少必填字段：${fieldName}` };
    }
    if (v !== undefined && !checkType(def.type, v)) {
      return { ok: false, reason: `字段类型错误：${fieldName}` };
    }
  }

  return { ok: true };
}

