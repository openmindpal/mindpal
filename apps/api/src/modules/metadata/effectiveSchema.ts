import type { PolicyDecision } from "@openslin/shared";
import type { SchemaDef } from "./schemaModel";

function allowAll(allow: string[] | undefined) {
  return Boolean(allow?.includes("*"));
}

export function buildEffectiveEntitySchema(params: {
  schema: SchemaDef;
  entityName: string;
  decision: PolicyDecision;
}) {
  const entity = params.schema.entities?.[params.entityName];
  if (!entity) return null;

  const readAllow = params.decision.fieldRules?.read?.allow;
  const readDeny = params.decision.fieldRules?.read?.deny ?? [];
  const writeAllow = params.decision.fieldRules?.write?.allow;
  const writeDeny = params.decision.fieldRules?.write?.deny ?? [];

  const fields: Record<string, any> = {};
  for (const [name, def] of Object.entries(entity.fields ?? {})) {
    if (readDeny.includes(name)) continue;
    if (readAllow && readAllow.length > 0 && !allowAll(readAllow) && !readAllow.includes(name)) continue;

    const writable =
      !writeDeny.includes(name) &&
      (!writeAllow || writeAllow.length === 0 || allowAll(writeAllow) || writeAllow.includes(name));

    fields[name] = { ...def, writable };
  }

  return {
    schemaName: params.schema.name,
    schemaVersion: params.schema.version,
    entityName: params.entityName,
    displayName: entity.displayName,
    description: entity.description,
    fields,
  };
}

