/**
 * Intent Vocabulary — 极薄短路规则词表
 *
 * 架构重构：仅保留 <20 条硬短路规则所需的最小词表（问候/协作/干预/高风险），
 * 其余意图分类全部交给 LLM。
 *
 * 词表不该是系统的核心资产 — 它只是极少数确定性场景的快速捕捉层。
 *
 * JSON 词表数据统一由 intentVocabLoader.ts 加载，
 * 本模块仅定义常量接口、工具函数和动态词表桥接。
 * 在 initVocabLoader() 调用前，所有词表常量为空数组（优雅降级）。
 */

/* ================================================================== */
/*  0. 词表数据（由 intentVocabLoader 在启动时注入）                     */
/* ================================================================== */

interface _InterventionEntry {
  re: RegExp;
  type: "cancel" | "pause" | "resume" | "modify_step" | "change_goal";
}

let _greetingWords: readonly string[] = [];
let _collabKeywords: readonly string[] = [];
let _interventionPatterns: readonly _InterventionEntry[] = [];
let _highRiskKeywords: readonly string[] = [];
let _executeRequestPrefixes: readonly string[] = [];
let _executeActionVerbs: readonly string[] = [];
let _questionIndicators: readonly string[] = [];
let _opinionPrefixes: readonly string[] = [];
let _followUpConfirms: readonly string[] = [];

function _escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _rebuildRegexes(): void {
  GREETING_REGEX = _greetingWords.length > 0
    ? new RegExp(`^(${[..._greetingWords].map(_escapeForRegex).join("|")})$`, "i")
    : /^$/;
  COLLAB_REGEX = _collabKeywords.length > 0
    ? new RegExp(`(${[..._collabKeywords].map(_escapeForRegex).join("|")})`, "i")
    : /^$/;
  EXECUTE_REQUEST_RE = _executeRequestPrefixes.length > 0
    ? new RegExp(`^(${[..._executeRequestPrefixes].map(_escapeForRegex).join("|")})`, "i")
    : /^$/;
  EXECUTE_ACTION_RE = _executeActionVerbs.length > 0
    ? new RegExp(`^(${[..._executeActionVerbs].map(_escapeForRegex).join("|")})`, "i")
    : /^$/;
  QUESTION_INDICATOR_RE = _questionIndicators.length > 0
    ? new RegExp(`^(${[..._questionIndicators].map(_escapeForRegex).join("|")})`, "i")
    : /^$/;
  OPINION_PREFIX_RE = _opinionPrefixes.length > 0
    ? new RegExp(`^(${[..._opinionPrefixes].map(_escapeForRegex).join("|")})`, "i")
    : /^$/;
  FOLLOW_UP_RE = _followUpConfirms.length > 0
    ? new RegExp(`^(${[..._followUpConfirms].map(_escapeForRegex).join("|")})$`, "i")
    : /^$/;
}

/**
 * 由 intentVocabLoader 调用，注入初始词表数据并重建预编译正则。
 * @internal
 */
export function _initVocabData(data: {
  greetingWords?: string[];
  collabKeywords?: string[];
  interventionPatterns?: Array<{ re: string; type: string }>;
  highRiskKeywords?: string[];
  executeRequestPrefixes?: string[];
  executeActionVerbs?: string[];
  questionIndicators?: string[];
  opinionPrefixes?: string[];
  followUpConfirms?: string[];
}): void {
  _greetingWords = data.greetingWords ?? [];
  _collabKeywords = data.collabKeywords ?? [];
  _highRiskKeywords = data.highRiskKeywords ?? [];
  _interventionPatterns = (data.interventionPatterns ?? []).map((p) => ({
    re: new RegExp(p.re),
    type: p.type as _InterventionEntry["type"],
  }));
  _executeRequestPrefixes = data.executeRequestPrefixes ?? [];
  _executeActionVerbs = data.executeActionVerbs ?? [];
  _questionIndicators = data.questionIndicators ?? [];
  _opinionPrefixes = data.opinionPrefixes ?? [];
  _followUpConfirms = data.followUpConfirms ?? [];
  // 同步更新导出的 let 绑定
  GREETING_WORDS = _greetingWords;
  COLLAB_KEYWORDS = _collabKeywords;
  HIGH_RISK_KEYWORDS = _highRiskKeywords;
  INTERVENTION_PATTERNS = _interventionPatterns;
  EXECUTE_REQUEST_PREFIXES = _executeRequestPrefixes;
  EXECUTE_ACTION_VERBS = _executeActionVerbs;
  QUESTION_INDICATORS = _questionIndicators;
  OPINION_PREFIXES = _opinionPrefixes;
  FOLLOW_UP_CONFIRMS = _followUpConfirms;
  _rebuildRegexes();
}

/* ================================================================== */
/*  1. 问候/寒暄词表 — 快速短路规则 #1                                   */
/* ================================================================== */

