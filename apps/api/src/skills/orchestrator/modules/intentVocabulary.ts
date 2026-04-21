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
 * 在 initVocabLoader() 调用前，所有词表常量使用模块内置默认值（优雅降级）。
 */

/* ================================================================== */
/*  0. 词表数据（由 intentVocabLoader 在启动时注入）                     */
/* ================================================================== */

interface _InterventionEntry {
  re: RegExp;
  type: "cancel" | "pause" | "resume" | "modify_step" | "change_goal";
}

/** 多模态提示规则类型（与 intentVocabLoader 共享同结构，此处定义以避免循环依赖） */
export interface MultimodalHintEntry {
  attachmentType: "image" | "document" | "voice" | "video";
  textPattern?: string;
  boostIntent: string;
  boostConfidence: number;
}

/** 多模态附件感知默认规则（词表驱动，支持 JSON 热更新覆盖） */
export const DEFAULT_MULTIMODAL_HINTS: readonly MultimodalHintEntry[] = [
  { attachmentType: "image", boostIntent: "execute", boostConfidence: 0.10 },
  { attachmentType: "document", textPattern: "分析|总结|摘要|analyze|summarize", boostIntent: "execute", boostConfidence: 0.15 },
  { attachmentType: "voice", boostIntent: "chat", boostConfidence: 0.05 },
  { attachmentType: "video", boostIntent: "execute", boostConfidence: 0.10 },
];

/* ── 各类别内置默认词表（词表为空时的安全降级数据源） ── */

/** 问候词默认值 */
const _DEFAULT_GREETING_WORDS: readonly string[] = [
  "你好", "您好", "早上好", "下午好", "晚上好", "嗨", "哈喽",
  "hi", "hello", "hey", "good morning",
  "good evening", "good afternoon", "morning", "afternoon", "evening",
  "howdy", "greetings", "sup", "hiya", "yo",
] as const;

/** 协作关键词默认值 */
const _DEFAULT_COLLAB_KEYWORDS: readonly string[] = [
  "协作", "讨论", "辩论", "多智能体", "团队", "分配", "分工", "合作", "一起",
  "collaborate", "discuss", "debate", "assign", "team",
] as const;

/** 执行请求前缀默认值 */
const _DEFAULT_EXECUTE_REQUEST_PREFIXES: readonly string[] = [
  "请执行", "请帮我执行", "请运行",
  "please run", "please execute",
] as const;

/** 执行动作词默认值 */
const _DEFAULT_EXECUTE_ACTION_VERBS: readonly string[] = [
  "执行", "运行", "启动", "停止", "创建", "更新", "修改", "删除",
  "审批", "提交", "发布", "部署", "改为", "设为", "帮忙",
  "生成", "发送", "查找", "搜索", "分析", "计算", "下载", "上传",
  "导出", "导入", "编辑", "配置", "设置", "安装", "打开", "关闭",
  "同步", "备份", "恢复", "迁移", "转换",
  "execute", "run", "create", "update", "delete", "submit", "approve", "deploy",
] as const;

/** 问句指示词默认值 */
const _DEFAULT_QUESTION_INDICATORS: readonly string[] = [
  "什么是", "怎么", "为什么", "如何", "是否", "能不能", "什么",
  "能否", "可以吗", "有没有", "有哪些", "多少", "哪个", "哪些", "哪里", "何时",
  "what is", "how to", "why",
  "which", "what", "how", "when", "where", "can you", "could you",
  "is there", "are there", "do you",
] as const;

/** 观点/意见前缀默认值 */
const _DEFAULT_OPINION_PREFIXES: readonly string[] = [
  "我觉得", "我认为", "I think", "I believe",
  "其实", "说实话", "坦白说", "我个人认为", "依我看",
  "老实说", "客观来说", "事实上", "实际上",
] as const;

/** 跟进确认词默认值 */
const _DEFAULT_FOLLOW_UP_CONFIRMS: readonly string[] = [
  "好的", "确认", "继续", "ok", "yes",
] as const;

/** query 类别默认特征词 */
const _DEFAULT_QUERY_KEYWORDS: readonly string[] = [
  "查询", "查找", "搜索", "查看", "列出", "统计", "汇总",
  "找下", "找找", "拉一下", "找出来",
  "翻翻", "有哪些",
  "给我拉", "报表", "再多看几条",
  "筛选", "导出",
] as const;

/** UI 生成模式动词默认值 */
const _DEFAULT_UI_PATTERN_VERBS: readonly string[] = [
  "显示", "生成", "创建", "展示", "弄", "做", "设计",
  "show me", "design",
] as const;

/** UI 生成模式目标词默认值 */
const _DEFAULT_UI_PATTERN_TARGETS: readonly string[] = [
  "页面", "界面", "面板", "看板", "dashboard", "图表",
  "仪表盘", "布局", "表单", "报表",
] as const;

