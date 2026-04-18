/**
 * goalDecomposerComplexity.ts — 目标复杂度评估（三级策略）
 *
 * 从 goalDecomposer.ts 拆分，负责：
 * - 复杂度评估启发式（assessGoalComplexity）
 * - 运行时可配置的关键词/正则模式
 * - 复杂度配置热更新（reloadComplexityConfig）
 */

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/** 任务复杂度级别 */
export type GoalComplexity = "trivial" | "medium" | "complex";

/** 分解策略标签 */
export type DecomposeStrategy =
  | "early_exit"     // P1-5: 极简单任务跳过 LLM
  | "template"       // P1-4 Level-1: 模板化快速分解
  | "fast_model"     // P1-4 Level-2: 小模型结构化分解
  | "standard_model" // P1-4 Level-3: 标准模型深度分解
  | "single_node"    // 降级/禁用
  | "disabled";      // 环境变量禁用

/* ================================================================== */
/*  Pattern Defaults                                                    */
/* ================================================================== */

const _DEFAULT_SIMPLE_KEYWORDS = [
  "查询", "查看", "查找", "搜索", "显示", "列出", "获取", "读取",
  "查", "看", "找", "搜", "展示", "检索",
  "query", "search", "find", "list", "show", "get", "read", "fetch",
  "审批", "approve", "reject",
  "发送", "send",
  "删除", "delete", "remove",
];

const _DEFAULT_COMPLEX_INDICATOR_SOURCES = [
  "同时.*(?:并行|分别|各自)",
  "先.*然后.*(?:再|最后)",
  "如果.*(?:则|就|否则)",
  "批量.*(?:处理|导入|更新|删除)",
  "(?:迁移|部署|回滚|恢复)",
  "(?:审批|审核).*(?:通过|拒绝).*(?:然后|之后)",
  "(?:多个|多步|多阶段)",
  "(?:DAG|pipeline|流水线|工作流)",
  "(?:A.*B.*C|第一步.*第二步.*第三步)",
  "(?:然后|之后|最后|并行|同时|等待审批|审批通过后|失败时|失败则|重试|回滚|导出|汇总|创建.+订单|读取.+修改.+重启|生成.+清单|分析.+报告)",
];

const _DEFAULT_TEMPLATE_PATTERN_SOURCES = [
  "然后|之后|最后|并行|同时|->|→|等待审批|审批通过后|失败时|失败则|仍失败则|重试|回滚|导出|汇总",
  "如果.*(?:则|就|否则)",
  "读取.+修改.+重启",
  "创建.+然后.+创建",
  "修改.+合规审核",
  "采集.+分析.+生成.+创建",
  "查阅.+处理方法.+处理当前",
];

const _DEFAULT_SINGLE_TOOL_PATTERN_SOURCES = [
  "^(?:查询|查看|查找|搜索|显示|列出|获取|读取)\\s*.{2,30}$",
  "^(?:发送|发)(?:一封|一条|个)?\\s*.{2,20}$",
  "^审批(?:通过|拒绝)\\s*.{2,30}$",
  "^删除\\s*.{2,30}$",
  "^(?:query|search|find|list|show|get|read|send|approve|reject|delete)\\s+.{2,40}$",
];

/* ================================================================== */
/*  Runtime State                                                       */
/* ================================================================== */

let SIMPLE_KEYWORDS = new Set(_DEFAULT_SIMPLE_KEYWORDS);
let COMPLEX_INDICATORS: RegExp[] = _DEFAULT_COMPLEX_INDICATOR_SOURCES.map((s) => new RegExp(s, "i"));
let DETERMINISTIC_TEMPLATE_PATTERNS: RegExp[] = _DEFAULT_TEMPLATE_PATTERN_SOURCES.map((s) => new RegExp(s, "i"));
let SINGLE_TOOL_PATTERNS: RegExp[] = _DEFAULT_SINGLE_TOOL_PATTERN_SOURCES.map((s) => new RegExp(s, "i"));

/**
 * 重新加载复杂度评估配置（支持运行时热更新）
 */
export function reloadComplexityConfig(cfg: {
  simpleKeywords?: string[];
  complexIndicatorSources?: string[];
  templatePatternSources?: string[];
  singleToolPatternSources?: string[];
}): void {
  if (cfg.simpleKeywords) {
    SIMPLE_KEYWORDS = new Set(cfg.simpleKeywords);
  }
  if (cfg.complexIndicatorSources) {
    COMPLEX_INDICATORS = cfg.complexIndicatorSources.map((s) => new RegExp(s, "i"));
  }
  if (cfg.templatePatternSources) {
    DETERMINISTIC_TEMPLATE_PATTERNS = cfg.templatePatternSources.map((s) => new RegExp(s, "i"));
  }
  if (cfg.singleToolPatternSources) {
    SINGLE_TOOL_PATTERNS = cfg.singleToolPatternSources.map((s) => new RegExp(s, "i"));
  }
}

/* ================================================================== */
/*  Core Assessment                                                     */
/* ================================================================== */

/**
 * P1-4: 评估目标复杂度
 *
 * 时间复杂度 O(n) 不调用 LLM，全在本地完成。
 */
export function assessGoalComplexity(
  goal: string,
  toolCatalog?: string,
): { complexity: GoalComplexity; strategy: DecomposeStrategy; reason: string } {
  const trimmed = goal.trim();
  const len = trimmed.length;

  if (len === 0) return { complexity: "trivial", strategy: "early_exit", reason: "empty_goal" };
  if (len <= 6) return { complexity: "trivial", strategy: "early_exit", reason: "ultra_short" };

  for (const pattern of SINGLE_TOOL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { complexity: "trivial", strategy: "early_exit", reason: "single_tool_pattern" };
    }
  }

  const commaCount = (trimmed.match(/[，,、]/g) ?? []).length;
  const sentenceCount = (trimmed.match(/[。；;！!？?\n]/g) ?? []).length + 1;
  const complexHits = COMPLEX_INDICATORS.filter((r) => r.test(trimmed)).length;
  const deterministicTemplateHit = DETERMINISTIC_TEMPLATE_PATTERNS.some((r) => r.test(trimmed));

  const words = trimmed.replace(/[^\u4e00-\u9fff\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const hasOnlySimpleVerb = words.length <= 5 && words.some((w) => SIMPLE_KEYWORDS.has(w));

  if (deterministicTemplateHit) {
    return {
      complexity: len > 40 || complexHits > 0 ? "complex" : "medium",
      strategy: "template",
      reason: "deterministic_template_pattern",
    };
  }

  if (len <= 20 && hasOnlySimpleVerb && complexHits === 0) {
    return { complexity: "trivial", strategy: "template", reason: "short_simple_verb" };
  }

  if (complexHits >= 2 || (len > 60 && commaCount >= 2) || sentenceCount >= 3) {
    return { complexity: "complex", strategy: "standard_model", reason: `complex_hits=${complexHits},len=${len},commas=${commaCount},sentences=${sentenceCount}` };
  }

  return { complexity: "medium", strategy: "fast_model", reason: `medium:len=${len},complex_hits=${complexHits}` };
}
