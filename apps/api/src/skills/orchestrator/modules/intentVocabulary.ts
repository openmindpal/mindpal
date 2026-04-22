/**
 * Intent Vocabulary — 极薄短路规则词表
 *
 * 默认词表数据从 ../data/intentVocabulary.json 加载，
 * 运行时可被 intentVocabLoader 的 JSON 热更新覆盖。
 *
 * 本模块仅负责：类型定义、JSON 加载、正则编译、动态词表桥接。
 */

import * as fs from "fs";
import * as path from "path";

/* ================================================================== */
/*  0. 类型定义                                                         */
/* ================================================================== */

interface _InterventionEntry {
  re: RegExp;
  type: "cancel" | "pause" | "resume" | "modify_step" | "change_goal";
}

/** 多模态提示规则类型 */
export interface MultimodalHintEntry {
  attachmentType: "image" | "document" | "voice" | "video";
  textPattern?: string;
  boostIntent: string;
  boostConfidence: number;
}

/* ================================================================== */
/*  1. 从 JSON 加载默认词表                                              */
/* ================================================================== */

interface VocabJsonData {
  greetingWords?: string[];
  collabKeywords?: string[];
  executeRequestPrefixes?: string[];
  executeActionVerbs?: string[];
  questionIndicators?: string[];
  opinionPrefixes?: string[];
  followUpConfirms?: string[];
  queryKeywords?: string[];
  uiPatternVerbs?: string[];
  uiPatternTargets?: string[];
  uiDisplayVerbs?: string[];
  multimodalHints?: MultimodalHintEntry[];
}

function loadDefaultVocabJson(): VocabJsonData {
  try {
    const jsonPath = path.resolve(__dirname, "../data/intentVocabulary.json");
    const raw = fs.readFileSync(jsonPath, "utf-8");
    return JSON.parse(raw) as VocabJsonData;
  } catch {
    // 文件不存在或解析失败 → 返回空对象，使用硬编码兜底
    return {};
  }
}

const _defaults = loadDefaultVocabJson();

/* ── 硬编码兜底（JSON 加载失败时的最小安全降级） ── */
const _FALLBACK_GREETING: readonly string[] = ["你好", "hello", "hi", "hey"];
const _FALLBACK_COLLAB: readonly string[] = ["协作", "collaborate"];

/** 多模态附件感知默认规则 */
export const DEFAULT_MULTIMODAL_HINTS: readonly MultimodalHintEntry[] = _defaults.multimodalHints?.length
  ? _defaults.multimodalHints
  : [
      { attachmentType: "image", boostIntent: "execute", boostConfidence: 0.10 },
      { attachmentType: "document", textPattern: "分析|总结|摘要|analyze|summarize", boostIntent: "execute", boostConfidence: 0.15 },
      { attachmentType: "voice", boostIntent: "chat", boostConfidence: 0.05 },
      { attachmentType: "video", boostIntent: "execute", boostConfidence: 0.10 },
    ];

/* ================================================================== */
/*  2. 可变词表状态（由 _initVocabData 注入或使用 JSON 默认值）           */
/* ================================================================== */

let _greetingWords: readonly string[] = _defaults.greetingWords ?? [..._FALLBACK_GREETING];
let _collabKeywords: readonly string[] = _defaults.collabKeywords ?? [..._FALLBACK_COLLAB];
let _interventionPatterns: readonly _InterventionEntry[] = [];
let _highRiskKeywords: readonly string[] = [];
let _executeRequestPrefixes: readonly string[] = _defaults.executeRequestPrefixes ?? [];
let _executeActionVerbs: readonly string[] = _defaults.executeActionVerbs ?? [];
let _questionIndicators: readonly string[] = _defaults.questionIndicators ?? [];
let _opinionPrefixes: readonly string[] = _defaults.opinionPrefixes ?? [];
let _followUpConfirms: readonly string[] = _defaults.followUpConfirms ?? [];
let _queryKeywords: readonly string[] = _defaults.queryKeywords ?? [];
let _uiPatternVerbs: readonly string[] = _defaults.uiPatternVerbs ?? [];
let _uiPatternTargets: readonly string[] = _defaults.uiPatternTargets ?? [];
let _uiDisplayVerbs: readonly string[] = _defaults.uiDisplayVerbs ?? [];
let _multimodalHints: readonly MultimodalHintEntry[] = [...DEFAULT_MULTIMODAL_HINTS];

/* ================================================================== */
/*  3. 正则编译                                                         */
/* ================================================================== */

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

/* ================================================================== */
/*  4. 数据注入 API（由 intentVocabLoader 调用）                         */
/* ================================================================== */

