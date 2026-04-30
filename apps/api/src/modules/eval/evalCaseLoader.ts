/**
 * Eval Case Loader — 评测语料外部化加载 + 动态扩展 + 版本管理
 *
 * P2: 从 JSON 文件动态加载评测用例，支持：
 * 1. 文件系统外部化（eval-cases.json）
 * 2. 动态扩展（运行时追加用例）
 * 3. 版本管理（JSON 中包含 version + updatedAt）
 * 4. fallback 到编译时默认值（evalCases.ts 中的 const）
 *
 * 环境变量：
 * - EVAL_CASES_PATH: 评测用例 JSON 文件路径（默认同目录下 eval-cases.json）
 */

import * as fs from "fs";
import * as path from "path";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "evalCaseLoader" });
import type { IntentEvalCase, KnowledgeEvalCase, DecomposeEvalCase, EvalCase } from "./evalSuite";

/* ================================================================== */
/*  1. JSON 结构类型                                                      */
/* ================================================================== */

/** JSON 中意图用例的原始结构（不含 category 字段，由 loader 自动补全） */
interface IntentEvalCaseJson {
  id: string;
  input: string;
  context?: { conversationHistory?: Array<{ role: string; content: string }> };
  expected: {
    intent: "chat" | "ui" | "query" | "task" | "collab";
    minConfidence?: number;
    suggestedToolRefs?: string[];
    requiresConfirmation?: boolean;
    /** 端到端：期望的系统行为 */
    expectedBehavior?: string;
    /** 端到端：验收标准 */
    acceptanceCriteria?: string;
  };
}

interface KnowledgeEvalCaseJson {
  id: string;
  input: string;
  expected: {
    minResults?: number;
    containsKeywords?: string[];
    minRelevanceScore?: number;
    excludeKeywords?: string[];
  };
}

interface DecomposeEvalCaseJson {
  id: string;
  input: string;
  complexity: string;
  expected: {
    minSubGoals?: number;
    maxSubGoals?: number;
    dagValid?: boolean;
    expectedToolRefs?: string[];
    expectedConditionKeywords?: string[];
    requiresApproval?: boolean;
    hasWriteOperation?: boolean;
    expectedDependencyTypes?: string[];
    shouldEarlyExit?: boolean;
    /** 端到端：计划是否期望可执行 */
    expectedExecutable?: boolean;
    /** 端到端：执行成功标准 */
    executionSuccessCriteria?: string;
  };
}

interface EvalCasesJson {
  version: number;
  description?: string;
  updatedAt?: string;
  intent?: IntentEvalCaseJson[];
  knowledge?: KnowledgeEvalCaseJson[];
  decompose?: DecomposeEvalCaseJson[];
}

/* ================================================================== */
/*  2. Loader 核心                                                        */
/* ================================================================== */

/** 已加载的快照 */
interface EvalCaseSnapshot {
  version: number;
  loadedAt: number;
  source: "json" | "default" | "runtime_appended";
  intentCases: IntentEvalCase[];
  knowledgeCases: KnowledgeEvalCase[];
  decomposeCases: DecomposeEvalCase[];
}

let _snapshot: EvalCaseSnapshot | null = null;

/**
 * 从 JSON 文件加载评测用例
 */
function loadJsonEvalCases(filePath: string): EvalCasesJson | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as EvalCasesJson;
    if (typeof parsed.version !== "number") return null;
    return parsed;
  } catch (err) {
        _logger.warn("Failed to load eval cases", { filePath, err: (err as Error).message });
    return null;
  }
}

/** 将 JSON 意图用例转换为带 category 的 TypeScript 类型 */
function toIntentEvalCases(items: IntentEvalCaseJson[]): IntentEvalCase[] {
  return items.map((c) => ({ ...c, category: "intent" as const }));
}

function toKnowledgeEvalCases(items: KnowledgeEvalCaseJson[]): KnowledgeEvalCase[] {
  return items.map((c) => ({ ...c, category: "knowledge" as const }));
}

function toDecomposeEvalCases(items: DecomposeEvalCaseJson[]): DecomposeEvalCase[] {
  return items.map((c) => ({
    ...c,
    category: "decompose" as const,
    complexity: c.complexity as DecomposeEvalCase["complexity"],
    expected: {
      ...c.expected,
      expectedDependencyTypes: c.expected.expectedDependencyTypes as DecomposeEvalCase["expected"]["expectedDependencyTypes"],
    },
  }));
}

