/**
 * Intent Rule Standard — 统一意图规则标准化库
 *
 * **设计意图**：
 * 建立单一规则数据源（Single Source of Truth），消除 Orchestrator intentClassifier.classifyIntentFast()
 * 与 Intent-Analyzer analyzer.detectIntentByRules() 之间 60%+ 的规则重叠。
 *
 * **与 intentVocabulary 的关系**：
 * 本模块不拥有词表数据，所有规则均从 intentVocabulary.getActiveVocab() 返回的动态词表动态构建。
 * intentVocabulary 负责词表的存储与生命周期管理（加载、注入、降级），
 * 本模块只消费词表、输出标准化的 IntentRulePattern 集合。
 *
 * **无硬编码承诺**：
 * 全部正则基于词表动态生成，零硬编码字符串匹配。
 * 空词表场景使用 /(?!)/ （永不匹配正则）优雅降级，不会抛出异常。
 */

import {
  getActiveVocab,
  getInterventionPatterns,
  type ActiveVocab,
} from "./intentVocabulary";

/* ================================================================== */
/*  0. 类型定义                                                        */
/* ================================================================== */

/** 意图类型 — 与 intent-analyzer 的 IntentType 保持一致 */
export type IntentType = "chat" | "ui" | "query" | "task" | "collab";

/** 规则分类 */
export type RuleCategory =
  | "greeting"
  | "collab"
  | "intervention"
  | "execute"
  | "query"
  | "ui"
  | "opinion"
  | "followup"
  | "question";

/** 标准化规则模式 */
export interface IntentRulePattern {
  /** 规则唯一 ID（如 "std_greeting"） */
  id: string;
  /** 规则名称（如 "问候检测"） */
  name: string;
  /** 目标意图类型 */
  intent: IntentType;
  /** 匹配正则 */
  pattern: RegExp;
  /** 匹配置信度 (0-1) */
  confidence: number;
  /** 优先级（越小越优先） */
  priority: number;
  /** 规则分类 */
  category: RuleCategory;
  /** 是否需要上下文（默认 false） */
  requiresContext?: boolean;
}

/* ================================================================== */
/*  1. 正则构建辅助函数                                                  */
/* ================================================================== */

/** 安全正则转义 */
function _escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 永不匹配的正则 — 空词表时的安全降级 */
const NEVER_MATCH: RegExp = /(?!)/;

/**
 * 从词表构建"包含匹配"正则（词表中任一词出现在消息中即命中）。
 * 空词表返回永不匹配正则。
 */
function _buildContainsRegex(words: readonly string[]): RegExp {
  if (words.length === 0) return NEVER_MATCH;
  return new RegExp(`(${words.map(_escapeForRegex).join("|")})`, "i");
}

/**
 * 从词表构建"完全匹配"正则（消息必须完全等于词表中某一词才命中）。
 * 空词表返回永不匹配正则。
 */
function _buildExactMatchRegex(words: readonly string[]): RegExp {
  if (words.length === 0) return NEVER_MATCH;
  return new RegExp(`^(${words.map(_escapeForRegex).join("|")})$`, "i");
}

/**
 * 从词表构建"前缀匹配"正则（消息以词表中某一词开头即命中）。
 * 空词表返回永不匹配正则。
 */
function _buildPrefixRegex(words: readonly string[]): RegExp {
  if (words.length === 0) return NEVER_MATCH;
  return new RegExp(`^(${words.map(_escapeForRegex).join("|")})`, "i");
}

/* ================================================================== */
/*  2. buildStandardRules — 从动态词表构建标准规则集                       */
/* ================================================================== */

/**
 * 从 `getActiveVocab()` 返回的动态词表构建标准化规则集。
 *
 * - 所有正则均从词表动态构建，无硬编码字符串匹配。
 * - 词表字段为空数组时，对应规则生成永不匹配的正则，优雅降级。
 * - 干预模式（intervention）规则直接复用 intentVocabulary 内部的
 *   INTERVENTION_PATTERNS 结构（已包含预编译正则），此处通过延迟导入获取。
 *
 * @param vocab - 词表快照，默认从 getActiveVocab() 获取
 * @returns 按 priority 升序排列的标准规则数组
 */
