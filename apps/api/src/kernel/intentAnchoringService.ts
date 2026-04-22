/**
 * Intent Anchoring Service — 意图锚定与越界熔断服务
 *
 * P0-2: 确保人类意图对齐，所有高级自治能力须在'可控边界'内运行。
 *
 * 编排骨架：类型定义 + 用户消息解析入口。
 * 子模块：
 *   - intentAnchorRules.ts        — 规则加载（anchor rules JSON）
 *   - intentAnchorRepo.ts         — 锚定 CRUD
 *   - intentBoundaryDetection.ts  — 边界检测 + 熔断执行
 *
 * @module intentAnchoringService
 */
import type { Pool } from "pg";
import { resolveNumber } from "@openslin/shared";

/* ── Re-export 子模块，保持外部引用兼容 ── */
export { getAnchorRules, loadAnchorRules } from "./intentAnchorRules";
export type { AnchorPatternRule } from "./intentAnchorRules";
export {
  createIntentAnchor,
  createIntentAnchorsBatch,
  listActiveIntentAnchors,
  deactivateIntentAnchor,
  recordBoundaryViolation,
} from "./intentAnchorRepo";
export { checkAndEnforceIntentBoundary, detectIntentBoundary, extractKeywords, isConstraintSatisfied, isConflictingAction, getViolationTypeLabel } from "./intentBoundaryDetection";
export type { IntentDriftResult, BoundaryCheckResult } from "./intentBoundaryDetection";

import { getAnchorRules } from "./intentAnchorRules";
import { createIntentAnchorsBatch } from "./intentAnchorRepo";

/* （规则加载已移至 intentAnchorRules.ts） */

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type InstructionType = 'explicit_command' | 'constraint' | 'preference' | 'prohibition';

