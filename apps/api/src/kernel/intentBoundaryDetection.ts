/**
 * intentBoundaryDetection.ts — 边界检测与熔断执行
 *
 * 在 Agent Loop 每轮迭代前检查当前计划动作是否违背用户意图。
 * 包含关键词匹配 + 可选 LLM 语义冲突检测。
 *
 * @module intentBoundaryDetection
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { StructuredLogger } from "@openslin/shared";
import type {
  IntentAnchor,
  BoundaryViolation as BoundaryViolationType,
  ViolationType,
  ViolationSeverity,
} from "./intentAnchoringService";
import { listActiveIntentAnchors, recordBoundaryViolation } from "./intentAnchorRepo";

const logger = new StructuredLogger({ module: "intentAnchoring.detection" });

/* ================================================================== */
/*  Main detection entry                                               */
/* ================================================================== */

/**
 * 检测并处理越界行为（核心熔断逻辑）
 *
 * 在 Agent Loop 每轮迭代前调用，检查当前计划动作是否违背用户意图。
 * 如果检测到越界，立即触发熔断。
 */
export async function checkAndEnforceIntentBoundary(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  runId: string;
  stepId?: string | null;
  proposedAction: string;
  currentContext?: string;
  /** P0-7: 可选 Fastify 实例，提供时启用 LLM 语义冲突检测 */
  app?: FastifyInstance;
  /** P0-7: 调用者主体信息（LLM 调用需要） */
  subject?: { tenantId: string; spaceId?: string; subjectId: string };
}): Promise<{
  isViolation: boolean;
  violation?: BoundaryViolationType;
  shouldPause: boolean;
  reason?: string;
}> {
  const { pool, tenantId, spaceId, subjectId, runId, stepId, proposedAction, currentContext, app, subject } = params;

  // 1. 获取所有活跃的意图锚点
  const anchors = await listActiveIntentAnchors({
    pool,
    tenantId,
    spaceId,
    subjectId,
    runId,
  });

  if (anchors.length === 0) {
    return { isViolation: false, shouldPause: false };
  }

  // 2. 关键词匹配检测
  const keywordResult = await _keywordBasedDetection({
    pool, tenantId, spaceId, runId, stepId, proposedAction, currentContext, anchors,
  });
  if (keywordResult) return keywordResult;

  // 3. P0-7: LLM 语义冲突检测（关键词未命中时）
  const useLlmCheck = (process.env.INTENT_ANCHOR_LLM_CHECK ?? "0") === "1" && app && subject;
  if (useLlmCheck) {
    const llmResult = await _llmBasedDetection({
      pool, tenantId, spaceId, runId, stepId, proposedAction, currentContext,
      app: app!, subject: subject!, anchors,
    });
    if (llmResult) return llmResult;
  }

  return { isViolation: false, shouldPause: false };
}

/* ================================================================== */
/*  Keyword-based detection                                            */
/* ================================================================== */

async function _keywordBasedDetection(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  runId: string;
  stepId?: string | null;
  proposedAction: string;
  currentContext?: string;
  anchors: IntentAnchor[];
}): Promise<{ isViolation: boolean; violation?: BoundaryViolationType; shouldPause: boolean; reason?: string } | null> {
  const { pool, tenantId, spaceId, runId, stepId, proposedAction, currentContext, anchors } = params;

  for (const anchor of anchors) {
    const instruction = anchor.originalInstruction.toLowerCase();
    const action = proposedAction.toLowerCase();

    let violationType: ViolationType | null = null;
    let severity: ViolationSeverity = "medium";

    // 检测禁令违例
    if (anchor.instructionType === "prohibition") {
      const forbiddenKeywords = extractKeywords(instruction);
      for (const keyword of forbiddenKeywords) {
        if (action.includes(keyword)) {
          violationType = "prohibition_violation";
          severity = "critical";
          break;
        }
      }
    }
    // 检测约束违背
    else if (anchor.instructionType === "constraint") {
      const constraintKeywords = extractKeywords(instruction);
      for (const keyword of constraintKeywords) {
        if (action.includes(keyword) && !isConstraintSatisfied(action, instruction)) {
          violationType = "constraint_breach";
          severity = "high";
          break;
        }
      }
    }
    // 检测意图覆盖
    else if (anchor.instructionType === "explicit_command") {
      if (isConflictingAction(action, instruction)) {
        violationType = "intent_override";
        severity = "high";
      }
    }

    if (violationType) {
      const violation = await recordBoundaryViolation(pool, {
        tenantId,
        spaceId,
        violationType,
        severity,
        anchorId: anchor.anchorId,
        runId,
        stepId,
        agentAction: proposedAction,
        userIntent: anchor.originalInstruction,
        actionTaken: "paused_for_review",
        remediationDetails: {
          anchorPriority: anchor.priority,
          detectionMethod: "keyword_match",
          context: currentContext,
        },
      });

      return {
        isViolation: true,
        violation,
        shouldPause: true,
        reason: `检测到${getViolationTypeLabel(violationType)}: ${anchor.originalInstruction}`,
      };
    }
  }

  return null;
}

/* ================================================================== */
/*  LLM semantic detection                                             */
/* ================================================================== */

