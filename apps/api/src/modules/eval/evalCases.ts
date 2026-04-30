/**
 * Core Eval Cases — 评测用例集（数据外部化）
 *
 * 用例数据从 eval-cases.json 加载（P2 外部化）。
 * 本文件保留所有原有导出接口，供 evalSuite / run-eval-ci 等消费方无感切换。
 *
 * 若 JSON 文件不存在，各数组将为空（请确保 eval-cases.json 已部署）。
 */
import type { IntentEvalCase, KnowledgeEvalCase, DecomposeEvalCase, EvalCase } from "./evalSuite";
import { getEvalCaseSnapshot, initEvalCaseLoader } from "./evalCaseLoader";

// 模块加载时同步初始化（JSON 文件同步读取，无副作用）
const _snap = initEvalCaseLoader();

// ── 意图分析评测用例 ─────────────────────────────────────

export const intentEvalCases: IntentEvalCase[] = _snap.intentCases;

// ── 知识检索评测用例 ─────────────────────────────────────

export const knowledgeEvalCases: KnowledgeEvalCase[] = _snap.knowledgeCases;

// ── 任务分解评测用例 ─────────────────────────────────────

export const decomposeEvalCases: DecomposeEvalCase[] = _snap.decomposeCases;

// ── 完整用例集 ───────────────────────────────────────────

/** 所有评测用例 */
export const allEvalCases: EvalCase[] = [
  ...intentEvalCases,
  ...knowledgeEvalCases,
  ...decomposeEvalCases,
];

/** 按类别获取用例 */
export function getEvalCasesByCategory(category: "intent" | "knowledge" | "decompose"): EvalCase[] {
  return allEvalCases.filter((c) => c.category === category);
}

// 保持对外暴露 getEvalCaseSnapshot 以便需要完整快照的消费方直接使用
export { getEvalCaseSnapshot };
