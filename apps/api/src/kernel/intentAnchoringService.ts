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
export { checkAndEnforceIntentBoundary, extractKeywords, isConstraintSatisfied, isConflictingAction, getViolationTypeLabel } from "./intentBoundaryDetection";

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