/**
 * 由 intentVocabLoader 调用，注入词表数据并重建预编译正则。
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
  queryKeywords?: string[];
  uiPatternVerbs?: string[];
  uiPatternTargets?: string[];
  uiDisplayVerbs?: string[];
  multimodalHints?: MultimodalHintEntry[];
}): void {
  _greetingWords = data.greetingWords ?? _defaults.greetingWords ?? [..._FALLBACK_GREETING];
  _collabKeywords = data.collabKeywords ?? _defaults.collabKeywords ?? [..._FALLBACK_COLLAB];
  _highRiskKeywords = data.highRiskKeywords ?? [];
  _interventionPatterns = (data.interventionPatterns ?? []).map((p) => ({
    re: new RegExp(p.re),
    type: p.type as _InterventionEntry["type"],
  }));
  _executeRequestPrefixes = data.executeRequestPrefixes ?? _defaults.executeRequestPrefixes ?? [];
  _executeActionVerbs = data.executeActionVerbs ?? _defaults.executeActionVerbs ?? [];
  _questionIndicators = data.questionIndicators ?? _defaults.questionIndicators ?? [];
  _opinionPrefixes = data.opinionPrefixes ?? _defaults.opinionPrefixes ?? [];
  _followUpConfirms = data.followUpConfirms ?? _defaults.followUpConfirms ?? [];
  _queryKeywords = data.queryKeywords ?? _defaults.queryKeywords ?? [];
  _uiPatternVerbs = data.uiPatternVerbs ?? _defaults.uiPatternVerbs ?? [];
  _uiPatternTargets = data.uiPatternTargets ?? _defaults.uiPatternTargets ?? [];
  _uiDisplayVerbs = data.uiDisplayVerbs ?? _defaults.uiDisplayVerbs ?? [];

  GREETING_WORDS = _greetingWords;
  COLLAB_KEYWORDS = _collabKeywords;
  HIGH_RISK_KEYWORDS = _highRiskKeywords;
  INTERVENTION_PATTERNS = _interventionPatterns;
  EXECUTE_REQUEST_PREFIXES = _executeRequestPrefixes;
  EXECUTE_ACTION_VERBS = _executeActionVerbs;
  QUESTION_INDICATORS = _questionIndicators;
  OPINION_PREFIXES = _opinionPrefixes;
  FOLLOW_UP_CONFIRMS = _followUpConfirms;
  QUERY_KEYWORDS = _queryKeywords;
  UI_PATTERN_VERBS = _uiPatternVerbs;
  UI_PATTERN_TARGETS = _uiPatternTargets;
  UI_DISPLAY_VERBS = _uiDisplayVerbs;
  _multimodalHints = data.multimodalHints?.length ? data.multimodalHints : DEFAULT_MULTIMODAL_HINTS;
  _rebuildRegexes();
}

/* ================================================================== */
/*  5. 导出词表常量                                                      */
/* ================================================================== */

export let GREETING_WORDS: readonly string[] = _greetingWords;
export let COLLAB_KEYWORDS: readonly string[] = _collabKeywords;
export let INTERVENTION_PATTERNS: readonly { re: RegExp; type: "cancel" | "pause" | "resume" | "modify_step" | "change_goal" }[] = [];
export let HIGH_RISK_KEYWORDS: readonly string[] = _highRiskKeywords;
export let EXECUTE_REQUEST_PREFIXES: readonly string[] = _executeRequestPrefixes;
export let EXECUTE_ACTION_VERBS: readonly string[] = _executeActionVerbs;
export let QUESTION_INDICATORS: readonly string[] = _questionIndicators;
export let OPINION_PREFIXES: readonly string[] = _opinionPrefixes;
export let FOLLOW_UP_CONFIRMS: readonly string[] = _followUpConfirms;
export let QUERY_KEYWORDS: readonly string[] = _queryKeywords;
export let UI_PATTERN_VERBS: readonly string[] = _uiPatternVerbs;
export let UI_PATTERN_TARGETS: readonly string[] = _uiPatternTargets;
export let UI_DISPLAY_VERBS: readonly string[] = _uiDisplayVerbs;

/* ================================================================== */
/*  6. 预编译正则                                                        */
/* ================================================================== */

export let GREETING_REGEX: RegExp = /^$/;
export let COLLAB_REGEX: RegExp = /^$/;
export let EXECUTE_REQUEST_RE: RegExp = /^$/;
export let EXECUTE_ACTION_RE: RegExp = /^$/;
export let QUESTION_INDICATOR_RE: RegExp = /^$/;
export let OPINION_PREFIX_RE: RegExp = /^$/;
export let FOLLOW_UP_RE: RegExp = /^$/;

// 模块加载时用 JSON 数据编译一次正则
_rebuildRegexes();

/* ================================================================== */
/*  7. 辅助函数                                                          */
/* ================================================================== */

/** 检测消息中是否包含高风险写操作词 */
export function hasHighRiskKeyword(msg: string): boolean {
  const lower = msg.toLowerCase();
  return HIGH_RISK_KEYWORDS.some((k) => msg.includes(k) || lower.includes(k));
}

/* ================================================================== */
/*  8. 动态词表桥接                                                      */
/* ================================================================== */

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
    queryKeywords: QUERY_KEYWORDS,
    uiPatternVerbs: UI_PATTERN_VERBS,
    uiPatternTargets: UI_PATTERN_TARGETS,
    uiDisplayVerbs: UI_DISPLAY_VERBS,
    multimodalHints: _multimodalHints,
  };
}