export let GREETING_WORDS: readonly string[] = _greetingWords;

/* ================================================================== */
/*  2. 协作关键词 — 快速短路规则 #2                                     */
/* ================================================================== */

export let COLLAB_KEYWORDS: readonly string[] = _collabKeywords;

/* ================================================================== */
/*  3. 干预意图模式 — 快速短路规则 #3                                   */
/* ================================================================== */

export let INTERVENTION_PATTERNS: readonly {
  re: RegExp;
  type: "cancel" | "pause" | "resume" | "modify_step" | "change_goal";
}[] = [];

/* ================================================================== */
/*  4. 高风险关键词 — 用于意图复核器标记 needsConfirmation            */
/* ================================================================== */

export let HIGH_RISK_KEYWORDS: readonly string[] = _highRiskKeywords;

/* ================================================================== */
/*  4b. 执行请求前缀 — 快速短路规则 #6 (execute)                          */
/* ================================================================== */

export let EXECUTE_REQUEST_PREFIXES: readonly string[] = _executeRequestPrefixes;

/* ================================================================== */
/*  4c. 执行动作词 — 快速短路规则 #7 (execute)                            */
/* ================================================================== */

export let EXECUTE_ACTION_VERBS: readonly string[] = _executeActionVerbs;

/* ================================================================== */
/*  4d. 问句指示词 — 快速短路规则 #8 (answer)                            */
/* ================================================================== */

export let QUESTION_INDICATORS: readonly string[] = _questionIndicators;

/* ================================================================== */
/*  4e. 观点/意见前缀 — 快速短路规则 #9 (answer)                        */
/* ================================================================== */

export let OPINION_PREFIXES: readonly string[] = _opinionPrefixes;

/* ================================================================== */
/*  4f. 跟进确认词 — 快速短路规则 #10 (intervene/resume)                 */
/* ================================================================== */

export let FOLLOW_UP_CONFIRMS: readonly string[] = _followUpConfirms;

/* ================================================================== */
/*  5. 预编译正则辅助                                                       */
/* ================================================================== */

/** 问候词完全匹配正则（预编译，_initVocabData 后自动重建） */
export let GREETING_REGEX: RegExp = /^$/;

/** 协作关键词包含匹配正则（预编译，_initVocabData 后自动重建） */
export let COLLAB_REGEX: RegExp = /^$/;

/** 执行请求前缀匹配正则（如"帮我""please"，匹配行首） */
export let EXECUTE_REQUEST_RE: RegExp = /^$/;

/** 执行动作词匹配正则（如"创建""搜索"，匹配行首） */
export let EXECUTE_ACTION_RE: RegExp = /^$/;

/** 问句指示词匹配正则（如"什么""怎么"，匹配行首） */
export let QUESTION_INDICATOR_RE: RegExp = /^$/;

/** 观点/意见前缀匹配正则（如"我觉得""I think"，匹配行首） */
export let OPINION_PREFIX_RE: RegExp = /^$/;

/** 跟进确认词完全匹配正则（如"好的继续""确认"） */
export let FOLLOW_UP_RE: RegExp = /^$/;

/* ================================================================== */
/*  6. 高风险关键词检测辅助                                               */
/* ================================================================== */

/** 检测消息中是否包含高风险写操作词 */
export function hasHighRiskKeyword(msg: string): boolean {
  const lower = msg.toLowerCase();
  return HIGH_RISK_KEYWORDS.some((k) => msg.includes(k) || lower.includes(k));
}

/* ================================================================== */
/*  7. 动态词表桥接                                                       */
/* ================================================================== */

/**
 * 动态词表快照接口（精简后仅保留短路层所需字段）
 */
export interface ActiveVocab {
  greetingWords: readonly string[];
  collabKeywords: readonly string[];
  highRiskKeywords: readonly string[];
  executeRequestPrefixes: readonly string[];
  executeActionVerbs: readonly string[];
  questionIndicators: readonly string[];
  opinionPrefixes: readonly string[];
  followUpConfirms: readonly string[];
}

let _getLoaderSnapshot: (() => ActiveVocab | null) | null = null;

export function registerVocabProvider(fn: () => ActiveVocab | null): void {
  _getLoaderSnapshot = fn;
}

export function getActiveVocab(): ActiveVocab {
  if (_getLoaderSnapshot) {
    const snap = _getLoaderSnapshot();
    if (snap) return snap;
  }
  return {
    greetingWords: GREETING_WORDS,
    collabKeywords: COLLAB_KEYWORDS,
    highRiskKeywords: HIGH_RISK_KEYWORDS,
    executeRequestPrefixes: EXECUTE_REQUEST_PREFIXES,
    executeActionVerbs: EXECUTE_ACTION_VERBS,
    questionIndicators: QUESTION_INDICATORS,
    opinionPrefixes: OPINION_PREFIXES,
    followUpConfirms: FOLLOW_UP_CONFIRMS,
  };
}