async function _llmBasedDetection(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  runId: string;
  stepId?: string | null;
  proposedAction: string;
  currentContext?: string;
  app: FastifyInstance;
  subject: { tenantId: string; spaceId?: string; subjectId: string };
  anchors: IntentAnchor[];
}): Promise<{ isViolation: boolean; violation?: BoundaryViolationType; shouldPause: boolean; reason?: string } | null> {
  const { pool, tenantId, spaceId, runId, stepId, proposedAction, currentContext, app, subject, anchors } = params;

  for (const anchor of anchors) {
    if (anchor.instructionType !== "prohibition" && anchor.instructionType !== "constraint") continue;
    try {
      const conflict = await _llmSemanticConflictCheck({
        app, subject,
        instruction: anchor.originalInstruction,
        instructionType: anchor.instructionType,
        proposedAction,
        context: currentContext,
      });
      if (conflict.isConflict) {
        const violationType: ViolationType =
          anchor.instructionType === "prohibition" ? "prohibition_violation" : "constraint_breach";
        const violation = await recordBoundaryViolation(pool, {
          tenantId,
          spaceId,
          violationType,
          severity: conflict.severity ?? "high",
          anchorId: anchor.anchorId,
          runId,
          stepId,
          agentAction: proposedAction,
          userIntent: anchor.originalInstruction,
          actionTaken: "paused_for_review",
          remediationDetails: {
            anchorPriority: anchor.priority,
            detectionMethod: "llm_semantic",
            llmReason: conflict.reason,
            context: currentContext,
          },
        });
        return {
          isViolation: true,
          violation,
          shouldPause: true,
          reason: `[LLM] 检测到${getViolationTypeLabel(violationType)}: ${conflict.reason}`,
        };
      }
    } catch (err) {
      logger.warn(`LLM semantic check failed: ${(err as Error)?.message}`);
    }
  }

  return null;
}

async function _llmSemanticConflictCheck(params: {
  app: FastifyInstance;
  subject: { tenantId: string; spaceId?: string; subjectId: string };
  instruction: string;
  instructionType: string;
  proposedAction: string;
  context?: string;
}): Promise<{ isConflict: boolean; reason?: string; severity?: ViolationSeverity }> {
  const { invokeModelChat } = await import("../lib/llm");
  const systemPrompt = `You are a safety reviewer. Determine if an AI agent's proposed action conflicts with a user's explicit instruction.
Respond with ONLY a JSON object: {"isConflict": boolean, "reason": string, "severity": "low"|"medium"|"high"|"critical"}
Do NOT include any other text.`;

  const userPrompt = `User instruction (${params.instructionType}): "${params.instruction}"
Agent proposed action: "${params.proposedAction}"${params.context ? `\nExecution context: ${params.context}` : ""}

Does the proposed action conflict with or violate the user's instruction?`;

  const result = await invokeModelChat({
    app: params.app,
    subject: params.subject,
    locale: "zh-CN",
    purpose: "intent_anchoring.semantic_check",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    timeoutMs: 5000,
  });

  const jsonMatch = result.outputText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { isConflict: false };
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    isConflict: !!parsed.isConflict,
    reason: parsed.reason,
    severity: parsed.severity,
  };
}

/* ================================================================== */
/*  Helper Functions                                                   */
/* ================================================================== */

/**
 * 提取指令中的关键词（中英文混合分词）
 *
 * 英文：按空白拆词 + 停用词过滤
 * 中文：连续汉字片段按 2-gram 滑动窗口切分，再过滤停用词
 */
export function extractKeywords(instruction: string): string[] {
  const EN_STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "can", "could", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "about", "that",
    "this", "it", "its", "and", "or", "but", "not", "no",
  ]);
  const CN_STOP_WORDS = new Set([
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
    "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会",
    "着", "没有", "看", "好", "自己", "这", "他", "她", "它", "们",
    "那", "些", "什么", "怎么", "如何", "请", "把", "被", "让", "给",
  ]);

  const lower = instruction.toLowerCase();
  const keywords: string[] = [];

  // 英文词
  const enWords = lower.match(/[a-z]{2,}/g) ?? [];
  for (const w of enWords) {
    if (!EN_STOP_WORDS.has(w)) keywords.push(w);
  }

  // 中文片段 — 连续汉字按 2/3-gram 切分
  const cnSegments = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const seg of cnSegments) {
    if (seg.length <= 3) {
      if (!CN_STOP_WORDS.has(seg)) keywords.push(seg);
    } else {
      for (let i = 0; i < seg.length - 1; i++) {
        const bigram = seg.slice(i, i + 2);
        if (!CN_STOP_WORDS.has(bigram)) keywords.push(bigram);
      }
      for (let i = 0; i < seg.length - 2; i++) {
        const trigram = seg.slice(i, i + 3);
        if (!CN_STOP_WORDS.has(trigram)) keywords.push(trigram);
      }
    }
  }

  return [...new Set(keywords)];
}

/**
 * 检查动作是否满足约束
 */
export function isConstraintSatisfied(action: string, constraint: string): boolean {
  const actionLower = action.toLowerCase();
  const constraintLower = constraint.toLowerCase();

  const constraintKeywords = extractKeywords(
    constraintLower.replace(/^(?:必须|一定要|务必|需要|must|have to|need to|should)\s*/i, ""),
  );

  if (constraintKeywords.length === 0) return true;

  let matched = 0;
  for (const kw of constraintKeywords) {
    if (actionLower.includes(kw)) matched++;
  }

  return matched >= Math.ceil(constraintKeywords.length * 0.5);
}

/**
 * 检测动作是否与指令冲突（简化版）
 */
export function isConflictingAction(action: string, instruction: string): boolean {
  const dontPatterns = [/不要(.+)/, /禁止(.+)/, /避免(.+)/, /don't\s+(.+)/i, /avoid\s+(.+)/i];
  for (const pattern of dontPatterns) {
    const match = instruction.match(pattern);
    if (match && action.includes(match[1])) {
      return true;
    }
  }
  return false;
}

/**
 * 获取违例类型的中文标签
 */
export function getViolationTypeLabel(type: ViolationType): string {
  const labels: Record<ViolationType, string> = {
    intent_override: "意图覆盖",
    constraint_breach: "约束违背",
    prohibition_violation: "禁令违例",
  };
  return labels[type];
}
