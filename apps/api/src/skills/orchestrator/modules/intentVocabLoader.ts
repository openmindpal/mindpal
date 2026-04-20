import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:intentVocabLoader" });

/**
 * Intent Vocabulary Loader — 极薄词表加载 + 热更新 + 租户级别覆盖
 *
 * 架构重构：词表大幅精简，仅保留快速短路规则所需的最小数据集。
 * 意图分类已改由 LLM 处理，词表不再是系统核心资产。
 *
 * 支持：
 * 1. 文件系统热更新（定时轮询）
 * 2. 租户级别自定义覆盖（merge 到全局基线）
 * 3. fallback 到编译时默认值（intentVocabulary.ts 中的 const）
 *
 * 环境变量：
 * - INTENT_VOCAB_PATH: 词表 JSON 文件路径（默认同目录下 intent-vocab.json）
 * - INTENT_VOCAB_RELOAD_MS: 热更新轮询间隔毫秒（默认 30000，设为 0 禁用）
 * - INTENT_VOCAB_TENANT_DIR: 租户词表目录（每个租户一个 JSON 文件，如 tenant-xxx.json）
 */

import * as fs from "fs";
import * as path from "path";

/* ================================================================== */
/*  1. 类型定义                                                           */
/* ================================================================== */

/** 多模态提示规则类型（从 intentVocabulary 重导出，避免重复定义） */
export type { MultimodalHintEntry } from "./intentVocabulary";
import type { MultimodalHintEntry } from "./intentVocabulary";

/** 词表 JSON 文件的结构（精简后仅保留快速短路规则所需字段） */
export interface IntentVocabJson {
  version: number;
  description?: string;
  updatedAt?: string;
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
  /** 多模态附件感知提示规则（词表驱动，支持 JSON 热更新） */
  multimodalHints?: MultimodalHintEntry[];
}

/** 已加载并 merge 后的词表快照（精简后仅保留短路层所需字段） */
export interface VocabSnapshot {
  version: number;
  loadedAt: number;
  source: "json" | "default" | "tenant_override";
  greetingWords: string[];
  collabKeywords: string[];
  highRiskKeywords: string[];
  executeRequestPrefixes: string[];
  executeActionVerbs: string[];
  questionIndicators: string[];
  opinionPrefixes: string[];
  followUpConfirms: string[];
  queryKeywords: string[];
  uiPatternVerbs: string[];
  uiPatternTargets: string[];
  uiDisplayVerbs: string[];
  multimodalHints: MultimodalHintEntry[];
}

/* ================================================================== */
/*  2. 默认值（从 intentVocabulary.ts 导入作为 fallback）                   */
/* ================================================================== */

import {
  GREETING_WORDS, COLLAB_KEYWORDS,
  HIGH_RISK_KEYWORDS,
  EXECUTE_REQUEST_PREFIXES, EXECUTE_ACTION_VERBS,
  QUESTION_INDICATORS, OPINION_PREFIXES, FOLLOW_UP_CONFIRMS,
  QUERY_KEYWORDS, UI_PATTERN_VERBS, UI_PATTERN_TARGETS, UI_DISPLAY_VERBS,
  registerVocabProvider,
  _initVocabData,
  DEFAULT_MULTIMODAL_HINTS,
} from "./intentVocabulary";

const DEFAULT_SNAPSHOT: VocabSnapshot = {
  version: 0,
  loadedAt: Date.now(),
  source: "default",
  greetingWords: [...GREETING_WORDS],
  collabKeywords: [...COLLAB_KEYWORDS],
  highRiskKeywords: [...HIGH_RISK_KEYWORDS],
  executeRequestPrefixes: [...EXECUTE_REQUEST_PREFIXES],
  executeActionVerbs: [...EXECUTE_ACTION_VERBS],
  questionIndicators: [...QUESTION_INDICATORS],
  opinionPrefixes: [...OPINION_PREFIXES],
  followUpConfirms: [...FOLLOW_UP_CONFIRMS],
  queryKeywords: [...QUERY_KEYWORDS],
  uiPatternVerbs: [...UI_PATTERN_VERBS],
  uiPatternTargets: [...UI_PATTERN_TARGETS],
  uiDisplayVerbs: [...UI_DISPLAY_VERBS],
  multimodalHints: [...DEFAULT_MULTIMODAL_HINTS],
};

