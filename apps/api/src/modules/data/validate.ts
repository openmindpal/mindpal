import type { SchemaDef } from "../metadata/schemaModel";
import type { Pool, PoolClient } from "pg";
import { isPlainObject } from "@openslin/shared";

type ValidationError = { ok: false; reason: string };
type ValidationOk = { ok: true };

export type ValidationResult = ValidationOk | ValidationError;

/* ================================================================== */
/*  Custom Field Validator Framework                                    */
/* ================================================================== */

/**
 * 自定义字段验证器接口 —— 支持跨字段依赖校验（如条件必填逻辑）
 */
export interface FieldValidator {
  /** 验证器名称（唯一标识） */
  name: string;
  /** 执行验证，返回错误列表（空代表通过） */
  validate(value: unknown, record: Record<string, unknown>, schema: SchemaDef): ValidationError[];
}

/**
 * 验证器注册表 —— 支持按 entityType + fieldName 注册自定义验证器
 */
export class ValidatorRegistry {
  private registry = new Map<string, FieldValidator[]>();

  private key(entityType: string, fieldName: string): string {
    return `${entityType}::${fieldName}`;
  }

  /** 注册验证器到指定实体类型的指定字段 */
  register(entityType: string, fieldName: string, validator: FieldValidator): void {
    const k = this.key(entityType, fieldName);
    const list = this.registry.get(k) ?? [];
    // 防止重复注册同名验证器
    if (list.some(v => v.name === validator.name)) return;
    list.push(validator);
    this.registry.set(k, list);
  }

  /** 对整条记录执行所有已注册验证器 */
  validateAll(entityType: string, record: Record<string, unknown>, schema: SchemaDef): ValidationError[] {
    const errors: ValidationError[] = [];
    for (const [k, validators] of this.registry.entries()) {
      if (!k.startsWith(`${entityType}::`)) continue;
      const fieldName = k.slice(entityType.length + 2);
      const value = record[fieldName];
      for (const validator of validators) {
        const fieldErrors = validator.validate(value, record, schema);
        errors.push(...fieldErrors);
      }
    }
    return errors;
  }
}

/** 全局单例验证器注册表 */
export const globalValidatorRegistry = new ValidatorRegistry();

/**
 * 内置跨字段验证器：条件必填
 * 当 dependsOnField 有值时，目标字段必填
 */
export function createConditionalRequiredValidator(params: {
  /** 验证器名称 */
  name?: string;
  /** 依赖字段（当此字段有值时触发必填） */
  dependsOnField: string;
  /** 目标字段名（当依赖字段有值时此字段必填） */
  targetField: string;
}): FieldValidator {
  return {
    name: params.name ?? `conditionalRequired:${params.dependsOnField}->${params.targetField}`,
    validate(value: unknown, record: Record<string, unknown>, _schema: SchemaDef): ValidationError[] {
      const dependsValue = record[params.dependsOnField];
      const hasDepends = dependsValue !== undefined && dependsValue !== null && dependsValue !== "";
      if (hasDepends) {
        const targetValue = record[params.targetField];
        if (targetValue === undefined || targetValue === null || targetValue === "") {
          return [{ ok: false, reason: `当 ${params.dependsOnField} 有值时，${params.targetField} 为必填字段` }];
        }
      }
      return [];
    },
  };
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
    case "reference":
      return typeof value === "string";
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

  // 集成自定义验证器注册表
  const customErrors = globalValidatorRegistry.validateAll(
    params.entityName,
    params.payload as Record<string, unknown>,
    params.schema,
  );
  if (customErrors.length > 0) {
    return customErrors[0];
  }

  return { ok: true };
}

/**
 * Validate that all reference fields point to existing entity_records.
 * Called during create/update to enforce referential integrity.
 */
export async function validateReferenceFields(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string | null;
  schema: SchemaDef;
  entityName: string;
  payload: Record<string, unknown>;
}): Promise<ValidationResult> {
  const entity = params.schema.entities?.[params.entityName];
  if (!entity) return { ok: true };
  const fields = entity.fields ?? {};
  for (const [fieldName, def] of Object.entries(fields)) {
    if (def.type !== "reference") continue;
    const refEntity = (def as any).referenceEntity;
    if (!refEntity) continue;
    const value = params.payload[fieldName];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return { ok: false, reason: `字段 ${fieldName} 必须是字符串（引用 ID）` };
    const res = await params.pool.query(
      "SELECT 1 FROM entity_records WHERE tenant_id = $1 AND ($2::text IS NULL OR space_id = $2) AND entity_name = $3 AND id = $4::uuid LIMIT 1",
      [params.tenantId, params.spaceId ?? null, refEntity, value],
    );
    if (!res.rowCount) {
      return { ok: false, reason: `字段 ${fieldName} 引用的 ${refEntity} 记录不存在：${value}` };
    }
  }
  return { ok: true };
}

