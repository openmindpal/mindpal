/**
 * P2-6: Core Capability Eval Suite — 核心能力评测框架
 *
 * 为以下核心能力提供标准化评测：
 * 1. 意图分析 (Intent Analysis) — 用户输入→意图分类+工具推荐
 * 2. NL2UI (Natural Language to UI) — 用户输入→界面配置生成
 * 3. 知识检索 (Knowledge RAG) — 用户查询→知识文档检索
 *
 * 每个 eval case 定义：
 * - input: 用户输入
 * - expectedOutput: 期望的输出特征（不要求精确匹配，而是特征校验）
 * - constraints: 评判约束条件
 */

// ── 评测用例类型定义 ───────────────────────────────────────

/** 意图分析评测用例 */
export interface IntentEvalCase {
  id: string;
  category: "intent";
  input: string;
  context?: { conversationHistory?: Array<{ role: string; content: string }> };
  expected: {
    intent: "chat" | "ui" | "query" | "task" | "collab";
    /** 最低置信度 */
    minConfidence?: number;
    /** 期望推荐的工具（至少包含其中之一） */
    suggestedToolRefs?: string[];
    /** 是否需要确认 */
    requiresConfirmation?: boolean;
    /** 端到端：期望的系统行为描述（如 "回答知识问题" / "执行工具创建客户" / "展示 UI 面板"） */
    expectedBehavior?: string;
    /** 端到端：验收标准（如 "回复包含 ML 概念解释" / "成功调用 entity.create"） */
    acceptanceCriteria?: string;
  };
}

/** NL2UI评测用例 */
export interface Nl2UiEvalCase {
  id: string;
  category: "nl2ui";
  input: string;
  expected: {
    /** 期望的布局类型 */
    layout?: string;
    /** 期望包含的组件类型 */
    containsComponents?: string[];
    /** 期望的数据绑定实体名 */
    dataBindingEntities?: string[];
    /** 最低置信度 */
    minConfidence?: number;
    /** 期望页面类型 */
    pageType?: "local" | "business";
  };
}

/** 知识检索评测用例 */
export interface KnowledgeEvalCase {
  id: string;
  category: "knowledge";
  input: string;
  expected: {
    /** 期望检索到的最少文档数 */
    minResults?: number;
    /** 期望包含的关键词（至少一个命中） */
    containsKeywords?: string[];
    /** 期望的相关性分数下限 */
    minRelevanceScore?: number;
    /** 不应出现的内容（幻觉检测） */
    excludeKeywords?: string[];
  };
}

/** P0-5: 任务分解评测用例 */
export interface DecomposeEvalCase {
  id: string;
  category: "decompose";
  input: string;
  /** 任务复杂度标签 */
  complexity: "simple" | "serial" | "parallel" | "dag" | "write" | "approval" | "recovery" | "rag_enhanced";
  expected: {
    /** 期望的最少子目标数 */
    minSubGoals?: number;
    /** 期望的最多子目标数 */
    maxSubGoals?: number;
    /** 期望 DAG 是否合法 */
    dagValid?: boolean;
    /** 期望包含的工具引用 */
    expectedToolRefs?: string[];
    /** 期望包含的前后置条件关键词 */
    expectedConditionKeywords?: string[];
    /** 是否需要审批步骤 */
    requiresApproval?: boolean;
    /** 是否包含写操作 */
    hasWriteOperation?: boolean;
    /** 期望的依赖类型 */
    expectedDependencyTypes?: ("finish_to_start" | "output_to_input" | "cancel_cascade")[];
    /** 是否应触发 early-exit（极简单任务） */
    shouldEarlyExit?: boolean;
    /** 端到端：分解后的计划是否期望可执行（执行成功率导向） */
    expectedExecutable?: boolean;
    /** 端到端：执行成功判定标准（如 "所有步骤成功完成" / "目标数据被正确创建"） */
    executionSuccessCriteria?: string;
  };
}

export type EvalCase = IntentEvalCase | Nl2UiEvalCase | KnowledgeEvalCase | DecomposeEvalCase;

/** 单个用例的评测结果 */
export interface EvalCaseResult {
  caseId: string;
  category: string;
  passed: boolean;
  /** 各维度得分 (0~1) */
  scores: Record<string, number>;
  /** 失败原因 */
  failureReasons: string[];
  /** 实际输出摘要 */
  actualOutput?: any;
  /** 耗时(ms) */
  latencyMs: number;
}

