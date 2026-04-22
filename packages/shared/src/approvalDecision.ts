/**
 * 统一审批判定函数（Single Source of Truth）。
 * API 和 Worker 共用，确保全链路审批策略一致。
 *
 * 分级策略：
 * - kernel 工具：免审批（OS内核原语，始终可信）
 * - builtin + scope=read + riskLevel=low：免审批
 * - 其他：按 approvalRequired / riskLevel 判定
 */
export function shouldRequireApproval(toolDef: {
  approvalRequired?: boolean;
  riskLevel?: string;
  sourceLayer?: string;
  scope?: string | null;
}): boolean {
  const layer = toolDef.sourceLayer ?? "extension";
  // kernel 内核原语：始终免审批
  if (layer === "kernel") return false;
  // builtin 只读低风险：免审批
  if (layer === "builtin" && toolDef.scope === "read" && (toolDef.riskLevel ?? "low") === "low") return false;
  // 标准判定
  return Boolean(toolDef.approvalRequired) || toolDef.riskLevel === "high";
}