/* ================================================================== */
/*  3. Loader 核心                                                        */
/* ================================================================== */

/** 当前全局词表快照 */
let _currentSnapshot: VocabSnapshot = { ...DEFAULT_SNAPSHOT };

/** 各租户的覆盖词表缓存 */
const _tenantOverrides = new Map<string, Partial<IntentVocabJson>>();

/** 轮询计时器 */
let _reloadTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 从 JSON 文件加载词表
 */
function loadJsonVocab(filePath: string): IntentVocabJson | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as IntentVocabJson;
    if (typeof parsed.version !== "number") return null;
    return parsed;
  } catch (err) {
    _logger.warn("failed to load vocab", { filePath, error: (err as Error).message });
    return null;
  }
}

/**
 * 将 JSON 词表合并到快照（非空字段覆盖，空字段保留默认值）
 */
function mergeVocab(base: VocabSnapshot, overlay: Partial<IntentVocabJson>, source: VocabSnapshot["source"]): VocabSnapshot {
  return {
    version: overlay.version ?? base.version,
    loadedAt: Date.now(),
    source,
    greetingWords: overlay.greetingWords?.length ? overlay.greetingWords : base.greetingWords,
    collabKeywords: overlay.collabKeywords?.length ? overlay.collabKeywords : base.collabKeywords,
    highRiskKeywords: overlay.highRiskKeywords?.length ? overlay.highRiskKeywords : base.highRiskKeywords,
    executeRequestPrefixes: overlay.executeRequestPrefixes?.length ? overlay.executeRequestPrefixes : base.executeRequestPrefixes,
    executeActionVerbs: overlay.executeActionVerbs?.length ? overlay.executeActionVerbs : base.executeActionVerbs,
    questionIndicators: overlay.questionIndicators?.length ? overlay.questionIndicators : base.questionIndicators,
    opinionPrefixes: overlay.opinionPrefixes?.length ? overlay.opinionPrefixes : base.opinionPrefixes,
    followUpConfirms: overlay.followUpConfirms?.length ? overlay.followUpConfirms : base.followUpConfirms,
    queryKeywords: overlay.queryKeywords?.length ? overlay.queryKeywords : base.queryKeywords,
    uiPatternVerbs: overlay.uiPatternVerbs?.length ? overlay.uiPatternVerbs : base.uiPatternVerbs,
    uiPatternTargets: overlay.uiPatternTargets?.length ? overlay.uiPatternTargets : base.uiPatternTargets,
    uiDisplayVerbs: overlay.uiDisplayVerbs?.length ? overlay.uiDisplayVerbs : base.uiDisplayVerbs,
    multimodalHints: overlay.multimodalHints?.length ? overlay.multimodalHints : base.multimodalHints,
  };
}

/**
 * 重新加载全局词表
 */
function reloadGlobalVocab(): void {
  const vocabPath = process.env.INTENT_VOCAB_PATH
    || path.resolve(__dirname, "intent-vocab.json");
  const json = loadJsonVocab(vocabPath);
  if (json) {
    _currentSnapshot = mergeVocab(DEFAULT_SNAPSHOT, json, "json");
    if (process.env.NODE_ENV !== "production") {
      _logger.info("loaded vocab", { version: _currentSnapshot.version, path: vocabPath });
    }
  }
}

/* ================================================================== */
/*  4. 公共 API                                                           */
/* ================================================================== */

