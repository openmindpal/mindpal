export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function toDisplayText(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function stringField(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string" ? (record[key] as string) : undefined;
}

export function numberField(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "number" ? (record[key] as number) : undefined;
}