/** UI 展示动词默认值（独立匹配，无需组合目标词即可命中 UI 意图） */
const _DEFAULT_UI_DISPLAY_VERBS: readonly string[] = [
  "显示", "展示", "show me", "show",
] as const;

let _greetingWords: readonly string[] = [..._DEFAULT_GREETING_WORDS];
let _collabKeywords: readonly string[] = [..._DEFAULT_COLLAB_KEYWORDS];
let _interventionPatterns: readonly _InterventionEntry[] = [];
let _highRiskKeywords: readonly string[] = [];
let _executeRequestPrefixes: readonly string[] = [..._DEFAULT_EXECUTE_REQUEST_PREFIXES];
let _executeActionVerbs: readonly string[] = [..._DEFAULT_EXECUTE_ACTION_VERBS];
let _questionIndicators: readonly string[] = [..._DEFAULT_QUESTION_INDICATORS];
let _opinionPrefixes: readonly string[] = [..._DEFAULT_OPINION_PREFIXES];
let _followUpConfirms: readonly string[] = [..._DEFAULT_FOLLOW_UP_CONFIRMS];
let _queryKeywords: readonly string[] = [..._DEFAULT_QUERY_KEYWORDS];
let _uiPatternVerbs: readonly string[] = [..._DEFAULT_UI_PATTERN_VERBS];
let _uiPatternTargets: readonly string[] = [..._DEFAULT_UI_PATTERN_TARGETS];
let _uiDisplayVerbs: readonly string[] = [..._DEFAULT_UI_DISPLAY_VERBS];
let _multimodalHints: readonly MultimodalHintEntry[] = [...DEFAULT_MULTIMODAL_HINTS];

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
  queryKeywords?: string[];
  uiPatternVerbs?: string[];
  uiPatternTargets?: string[];
  uiDisplayVerbs?: string[];
  multimodalHints?: MultimodalHintEntry[];
}): void {
  _greetingWords = data.greetingWords ?? [..._DEFAULT_GREETING_WORDS];
  _collabKeywords = data.collabKeywords ?? [..._DEFAULT_COLLAB_KEYWORDS];
  _highRiskKeywords = data.highRiskKeywords ?? [];
  _interventionPatterns = (data.interventionPatterns ?? []).map((p) => ({
    re: new RegExp(p.re),
    type: p.type as _InterventionEntry["type"],
  }));
  _executeRequestPrefixes = data.executeRequestPrefixes ?? [..._DEFAULT_EXECUTE_REQUEST_PREFIXES];
  _executeActionVerbs = data.executeActionVerbs ?? [..._DEFAULT_EXECUTE_ACTION_VERBS];
  _questionIndicators = data.questionIndicators ?? [..._DEFAULT_QUESTION_INDICATORS];
  _opinionPrefixes = data.opinionPrefixes ?? [..._DEFAULT_OPINION_PREFIXES];
  _followUpConfirms = data.followUpConfirms ?? [..._DEFAULT_FOLLOW_UP_CONFIRMS];
  _queryKeywords = data.queryKeywords ?? [..._DEFAULT_QUERY_KEYWORDS];
  _uiPatternVerbs = data.uiPatternVerbs ?? [..._DEFAULT_UI_PATTERN_VERBS];
  _uiPatternTargets = data.uiPatternTargets ?? [..._DEFAULT_UI_PATTERN_TARGETS];
  _uiDisplayVerbs = data.uiDisplayVerbs ?? [..._DEFAULT_UI_DISPLAY_VERBS];
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
  QUERY_KEYWORDS = _queryKeywords;
  UI_PATTERN_VERBS = _uiPatternVerbs;
  UI_PATTERN_TARGETS = _uiPatternTargets;
  UI_DISPLAY_VERBS = _uiDisplayVerbs;
  _multimodalHints = data.multimodalHints?.length ? data.multimodalHints : DEFAULT_MULTIMODAL_HINTS;
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
/*  4g. 查询特征词 — query 类别                                         */
/* ================================================================== */

export let QUERY_KEYWORDS: readonly string[] = _queryKeywords;

/* ================================================================== */
/*  4h. UI 生成模式动词 — ui 类别                                       */
/* ================================================================== */

export let UI_PATTERN_VERBS: readonly string[] = _uiPatternVerbs;

/* ================================================================== */
/*  4i. UI 生成模式目标词 — ui 类别                                     */
/* ================================================================== */

export let UI_PATTERN_TARGETS: readonly string[] = _uiPatternTargets;

/* ================================================================== */
/*  4j. UI 展示动词 — ui 类别                                           */
/* ================================================================== */

export let UI_DISPLAY_VERBS: readonly string[] = _uiDisplayVerbs;

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