/**
 * 初始化词表加载器（应用启动时调用一次）
 * 
 * - 加载全局 JSON 词表
 * - 启动定时热更新轮询（如配置了 INTENT_VOCAB_RELOAD_MS）
 */
export function initVocabLoader(): void {
  reloadGlobalVocab();

  // 注入初始词表数据到 intentVocabulary 的导出常量
  const vocabPath = process.env.INTENT_VOCAB_PATH
    || path.resolve(__dirname, "intent-vocab.json");
  const initJson = loadJsonVocab(vocabPath);
  if (initJson) {
    _initVocabData(initJson);
  }

  // 注册到 intentVocabulary 的动态词表桥接
  registerVocabProvider(() => {
    if (_currentSnapshot.source === "default") return null;
    return _currentSnapshot;
  });

  // 热更新轮询
  const reloadMs = parseInt(process.env.INTENT_VOCAB_RELOAD_MS ?? "30000", 10);
  if (reloadMs > 0 && !_reloadTimer) {
    _reloadTimer = setInterval(reloadGlobalVocab, reloadMs);
    // 允许进程正常退出
    if (_reloadTimer && typeof _reloadTimer === "object" && "unref" in _reloadTimer) {
      (_reloadTimer as NodeJS.Timeout).unref();
    }
  }
}

/**
 * 获取当前全局词表快照
 */
export function getVocabSnapshot(): Readonly<VocabSnapshot> {
  return _currentSnapshot;
}

/**
 * 获取租户定制的词表快照
 * 
 * 策略：在全局快照基础上 merge 租户覆盖。
 * 租户覆盖文件路径：$INTENT_VOCAB_TENANT_DIR/tenant-{tenantId}.json
 */
export function getTenantVocabSnapshot(tenantId: string): Readonly<VocabSnapshot> {
  // 检查缓存
  const cached = _tenantOverrides.get(tenantId);
  if (cached) {
    return mergeVocab(_currentSnapshot, cached, "tenant_override");
  }

  // 尝试加载租户文件
  const tenantDir = process.env.INTENT_VOCAB_TENANT_DIR;
  if (!tenantDir) return _currentSnapshot;

  const tenantFile = path.join(tenantDir, `tenant-${tenantId}.json`);
  const json = loadJsonVocab(tenantFile);
  if (json) {
    _tenantOverrides.set(tenantId, json);
    return mergeVocab(_currentSnapshot, json, "tenant_override");
  }

  return _currentSnapshot;
}

/**
 * 动态注册租户词表覆盖（API 调用方式，无需文件系统）
 */
export function setTenantVocabOverride(tenantId: string, override: Partial<IntentVocabJson>): void {
  _tenantOverrides.set(tenantId, override);
}

/**
 * 清除租户词表覆盖缓存
 */
export function clearTenantVocabOverride(tenantId: string): void {
  _tenantOverrides.delete(tenantId);
}

/**
 * 强制重新加载全局词表（手动触发）
 */
export function forceReloadVocab(): VocabSnapshot {
  reloadGlobalVocab();
  return _currentSnapshot;
}

/**
 * 获取词表加载状态（治理端点用）
 */
export function getVocabLoaderStatus(): {
  globalVersion: number;
  globalSource: string;
  globalLoadedAt: number;
  tenantOverrideCount: number;
  reloadIntervalMs: number;
} {
  return {
    globalVersion: _currentSnapshot.version,
    globalSource: _currentSnapshot.source,
    globalLoadedAt: _currentSnapshot.loadedAt,
    tenantOverrideCount: _tenantOverrides.size,
    reloadIntervalMs: parseInt(process.env.INTENT_VOCAB_RELOAD_MS ?? "30000", 10),
  };
}

/**
 * 停止热更新轮询（测试/关闭时使用）
 */
export function stopVocabLoader(): void {
  if (_reloadTimer) {
    clearInterval(_reloadTimer);
    _reloadTimer = null;
  }
}
