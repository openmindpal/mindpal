import type { SchemaDef } from "./schemaModel";

type CompatResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

function getNextVersion(prev: SchemaDef, next: SchemaDef) {
  const nextVersion = Number((next as any)?.version);
  if (Number.isFinite(nextVersion) && nextVersion > 0) return nextVersion;
  const prevVersion = Number((prev as any)?.version);
  if (Number.isFinite(prevVersion) && prevVersion > 0) return prevVersion + 1;
  return null;
}

function getDeprecatedWindow(field: any) {
  const meta = field?.deprecated;
  if (!meta) return null;
  if (meta === true) return { removeAfterVersion: null as number | null };
  if (typeof meta !== "object") return null;
  const removeAfter = Number((meta as any).removeAfterVersion);
  return { removeAfterVersion: Number.isFinite(removeAfter) ? removeAfter : null };
}

export function checkSchemaCompatibility(prev: SchemaDef | null, next: SchemaDef): CompatResult {
  if (!prev) return { ok: true };

  const prevEntities = prev.entities ?? {};
  const nextEntities = next.entities ?? {};
  const nextVersion = getNextVersion(prev, next);

  for (const [entityName, prevEntity] of Object.entries(prevEntities)) {
    const nextEntity = nextEntities[entityName];
    if (!nextEntity) return { ok: false, code: "ENTITY_REMOVED", reason: `实体被删除：${entityName}` };

    for (const [fieldName, prevField] of Object.entries(prevEntity.fields ?? {})) {
      const nextField = nextEntity.fields?.[fieldName];
      if (!nextField) {
        const window = getDeprecatedWindow(prevField);
        if (!window) {
          return { ok: false, code: "FIELD_REMOVED_WITHOUT_DEPRECATION", reason: `字段移除前必须先标记 deprecated：${entityName}.${fieldName}` };
        }
        if (!window.removeAfterVersion || !nextVersion || nextVersion < window.removeAfterVersion) {
          return {
            ok: false,
            code: "FIELD_REMOVAL_WINDOW_NOT_REACHED",
            reason: `字段移除窗口未满足：${entityName}.${fieldName}`,
          };
        }
        continue;
      }
      if (nextField.type !== prevField.type) {
        return {
          ok: false,
          code: "FIELD_TYPE_CHANGED",
          reason: `字段类型变更：${entityName}.${fieldName} (${prevField.type} -> ${nextField.type})`,
        };
      }
      const prevRequired = Boolean(prevField.required);
      const nextRequired = Boolean(nextField.required);
      if (prevRequired !== nextRequired && nextRequired) {
        return { ok: false, code: "FIELD_REQUIRED_UPGRADED", reason: `字段由可选变为必填：${entityName}.${fieldName}` };
      }
    }
  }

  for (const [entityName, nextEntity] of Object.entries(nextEntities)) {
    const prevEntity = prevEntities[entityName];
    if (!prevEntity) continue;
    for (const [fieldName, nextField] of Object.entries(nextEntity.fields ?? {})) {
      const prevField = prevEntity.fields?.[fieldName];
      if (!prevField && nextField.required) {
        return { ok: false, code: "FIELD_REQUIRED_ADDED", reason: `新增必填字段：${entityName}.${fieldName}` };
      }
    }
  }

  return { ok: true };
}