/** Eval Suite 执行汇总 */
export interface EvalSuiteResult {
  suiteId: string;
  suiteName: string;
  executedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  /** 各分类通过率 */
  categoryPassRates: Record<string, { total: number; passed: number; rate: number }>;
  /** 平均延迟 */
  avgLatencyMs: number;
  cases: EvalCaseResult[];
}

// ── 评测执行引擎 ───────────────────────────────────────────

/**
 * 执行 Eval Suite
 */
export function runEvalSuite(params: {
  suiteName: string;
  cases: EvalCase[];
  /** 执行器：针对每个用例调用实际系统并返回结果 */
  executor: (evalCase: EvalCase) => Promise<{ output: any; latencyMs: number }>;
  /** 评判器：判断实际输出是否满足预期 */
  judge: (evalCase: EvalCase, actualOutput: any) => EvalCaseResult;
}): Promise<EvalSuiteResult> {
  return executeEvalSuite(params);
}

async function executeEvalSuite(params: {
  suiteName: string;
  cases: EvalCase[];
  executor: (evalCase: EvalCase) => Promise<{ output: any; latencyMs: number }>;
  judge: (evalCase: EvalCase, actualOutput: any) => EvalCaseResult;
}): Promise<EvalSuiteResult> {
  const suiteId = `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const results: EvalCaseResult[] = [];

  for (const evalCase of params.cases) {
    try {
      const { output, latencyMs } = await params.executor(evalCase);
      const result = params.judge(evalCase, output);
      result.latencyMs = latencyMs;
      result.actualOutput = output;
      results.push(result);
    } catch (err: any) {
      results.push({
        caseId: evalCase.id,
        category: evalCase.category,
        passed: false,
        scores: {},
        failureReasons: [`执行异常: ${err?.message ?? String(err)}`],
        latencyMs: 0,
      });
    }
  }

  // 汇总
  const passedCases = results.filter((r) => r.passed).length;
  const categoryMap: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    if (!categoryMap[r.category]) categoryMap[r.category] = { total: 0, passed: 0 };
    categoryMap[r.category]!.total += 1;
    if (r.passed) categoryMap[r.category]!.passed += 1;
  }

  return {
    suiteId,
    suiteName: params.suiteName,
    executedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases,
    failedCases: results.length - passedCases,
    passRate: results.length > 0 ? passedCases / results.length : 0,
    categoryPassRates: Object.fromEntries(
      Object.entries(categoryMap).map(([k, v]) => [k, { ...v, rate: v.total > 0 ? v.passed / v.total : 0 }]),
    ),
    avgLatencyMs: results.length > 0 ? results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length : 0,
    cases: results,
  };
}

// ── 内置评判器 ─────────────────────────────────────────────

/**
 * 意图体系映射：orchestrator mode ↔ eval intent type
 *
 * orchestrator 输出 4 种 mode: answer/execute/collab/intervene
 * eval 使用 5 种 intent: chat/ui/query/task/collab
 *
 * 映射关系：
 *   answer  ↔ chat, query (问答类)
 *   execute ↔ task, ui    (执行类)
 *   collab  ↔ collab
 *   intervene → (eval 暂无对应，映射为 task)
 */
const INTENT_MODE_ALIASES: Record<string, string[]> = {
  chat:  ["chat", "answer", "query"],
  query: ["query", "answer", "chat"],
  task:  ["task", "execute", "ui"],
  ui:    ["ui", "execute", "task"],
  collab: ["collab"],
};

/** 判断 actual intent 是否与 expected intent 等价匹配 */
function isIntentEquivalent(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  if (expected === actual) return true;
  const aliases = INTENT_MODE_ALIASES[expected];
  return aliases ? aliases.includes(actual) : false;
}

/** 意图分析评判器 */
export function judgeIntentResult(evalCase: IntentEvalCase, actual: any): EvalCaseResult {
  const scores: Record<string, number> = {};
  const failures: string[] = [];

  // 1. 意图匹配（支持 orchestrator mode ↔ eval intent 等价映射）
  const actualIntent: string | undefined = actual?.intent ?? actual?.mode;
  const intentMatch = isIntentEquivalent(evalCase.expected.intent, actualIntent);
  scores["intent_match"] = intentMatch ? 1.0 : 0.0;
  if (!intentMatch) failures.push(`意图不匹配: 期望=${evalCase.expected.intent}, 实际=${actualIntent}`);

  // 2. 置信度
  const confidence = typeof actual?.confidence === "number" ? actual.confidence : 0;
  const minConf = evalCase.expected.minConfidence ?? 0.6;
  scores["confidence"] = confidence >= minConf ? 1.0 : confidence / minConf;
  if (confidence < minConf) failures.push(`置信度不足: 期望>=${minConf}, 实际=${confidence}`);

  // 3. 工具推荐
  if (evalCase.expected.suggestedToolRefs && evalCase.expected.suggestedToolRefs.length > 0) {
    const actualTools = Array.isArray(actual?.suggestedTools)
      ? actual.suggestedTools.map((t: any) => t.toolRef ?? t)
      : [];
    const hasMatch = evalCase.expected.suggestedToolRefs.some((ref) =>
      actualTools.some((at: string) => at.includes(ref)),
    );
    scores["tool_suggestion"] = hasMatch ? 1.0 : 0.0;
    if (!hasMatch) failures.push(`工具推荐不匹配: 期望包含${evalCase.expected.suggestedToolRefs.join("|")}`);
  }

  const passed = failures.length === 0;
  return { caseId: evalCase.id, category: "intent", passed, scores, failureReasons: failures, latencyMs: 0 };
}

/** NL2UI评判器 */
export function judgeNl2UiResult(evalCase: Nl2UiEvalCase, actual: any): EvalCaseResult {
  const scores: Record<string, number> = {};
  const failures: string[] = [];

  // 1. 布局匹配
  if (evalCase.expected.layout) {
    const layoutMatch = actual?.layout === evalCase.expected.layout;
    scores["layout_match"] = layoutMatch ? 1.0 : 0.0;
    if (!layoutMatch) failures.push(`布局不匹配: 期望=${evalCase.expected.layout}, 实际=${actual?.layout}`);
  }

  // 2. 组件包含
  if (evalCase.expected.containsComponents) {
    const actualComponents = Array.isArray(actual?.panels)
      ? actual.panels.flatMap((p: any) => Array.isArray(p.components) ? p.components.map((c: any) => c.componentId) : [])
      : [];
    const matched = evalCase.expected.containsComponents.filter((c) => actualComponents.includes(c));
    scores["component_coverage"] = evalCase.expected.containsComponents.length > 0
      ? matched.length / evalCase.expected.containsComponents.length
      : 1.0;
    if (matched.length < evalCase.expected.containsComponents.length) {
      failures.push(`组件缺失: 期望${evalCase.expected.containsComponents.join(",")}, 缺少${evalCase.expected.containsComponents.filter((c) => !actualComponents.includes(c)).join(",")}`);
    }
  }

  // 3. 数据绑定
  if (evalCase.expected.dataBindingEntities) {
    const actualEntities = Array.isArray(actual?.dataBindings)
      ? actual.dataBindings.map((db: any) => db.entityName)
      : [];
    const matched = evalCase.expected.dataBindingEntities.filter((e) => actualEntities.includes(e));
    scores["data_binding"] = evalCase.expected.dataBindingEntities.length > 0
      ? matched.length / evalCase.expected.dataBindingEntities.length
      : 1.0;
    if (matched.length < evalCase.expected.dataBindingEntities.length) {
      failures.push(`数据绑定缺失: 期望实体${evalCase.expected.dataBindingEntities.join(",")}`);
    }
  }

  // 4. 置信度
  if (evalCase.expected.minConfidence) {
    const conf = actual?.metadata?.confidence ?? 0;
    scores["confidence"] = conf >= evalCase.expected.minConfidence ? 1.0 : conf / evalCase.expected.minConfidence;
    if (conf < evalCase.expected.minConfidence) failures.push(`置信度不足: ${conf} < ${evalCase.expected.minConfidence}`);
  }

  const passed = failures.length === 0;
  return { caseId: evalCase.id, category: "nl2ui", passed, scores, failureReasons: failures, latencyMs: 0 };
}

/** 知识检索评判器 */
export function judgeKnowledgeResult(evalCase: KnowledgeEvalCase, actual: any): EvalCaseResult {
  const scores: Record<string, number> = {};
  const failures: string[] = [];

  const results = Array.isArray(actual?.results) ? actual.results : [];

  // 1. 最少结果数
  if (evalCase.expected.minResults) {
    scores["result_count"] = results.length >= evalCase.expected.minResults ? 1.0 : results.length / evalCase.expected.minResults;
    if (results.length < evalCase.expected.minResults) failures.push(`结果数不足: ${results.length} < ${evalCase.expected.minResults}`);
  }

  // 2. 关键词命中
  if (evalCase.expected.containsKeywords) {
    const allText = results.map((r: any) => JSON.stringify(r)).join(" ").toLowerCase();
    const hits = evalCase.expected.containsKeywords.filter((kw) => allText.includes(kw.toLowerCase()));
    scores["keyword_hit"] = evalCase.expected.containsKeywords.length > 0
      ? hits.length / evalCase.expected.containsKeywords.length
      : 1.0;
    if (hits.length === 0) failures.push(`关键词未命中: ${evalCase.expected.containsKeywords.join(",")}`);
  }

  // 3. 幻觉检测（排除关键词）
  if (evalCase.expected.excludeKeywords) {
    const allText = results.map((r: any) => JSON.stringify(r)).join(" ").toLowerCase();
    const hallucinations = evalCase.expected.excludeKeywords.filter((kw) => allText.includes(kw.toLowerCase()));
    scores["hallucination_free"] = hallucinations.length === 0 ? 1.0 : 0.0;
    if (hallucinations.length > 0) failures.push(`幻觉检测: 包含不应出现的内容 ${hallucinations.join(",")}`);
  }

  const passed = failures.length === 0;
  return { caseId: evalCase.id, category: "knowledge", passed, scores, failureReasons: failures, latencyMs: 0 };
}

/** 通用评判分发器 */
export function judgeEvalCase(evalCase: EvalCase, actualOutput: any): EvalCaseResult {
  switch (evalCase.category) {
    case "intent":
      return judgeIntentResult(evalCase as IntentEvalCase, actualOutput);
    case "nl2ui":
      return judgeNl2UiResult(evalCase as Nl2UiEvalCase, actualOutput);
    case "knowledge":
      return judgeKnowledgeResult(evalCase as KnowledgeEvalCase, actualOutput);
    case "decompose":
      return judgeDecomposeResult(evalCase as DecomposeEvalCase, actualOutput);
    default: {
      const c = evalCase as EvalCase;
      return { caseId: c.id, category: c.category, passed: false, scores: {}, failureReasons: ["未知评测类别"], latencyMs: 0 };
    }
  }
}

// ── P0-5: 任务分解评判器 ─────────────────────────────────

/** 任务分解评判器 */
export function judgeDecomposeResult(evalCase: DecomposeEvalCase, actual: any): EvalCaseResult {
  const scores: Record<string, number> = {};
  const failures: string[] = [];

  const subGoals = Array.isArray(actual?.subGoals) ? actual.subGoals : [];
  const subGoalCount = subGoals.length;

  // 1. 子目标数量范围
  if (evalCase.expected.minSubGoals != null) {
    scores["min_sub_goals"] = subGoalCount >= evalCase.expected.minSubGoals ? 1.0 : subGoalCount / evalCase.expected.minSubGoals;
    if (subGoalCount < evalCase.expected.minSubGoals) failures.push(`子目标不足: ${subGoalCount} < ${evalCase.expected.minSubGoals}`);
  }
  if (evalCase.expected.maxSubGoals != null) {
    scores["max_sub_goals"] = subGoalCount <= evalCase.expected.maxSubGoals ? 1.0 : 0.0;
    if (subGoalCount > evalCase.expected.maxSubGoals) failures.push(`子目标过多: ${subGoalCount} > ${evalCase.expected.maxSubGoals}`);
  }

  // 2. DAG 合法性
  if (evalCase.expected.dagValid != null) {
    const dagValid = actual?.dagValid ?? (actual?.graph?.status !== "invalid");
    scores["dag_valid"] = dagValid === evalCase.expected.dagValid ? 1.0 : 0.0;
    if (dagValid !== evalCase.expected.dagValid) failures.push(`DAG合法性: 期望=${evalCase.expected.dagValid}, 实际=${dagValid}`);
  }

  // 3. 工具引用覆盖
  if (evalCase.expected.expectedToolRefs && evalCase.expected.expectedToolRefs.length > 0) {
    const actualToolRefs = subGoals.flatMap((sg: any) =>
      Array.isArray(sg.toolCandidates) ? sg.toolCandidates : [sg.toolRef].filter(Boolean)
    );
    const matched = evalCase.expected.expectedToolRefs.filter((ref) =>
      actualToolRefs.some((at: string) => at.includes(ref))
    );
    scores["tool_coverage"] = evalCase.expected.expectedToolRefs.length > 0
      ? matched.length / evalCase.expected.expectedToolRefs.length : 1.0;
    if (matched.length < evalCase.expected.expectedToolRefs.length) {
      failures.push(`工具缺失: 期望${evalCase.expected.expectedToolRefs.join(",")}, 匹配${matched.join(",")}`);
    }
  }

  // 4. 前后置条件关键词
  if (evalCase.expected.expectedConditionKeywords && evalCase.expected.expectedConditionKeywords.length > 0) {
    const allText = JSON.stringify(actual).toLowerCase();
    const hits = evalCase.expected.expectedConditionKeywords.filter((kw) => allText.includes(kw.toLowerCase()));
    scores["condition_coverage"] = hits.length / evalCase.expected.expectedConditionKeywords.length;
    if (hits.length === 0) failures.push(`前后置条件关键词未命中: ${evalCase.expected.expectedConditionKeywords.join(",")}`);
  }

  // 5. 审批步骤
  if (evalCase.expected.requiresApproval != null) {
    const hasApproval = subGoals.some((sg: any) => sg.requiresApproval || sg.needsApproval);
    scores["approval"] = hasApproval === evalCase.expected.requiresApproval ? 1.0 : 0.0;
    if (hasApproval !== evalCase.expected.requiresApproval) failures.push(`审批: 期望=${evalCase.expected.requiresApproval}, 实际=${hasApproval}`);
  }

  // 6. 写操作
  if (evalCase.expected.hasWriteOperation != null) {
    const hasWrite = subGoals.some((sg: any) => sg.isWrite || sg.writeOperation);
    scores["write_op"] = hasWrite === evalCase.expected.hasWriteOperation ? 1.0 : 0.0;
    if (hasWrite !== evalCase.expected.hasWriteOperation) failures.push(`写操作: 期望=${evalCase.expected.hasWriteOperation}, 实际=${hasWrite}`);
  }

  // 7. early-exit 检查
  if (evalCase.expected.shouldEarlyExit != null) {
    const earlyExited = actual?.earlyExit === true;
    scores["early_exit"] = earlyExited === evalCase.expected.shouldEarlyExit ? 1.0 : 0.0;
    if (earlyExited !== evalCase.expected.shouldEarlyExit) failures.push(`early-exit: 期望=${evalCase.expected.shouldEarlyExit}, 实际=${earlyExited}`);
  }

  const passed = failures.length === 0;
  return { caseId: evalCase.id, category: "decompose", passed, scores, failureReasons: failures, latencyMs: 0 };
}

// ── P0-6: 误判看板统计 ──────────────────────────────────

/** 五类质量问题分类 */
export type MisclassificationType =
  | "false_execute"       // 本应是聊天/问答却被分为执行
  | "false_answer"        // 本应是执行操作却被分为问答
  | "bad_decomposition"   // 任务分解质量差（过粗/过细/遗漏步骤）
  | "tool_hallucination"  // 幻觉工具调用（不存在的工具或错误参数）
  | "unsafe_downgrade";   // 不安全降级（写操作被降级为问答模式）

/** P0-6: 误判报告 */
export interface MisclassificationReport {
  /** 报告时间 */
  generatedAt: string;
  /** 总样本数 */
  totalSamples: number;
  /** 各类误判统计 */
  categories: Record<MisclassificationType, {
    count: number;
    rate: number;
    /** 典型样例 ID */
    sampleCaseIds: string[];
  }>;
  /** 总误判率 */
  overallMisclassificationRate: number;
  /** 高风险误执行率（false_execute 占 execute 总数比例） */
  highRiskExecuteRate: number;
  /** 低召回执行漏判率（false_answer 占实际应执行总数比例） */
  lowRecallExecuteMissRate: number;
}

/** P0-6: 从评测结果生成误判看板报告 */
export function buildMisclassificationReport(
  intentResults: EvalCaseResult[],
  intentCases: IntentEvalCase[],
  decomposeResults?: EvalCaseResult[],
): MisclassificationReport {
  const caseMap = new Map(intentCases.map(c => [c.id, c]));

  const categories: MisclassificationReport["categories"] = {
    false_execute: { count: 0, rate: 0, sampleCaseIds: [] },
    false_answer: { count: 0, rate: 0, sampleCaseIds: [] },
    bad_decomposition: { count: 0, rate: 0, sampleCaseIds: [] },
    tool_hallucination: { count: 0, rate: 0, sampleCaseIds: [] },
    unsafe_downgrade: { count: 0, rate: 0, sampleCaseIds: [] },
  };

  let totalMisclassified = 0;
  let executeTotal = 0;
  let shouldExecuteTotal = 0;

  for (const r of intentResults) {
    const evalCase = caseMap.get(r.caseId);
    if (!evalCase) continue;

    const expectedIntent = evalCase.expected.intent;
    const actualIntent = r.actualOutput?.intent ?? r.actualOutput?.mode;

    // 统计实际应执行的总数
    if (expectedIntent === "task" || expectedIntent === "ui") shouldExecuteTotal++;

    // 统计实际被分为执行的总数（兼容 orchestrator mode）
    if (actualIntent === "task" || actualIntent === "ui" || actualIntent === "execute") executeTotal++;

    if (!r.passed) {
      totalMisclassified++;

      // false_execute: 期望是 chat/query 但实际被分为 task/ui/execute
      if ((expectedIntent === "chat" || expectedIntent === "query") &&
          (actualIntent === "task" || actualIntent === "ui" || actualIntent === "execute")) {
        categories.false_execute.count++;
        categories.false_execute.sampleCaseIds.push(r.caseId);
      }

      // false_answer: 期望是 task/ui 但实际被分为 chat/query/answer
      if ((expectedIntent === "task" || expectedIntent === "ui") &&
          (actualIntent === "chat" || actualIntent === "query" || actualIntent === "answer")) {
        categories.false_answer.count++;
        categories.false_answer.sampleCaseIds.push(r.caseId);
      }

      // unsafe_downgrade: 需要确认的写操作被降为非确认模式
      if (evalCase.expected.requiresConfirmation && !r.actualOutput?.requiresConfirmation) {
        categories.unsafe_downgrade.count++;
        categories.unsafe_downgrade.sampleCaseIds.push(r.caseId);
      }
    }
  }

  // 任务分解质量问题
  if (decomposeResults) {
    for (const r of decomposeResults) {
      if (!r.passed) {
        // 检查是否是 tool hallucination
        if (r.failureReasons.some(f => f.includes("工具缺失") || f.includes("tool"))) {
          categories.tool_hallucination.count++;
          categories.tool_hallucination.sampleCaseIds.push(r.caseId);
        } else {
          categories.bad_decomposition.count++;
          categories.bad_decomposition.sampleCaseIds.push(r.caseId);
        }
      }
    }
  }

  const totalSamples = intentResults.length + (decomposeResults?.length ?? 0);
  for (const key of Object.keys(categories) as MisclassificationType[]) {
    categories[key].rate = totalSamples > 0 ? categories[key].count / totalSamples : 0;
    // 只保留前 5 个样例
    categories[key].sampleCaseIds = categories[key].sampleCaseIds.slice(0, 5);
  }

  return {
    generatedAt: new Date().toISOString(),
    totalSamples,
    categories,
    overallMisclassificationRate: totalSamples > 0 ? totalMisclassified / totalSamples : 0,
    highRiskExecuteRate: executeTotal > 0 ? categories.false_execute.count / executeTotal : 0,
    lowRecallExecuteMissRate: shouldExecuteTotal > 0 ? categories.false_answer.count / shouldExecuteTotal : 0,
  };
}
