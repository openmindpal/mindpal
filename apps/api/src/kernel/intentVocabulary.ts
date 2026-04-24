/**
 * Intent Vocabulary — kernel 层词表类型与动态桥接
 *
 * **职责**：定义词表类型、提供注册/获取 API。
 * 数据由 skills 层注入（通过 registerVocabProvider / registerInterventionProvider），
 * kernel 层仅消费，不拥有词表数据。
 */

/* ================================================================== */
/*  0. 类型定义                                                         */
/* ================================================================== */

/** 多模态提示规则类型 */
export interface MultimodalHintEntry {
  attachmentType: "image" | "document" | "voice" | "video";
  textPattern?: string;
  boostIntent: string;
  boostConfidence: number;
}

/** 动态词表快照 */
export interface ActiveVocab {
  greetingWords: readonly string[];
  collabKeywords: readonly string[];
  highRiskKeywords: readonly string[];
  executeRequestPrefixes: readonly string[];
  executeActionVerbs: readonly string[];
  questionIndicators: readonly string[];
  opinionPrefixes: readonly string[];
  followUpConfirms: readonly string[];
  queryKeywords: readonly string[];
  uiPatternVerbs: readonly string[];
  uiPatternTargets: readonly string[];
  uiDisplayVerbs: readonly string[];
  multimodalHints: readonly MultimodalHintEntry[];
}

/** 干预模式条目 */
export interface InterventionPatternEntry {
  re: RegExp;
  type: "cancel" | "pause" | "resume" | "modify_step" | "change_goal";
}

/* ================================================================== */
/*  1. 注册 / 获取 API                                                  */
/* ================================================================== */

/** 空词表 — 所有字段为空数组的安全降级 */
const EMPTY_VOCAB: ActiveVocab = {
  greetingWords: [],
  collabKeywords: [],
  highRiskKeywords: [],
  executeRequestPrefixes: [],
  executeActionVerbs: [],
  questionIndicators: [],
  opinionPrefixes: [],
  followUpConfirms: [],
  queryKeywords: [],
  uiPatternVerbs: [],
  uiPatternTargets: [],
  uiDisplayVerbs: [],
  multimodalHints: [],
};

let _vocabProvider: (() => ActiveVocab | null) | null = null;
let _interventionProvider: (() => readonly InterventionPatternEntry[]) | null = null;

/**
 * 注册词表提供函数（由 skills 层调用）。
 */
export function registerVocabProvider(fn: () => ActiveVocab | null): void {
  _vocabProvider = fn;
}

/**
 * 获取当前活跃词表快照。
 * 优先返回已注册 provider 的数据，无 provider 或 provider 返回 null 时降级为空词表。
 */
export function getActiveVocab(): ActiveVocab {
  if (_vocabProvider) {
    const snap = _vocabProvider();
    if (snap) return snap;
  }
  return EMPTY_VOCAB;
}

/**
 * 注册干预模式提供函数（由 skills 层调用）。
 */
export function registerInterventionProvider(fn: () => readonly InterventionPatternEntry[]): void {
  _interventionProvider = fn;
}

/**
 * 获取干预模式列表。
 */
export function getInterventionPatterns(): readonly InterventionPatternEntry[] {
  if (_interventionProvider) {
    return _interventionProvider();
  }
  return [];
}
