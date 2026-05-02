/**
 * typeCheck.ts — 统一字段类型校验（消除 API / Worker 多处克隆）
 */

/**
 * 校验值是否符合声明的字段类型。
 * null / undefined 视为"未填写"，始终通过（由 required 逻辑在调用侧处理）。
 */
export function checkType(type: string, value: unknown): boolean {
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
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    default:
      return false;
  }
}