export interface IntentAnchor {
  anchorId: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  originalInstruction: string;
  instructionDigest: string;
  instructionType: InstructionType;
  runId: string | null;
  taskId: string | null;
  conversationId: string | null;
  priority: number;
  isActive: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

export type ViolationType = 'intent_override' | 'constraint_breach' | 'prohibition_violation';
export type ViolationSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ActionTaken = 'auto_reverted' | 'paused_for_review' | 'escalated' | 'ignored';

export interface BoundaryViolation {
  violationId: string;
  tenantId: string;
  spaceId: string | null;
  violationType: ViolationType;
  severity: ViolationSeverity;
  anchorId: string | null;
  runId: string;
  stepId: string | null;
  agentAction: string;
  userIntent: string;
  actionTaken: ActionTaken;
  remediationDetails: Record<string, unknown> | null;
  detectedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

export interface AnchorInput {
  tenantId: string;
  spaceId?: string | null;
  subjectId: string;
  instruction: string;
  instructionType: InstructionType;
  runId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  priority?: number;
  expiresAt?: Date | null;
  createdBy?: string | null;
}

export interface ViolationInput {
  tenantId: string;
  spaceId?: string | null;
  violationType: ViolationType;
  severity?: ViolationSeverity;
  anchorId?: string | null;
  runId: string;
  stepId?: string | null;
  agentAction: string;
  userIntent: string;
  actionTaken: ActionTaken;
  remediationDetails?: Record<string, unknown> | null;
  resolvedBy?: string | null;
}

//* （CRUD 已移至 intentAnchorRepo.ts，边界检测已移至 intentBoundaryDetection.ts） */

/* ================================================================== */
/*  Cumulative Drift Tracker — 跨轮次累积偏离检测                        */
/* ================================================================== */

/** 单轮偏离记录 */
export interface DriftEntry {
  iteration: number;
  /** 本轮偏离量 (0-1) */
  driftAmount: number;
  source: 'keyword' | 'llm' | 'cumulative';
  timestamp: number;
}

/** 累积偏离度跟踪器 */
export interface CumulativeDriftTracker {
  runId: string;
  sessionId: string;
  /** 当前累积偏离分数 */
  driftScore: number;
  /** 每轮的偏离记录 */
  driftHistory: DriftEntry[];
  /** 触发告警的阈值 */
  threshold: number;
  lastCheckedIteration: number;
}

/** 累积偏离检测结果 */
export interface CumulativeDriftResult {
  exceeded: boolean;
  currentScore: number;
  threshold: number;
}

const _driftTrackers = new Map<string, CumulativeDriftTracker>();

/**
 * 创建或获取漂移跟踪器
 *
 * 与 Agent Loop 生命周期一致，使用内存 Map 存储。
 * 默认阈值通过环境变量 INTENT_CUMULATIVE_DRIFT_THRESHOLD 配置，默认 3.0。
 */
export function getOrCreateDriftTracker(
  runId: string,
  sessionId: string,
  threshold?: number,
): CumulativeDriftTracker {
  const existing = _driftTrackers.get(runId);
  if (existing) return existing;

  const resolved = threshold ?? resolveNumber("INTENT_CUMULATIVE_DRIFT_THRESHOLD", undefined, undefined, 3.0).value;
  const tracker: CumulativeDriftTracker = {
    runId,
    sessionId,
    driftScore: 0,
    driftHistory: [],
    threshold: resolved,
    lastCheckedIteration: 0,
  };
  _driftTrackers.set(runId, tracker);
  return tracker;
}

/**
 * 记录一次偏离并返回是否超过阈值
 */
export function recordDrift(
  tracker: CumulativeDriftTracker,
  iteration: number,
  driftAmount: number,
  source: 'keyword' | 'llm' | 'cumulative',
): CumulativeDriftResult {
  tracker.driftScore += driftAmount;
  tracker.driftHistory.push({
    iteration,
    driftAmount,
    source,
    timestamp: Date.now(),
  });
  tracker.lastCheckedIteration = iteration;

  return {
    exceeded: tracker.driftScore >= tracker.threshold,
    currentScore: tracker.driftScore,
    threshold: tracker.threshold,
  };
}

/**
 * 重置漂移跟踪器（用户确认继续后调用）
 */
export function resetDriftTracker(runId: string): void {
  const tracker = _driftTrackers.get(runId);
  if (tracker) {
    tracker.driftScore = 0;
    tracker.driftHistory = [];
  }
}

/**
 * 清理漂移跟踪器（运行结束后调用，防止内存泄漏）
 */
export function cleanupDriftTracker(runId: string): void {
  _driftTrackers.delete(runId);
}

//* ================================================================== */
/*  服务入口 — 解析用户消息中的显式指令                                */
/* ================================================================== */

/**
 * 解析用户消息中的显式指令，自动创建意图锚点
 *
 * 应在 dispatch 层调用，识别如“不要删除文件”、“必须使用工具X”等指令
 */
export async function parseAndAnchorUserIntentions(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  message: string;
  runId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
}): Promise<IntentAnchor[]> {
  const { pool, tenantId, spaceId, subjectId, message, runId, taskId, conversationId } = params;

  const anchors: AnchorInput[] = [];
  const anchorRules = getAnchorRules();

  // P0-7: 使用可配置的规则模式替代硬编码正则
  for (const rule of anchorRules.prohibition) {
    const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
    const pattern = new RegExp(rule.re.source, flags);
    let match;
    while ((match = pattern.exec(message)) !== null) {
      anchors.push({
        tenantId, spaceId, subjectId,
        instruction: match[0],
        instructionType: "prohibition",
        runId, taskId, conversationId,
        priority: rule.priority,
      });
    }
  }

  for (const rule of anchorRules.constraint) {
    const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
    const pattern = new RegExp(rule.re.source, flags);
    let match;
    while ((match = pattern.exec(message)) !== null) {
      anchors.push({
        tenantId, spaceId, subjectId,
        instruction: match[0],
        instructionType: "constraint",
        runId, taskId, conversationId,
        priority: rule.priority,
      });
    }
  }

  return await createIntentAnchorsBatch(pool, anchors);
}