export function buildStandardRules(
  vocab: ActiveVocab = getActiveVocab(),
): IntentRulePattern[] {
  const rules: IntentRulePattern[] = [];

  // ── 直接从 vocab 获取词表，无降级默认值，空数组则生成永不匹配正则 ──

  // ── P10: 问候检测（完全匹配） ──
  rules.push({
    id: "std_greeting",
    name: "问候检测",
    intent: "chat",
    pattern: _buildExactMatchRegex(vocab.greetingWords),
    confidence: 0.85,
    priority: 10,
    category: "greeting",
  });

  // ── P20: 协作关键词（包含匹配） ──
  rules.push({
    id: "std_collab",
    name: "协作关键词检测",
    intent: "collab",
    pattern: _buildContainsRegex(vocab.collabKeywords),
    confidence: 0.78,
    priority: 20,
    category: "collab",
  });

  // ── P30: 干预意图（正则匹配） ──
  {
    let interventionRegex: RegExp = NEVER_MATCH;
    const patterns = getInterventionPatterns();
    if (patterns && patterns.length > 0) {
      interventionRegex = new RegExp(
        patterns.map((p) => `(${p.re.source})`).join("|"),
        "i",
      );
    }
    rules.push({
      id: "std_intervention",
      name: "干预意图检测",
      intent: "chat",
      pattern: interventionRegex,
      confidence: 0.86,
      priority: 30,
      category: "intervention",
    });
  }

  // ── P40: 执行请求前缀（前缀匹配） ──
  rules.push({
    id: "std_execute_prefix",
    name: "执行请求前缀检测",
    intent: "task",
    pattern: _buildPrefixRegex(vocab.executeRequestPrefixes),
    confidence: 0.85,
    priority: 40,
    category: "execute",
  });

  // ── P50: 执行动作词（包含匹配） ──
  rules.push({
    id: "std_execute_verb",
    name: "执行动作词检测",
    intent: "task",
    pattern: _buildContainsRegex(vocab.executeActionVerbs),
    confidence: 0.82,
    priority: 50,
    category: "execute",
  });

  // ── P55: UI 生成模式（组合正则：动词 + .* + 目标词） ──
  // 优先于 query，避免“弄报表”被 query 词表截获
  {
    const verbs: readonly string[] = vocab.uiPatternVerbs;
    const targets: readonly string[] = vocab.uiPatternTargets;
  
    let uiRegex: RegExp = NEVER_MATCH;
    if (verbs.length > 0 && targets.length > 0) {
      const verbsPart = verbs.map(_escapeForRegex).join("|");
      const targetsPart = targets.map(_escapeForRegex).join("|");
      uiRegex = new RegExp(`(${verbsPart}).*(${targetsPart})`, "i");
    }
    rules.push({
      id: "std_ui",
      name: "UI 生成模式检测",
      intent: "ui",
      pattern: uiRegex,
      confidence: 0.82,
      priority: 55,
      category: "ui",
    });
  }
  
  // ── P60: 查询特征词（包含匹配） ──
  {
    rules.push({
      id: "std_query",
      name: "查询模式检测",
      intent: "query",
      pattern: _buildContainsRegex(vocab.queryKeywords),
      confidence: 0.72,
      priority: 60,
      category: "query",
    });
  }
  
  // ── P68: UI 展示动词独立匹配（单独出现“显示”“展示”即命中 UI） ──
  // 与 P55 组合规则互补：组合匹配置信度更高 (0.82)，独立匹配置信度适中 (0.72)
  {
    rules.push({
      id: "std_ui_display",
      name: "UI 展示动词独立检测",
      intent: "ui",
      pattern: _buildContainsRegex(vocab.uiDisplayVerbs),
      confidence: 0.72,
      priority: 68,
      category: "ui",
    });
  }

  // ── P80: 观点/意见表达前缀（前缀匹配） ──
  rules.push({
    id: "std_opinion",
    name: "观点表达检测",
    intent: "chat",
    pattern: _buildPrefixRegex(vocab.opinionPrefixes),
    confidence: 0.78,
    priority: 80,
    category: "opinion",
  });

  // ── P90: 跟进确认词（完全匹配） ──
  rules.push({
    id: "std_followup",
    name: "跟进确认检测",
    intent: "chat",
    pattern: _buildExactMatchRegex(vocab.followUpConfirms),
    confidence: 0.80,
    priority: 90,
    category: "followup",
    requiresContext: true,
  });

  // ── P100: 问句指示词（包含匹配） ──
  rules.push({
    id: "std_question",
    name: "问句模式检测",
    intent: "chat",
    pattern: _buildContainsRegex(vocab.questionIndicators),
    confidence: 0.72,
    priority: 100,
    category: "question",
  });

  // 按 priority 升序排序保证执行顺序
  rules.sort((a, b) => a.priority - b.priority);

  return rules;
}

/* ================================================================== */
/*  3. matchStandardRules — 规则匹配引擎                                */
/* ================================================================== */

/**
 * 按 priority 升序逐条匹配，第一个命中即返回（短路匹配，与 classifyIntentFast 行为一致）。
 *
 * @param message - 用户消息（原始文本）
 * @param rules   - 标准规则集（通常由 buildStandardRules() 生成）
 * @returns 首个命中规则的意图 + 置信度 + 规则 ID，或 null（无命中）
 */
export function matchStandardRules(
  message: string,
  rules: IntentRulePattern[],
): {
  intent: IntentType;
  confidence: number;
  matchedRule: string;
  matchedText?: string;
} | null {
  const msg = message.trim();
  if (!msg) return null;

  // 确保按 priority 升序
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sorted) {
    // 需要上下文的规则在无上下文场景中跳过，避免跟进词（如"继续"）抢占上下文意图
    if (rule.requiresContext) continue;
    const m = rule.pattern.exec(msg);
    if (m) {
      return {
        intent: rule.intent,
        confidence: rule.confidence,
        matchedRule: rule.id,
        matchedText: m[1] || m[0],
      };
    }
  }

  return null;
}
