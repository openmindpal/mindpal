/**
 * 快速同步审批判定（仅基于工具静态声明，不查询规则引擎）。
 *
 * 注意：此函数不是审批决策的单一真相源。
 * 完整的审批决策由 API 侧 assessToolExecutionRisk() 负责，
 * 该函数会叠加 approval_rules 表中的动态规则。
 *
 * 本函数仅用于：
 * - Worker 侧降级兜底（当 API 侧预检结果不可用时）
 * - 快速路径跳过（kernel 工具、builtin 只读低风险无需查库）
 *
 * 分级策略：
 * - kernel 工具：免审批（OS内核原语，始终可信）
 * - builtin + scope=read + riskLevel=low：免审批
 * - 其他：按 approvalRequired / riskLevel 判定
 */
/**
 * @deprecated 使用 API 侧 approvalRuleEngine.assessToolExecutionRisk() 代替。
 * 此函数仅基于工具静态元数据做快速判定，不含动态规则库评估。
 * 仅在无 DB 上下文的降级场景（如 Worker 兜底）中使用。
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