/* ================================================================== */
/*  3. 公共 API                                                           */
/* ================================================================== */

/**
 * 初始化评测用例加载器
 * 从 JSON 文件加载用例，失败时 fallback 到编译时默认值
 */
export function initEvalCaseLoader(): EvalCaseSnapshot {
  const jsonPath = process.env.EVAL_CASES_PATH
    || path.resolve(__dirname, "eval-cases.json");
  const json = loadJsonEvalCases(jsonPath);

  if (json) {
    _snapshot = {
      version: json.version,
      loadedAt: Date.now(),
      source: "json",
      intentCases: json.intent ? toIntentEvalCases(json.intent) : [],
      knowledgeCases: json.knowledge ? toKnowledgeEvalCases(json.knowledge) : [],
      decomposeCases: json.decompose ? toDecomposeEvalCases(json.decompose) : [],
    };
    if (process.env.NODE_ENV !== "production") {
      const total = _snapshot.intentCases.length
        + _snapshot.knowledgeCases.length + _snapshot.decomposeCases.length;
          _logger.info("Loaded eval cases", { version: _snapshot.version, total, jsonPath });
    }
    return _snapshot;
  }

  // fallback 到编译时默认值
  const {
    intentEvalCases, knowledgeEvalCases, decomposeEvalCases,
  } = require("./evalCases");
  _snapshot = {
    version: 0,
    loadedAt: Date.now(),
    source: "default",
    intentCases: intentEvalCases,
    knowledgeCases: knowledgeEvalCases,
    decomposeCases: decomposeEvalCases,
  };
  return _snapshot;
}

/**
 * 获取当前评测用例快照
 * 如果未初始化则自动初始化
 */
export function getEvalCaseSnapshot(): Readonly<EvalCaseSnapshot> {
  if (!_snapshot) initEvalCaseLoader();
  return _snapshot!;
}

/**
 * 强制重新加载评测用例（从 JSON 文件）
 */
export function forceReloadEvalCases(): EvalCaseSnapshot {
  _snapshot = null;
  return initEvalCaseLoader();
}

/**
 * 运行时追加评测用例（用于动态扩展）
 */
export function appendEvalCases(cases: EvalCase[]): void {
  if (!_snapshot) initEvalCaseLoader();
  const snap = _snapshot!;
  for (const c of cases) {
    switch (c.category) {
      case "intent": snap.intentCases.push(c as IntentEvalCase); break;
      case "knowledge": snap.knowledgeCases.push(c as KnowledgeEvalCase); break;
      case "decompose": snap.decomposeCases.push(c as DecomposeEvalCase); break;
    }
  }
  snap.source = "runtime_appended";
}

/**
 * 获取所有评测用例（合并全部分类）
 */
export function getAllEvalCases(): EvalCase[] {
  const snap = getEvalCaseSnapshot();
  return [
    ...snap.intentCases,
    ...snap.knowledgeCases,
    ...snap.decomposeCases,
  ];
}

/**
 * 按分类获取评测用例
 */
export function getEvalCasesByCategory(category: "intent" | "knowledge" | "decompose"): EvalCase[] {
  const snap = getEvalCaseSnapshot();
  switch (category) {
    case "intent": return snap.intentCases;
    case "knowledge": return snap.knowledgeCases;
    case "decompose": return snap.decomposeCases;
    default: return [];
  }
}

/**
 * 获取加载状态（治理端点用）
 */
export function getEvalCaseLoaderStatus(): {
  version: number;
  source: string;
  loadedAt: number;
  counts: { intent: number; knowledge: number; decompose: number; total: number };
} {
  const snap = getEvalCaseSnapshot();
  return {
    version: snap.version,
    source: snap.source,
    loadedAt: snap.loadedAt,
    counts: {
      intent: snap.intentCases.length,
      knowledge: snap.knowledgeCases.length,
      decompose: snap.decomposeCases.length,
      total: snap.intentCases.length
        + snap.knowledgeCases.length + snap.decomposeCases.length,
    },
  };
}
