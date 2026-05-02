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
import { StructuredLogger, resolveBoolean, resolveNumber } from "@mindpal/shared";
import type { SimilarityStrategy } from "@mindpal/shared";
import type {
  IntentAnchor,
  BoundaryViolation as BoundaryViolationType,
  ViolationType,
  ViolationSeverity,
  CumulativeDriftResult,
} from "./intentAnchoringService";
import { getOrCreateDriftTracker, recordDrift } from "./intentAnchoringService";
import { listActiveIntentAnchors, recordBoundaryViolation } from "./intentAnchorRepo";

const logger = new StructuredLogger({ module: "intentAnchoring.detection" });

/* ================================================================== */
/*  Result type                                                        */
/* ================================================================== */

/** 边界检测结果 */
export interface BoundaryCheckResult {
  isViolation: boolean;
  violation?: BoundaryViolationType;
  shouldPause: boolean;
  reason?: string;
  /** 累积偏离信息（仅当提供 sessionId 和 iteration 时存在） */
  cumulativeDrift?: CumulativeDriftResult;
}

/* ================================================================== */
/*  Main detection entry                                               */
/* ================================================================== */

/**
 * 检测并处理越界行为（核心熔断逻辑）
 *
 * 在 Agent Loop 每轮迭代前调用，检查当前计划动作是否违背用户意图。
 * 如果检测到越界，立即触发熔断。
 *
 * 可选参数 sessionId / iteration 启用跨轮次累积偏离检测。
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
  /** 会话 ID，启用累积偏离检测时需要 */
  sessionId?: string;
  /** 当前迭代轮次，启用累积偏离检测时需要 */
  iteration?: number;
}): Promise<BoundaryCheckResult> {
  const { pool, tenantId, spaceId, subjectId, runId, stepId, proposedAction, currentContext, app, subject, sessionId, iteration } = params;

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

  // 3. P0-7: LLM 语义冲突检测（关键词未命中时）
  let llmResult: Awaited<ReturnType<typeof _llmBasedDetection>> = null;
  if (!keywordResult) {
    const useLlmCheck = resolveBoolean("INTENT_ANCHOR_LLM_CHECK").value && app && subject;
    if (useLlmCheck) {
      llmResult = await _llmBasedDetection({
        pool, tenantId, spaceId, runId, stepId, proposedAction, currentContext,
        app: app!, subject: subject!, anchors,
      });
    }
  }

  // 4. 累积偏离检测（可选增强，不改变已有单轮违例逻辑）
  if (sessionId != null && iteration != null) {
    const tracker = getOrCreateDriftTracker(runId, sessionId);

    // 计算本轮偏离量
    let driftAmount = 0;
    let driftSource: 'keyword' | 'llm' | 'cumulative' = 'cumulative';
    if (keywordResult?.isViolation) {
      driftAmount += 0.5;
      driftSource = 'keyword';
    }
    if (llmResult?.isViolation) {
      driftAmount += 0.8;
      driftSource = 'llm';
    }
    // 部分匹配：关键词检测未触发违例但存在部分关键词重叠
    if (!keywordResult && !llmResult) {
      const partialScore = _computePartialMatchScore(proposedAction, anchors);
      if (partialScore > 0) {
        driftAmount += partialScore;
        driftSource = 'cumulative';
      }
    }

    if (driftAmount > 0) {
      const driftResult = recordDrift(tracker, iteration, driftAmount, driftSource);

      if (driftResult.exceeded) {
        // 累积偏离超过阈值 → 触发 pause_for_review
        // 如果已有单轮违例结果，附加累积偏离信息返回
        const base = keywordResult ?? llmResult;
        return {
          isViolation: true,
          violation: base?.violation,
          shouldPause: true,
          reason: `cumulative_drift_exceeded: score=${driftResult.currentScore.toFixed(2)}, threshold=${driftResult.threshold}`,
          cumulativeDrift: driftResult,
        };
      }

      // 未超阈值，将偏离信息附加到现有结果
      if (keywordResult) {
        return { ...keywordResult, cumulativeDrift: { currentScore: tracker.driftScore, threshold: tracker.threshold, exceeded: false } };
      }
      if (llmResult) {
        return { ...llmResult, cumulativeDrift: { currentScore: tracker.driftScore, threshold: tracker.threshold, exceeded: false } };
      }

      return {
        isViolation: false,
        shouldPause: false,
        cumulativeDrift: { currentScore: tracker.driftScore, threshold: tracker.threshold, exceeded: false },
      };
    }

    // 无偏离，也附加当前累积信息
    if (keywordResult) return { ...keywordResult, cumulativeDrift: { currentScore: tracker.driftScore, threshold: tracker.threshold, exceeded: false } };
    if (llmResult) return { ...llmResult, cumulativeDrift: { currentScore: tracker.driftScore, threshold: tracker.threshold, exceeded: false } };
    return {
      isViolation: false,
      shouldPause: false,
      cumulativeDrift: { currentScore: tracker.driftScore, threshold: tracker.threshold, exceeded: false },
    };
  }

  // 未启用累积偏离检测时，保持原有行为
  if (keywordResult) return keywordResult;
  if (llmResult) return llmResult;
  return { isViolation: false, shouldPause: false };
}

/* ================================================================== */
/*  Partial match scoring (cumulative drift)                            */
/* ================================================================== */

/**
 * 计算提议动作与意图锚点的部分匹配分数
 *
 * 用于累积偏离检测：当关键词/LLM检测未触发违例但存在部分关键词重叠时，
 * 返回一个微小的偏离分数 (0-0.2)。
 */
function _computePartialMatchScore(
  proposedAction: string,
  anchors: IntentAnchor[],
): number {
  const actionLower = proposedAction.toLowerCase();
  const actionKeywords = new Set(extractKeywords(actionLower));
  if (actionKeywords.size === 0) return 0;

  let maxPartial = 0;
  for (const anchor of anchors) {
    if (anchor.instructionType !== "prohibition" && anchor.instructionType !== "constraint") continue;
    const instrKeywords = extractKeywords(anchor.originalInstruction.toLowerCase());
    if (instrKeywords.length === 0) continue;

    let matchCount = 0;
    for (const kw of instrKeywords) {
      if (actionKeywords.has(kw)) matchCount++;
    }
    const ratio = matchCount / instrKeywords.length;
    // 部分匹配：重叠占比在 20%-50% 之间才计入偏离（低于20%算无关，高于50%业已由单轮检测处理）
    if (ratio >= 0.2 && ratio < 0.5) {
      const score = ratio * 0.4; // 最高贡献 0.2
      if (score > maxPartial) maxPartial = score;
    }
  }
  return maxPartial;
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

/** 内置高频复合词词典（意图检测域），运行时可通过 INTENT_CN_COMPOUND_WORDS 扩展 */
const BUILTIN_CN_COMPOUNDS = new Set([
  "执行查询", "创建文件", "删除文件", "修改文件", "读取文件", "发送消息", "接收消息",
  "数据库", "数据表", "数据源", "数据集", "文件系统", "文件夹", "文件名",
  "用户名", "密码", "权限", "角色", "身份验证", "访问控制", "安全策略",
  "工作流", "任务队列", "执行计划", "调度策略", "优先级", "并发控制",
  "知识库", "向量存储", "语义搜索", "文档摘要", "内容检索",
  "模型调用", "模型选择", "提示词", "上下文窗口", "生成回复",
  "网络请求", "接口调用", "返回结果", "错误处理", "异常捕获",
  "系统配置", "环境变量", "运行环境", "部署方案", "监控告警",
  "智能体", "技能执行", "工具调用", "意图识别", "目标分解",
  "协作编排", "交叉验证", "共识决策", "辩论仲裁", "权限委派",
  "检查点", "心跳检测", "状态恢复", "并行执行", "串行执行",
  "审批流程", "治理策略", "合规检查", "审计日志", "变更集",
]);

function getCompoundWordDict(): Set<string> {
  const extra = (process.env.INTENT_CN_COMPOUND_WORDS ?? "").split(",").filter(Boolean);
  if (extra.length === 0) return BUILTIN_CN_COMPOUNDS;
  return new Set([...BUILTIN_CN_COMPOUNDS, ...extra]);
}

/** 正向最大匹配分词（轻量，无外部依赖） */
function forwardMaxMatch(text: string, dict: Set<string>): string[] {
  const tokens: string[] = [];
  let i = 0;
  const maxLen = 5; // 词典最大词长
  while (i < text.length) {
    let matched = false;
    for (let len = Math.min(maxLen, text.length - i); len >= 2; len--) {
      const candidate = text.slice(i, i + len);
      if (dict.has(candidate)) {
        tokens.push(candidate);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // 未匹配词典：取2字作为token（兜底bigram）
      if (i + 1 < text.length) {
        tokens.push(text.slice(i, i + 2));
      }
      i++;
    }
  }
  return tokens;
}

/**
 * 提取指令中的关键词（中英文混合分词）
 *
 * 英文：按空白拆词 + 停用词过滤
 * 中文：正向最大匹配词典词 + 未命中兜底bigram
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
    "然后", "如果", "因为", "所以", "但是", "虽然", "或者", "应该", "可以", "已经",
    "而且", "不过", "只是", "还是", "以及", "对于", "关于", "通过", "进行", "之后",
  ]);

  const lower = instruction.toLowerCase();
  const keywords: string[] = [];

  // 英文词
  const enWords = lower.match(/[a-z]{2,}/g) ?? [];
  for (const w of enWords) {
    if (!EN_STOP_WORDS.has(w)) keywords.push(w);
  }

  // 中文片段 — 正向最大匹配词典词 + 未命中兜底bigram
  const cnSegments = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  const compoundDict = getCompoundWordDict();
  for (const seg of cnSegments) {
    if (seg.length <= 1) continue;
    const tokens = forwardMaxMatch(seg, compoundDict);
    for (const token of tokens) {
      if (!CN_STOP_WORDS.has(token) && token.length >= 2) keywords.push(token);
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

/* ================================================================== */
/*  相似度策略                                                        */
/* ================================================================== */

const jaccardStrategy: SimilarityStrategy = {
  name: "jaccard",
  compute(a, b) {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const x of a) if (b.has(x)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 1 : intersection / union;
  },
};

const diceStrategy: SimilarityStrategy = {
  name: "dice",
  compute(a, b) {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const x of a) if (b.has(x)) intersection++;
    const total = a.size + b.size;
    return total === 0 ? 1 : (2 * intersection) / total;
  },
};

const SIMILARITY_STRATEGIES: Record<string, SimilarityStrategy> = {
  jaccard: jaccardStrategy,
  dice: diceStrategy,
};

function getSimilarityStrategy(): SimilarityStrategy {
  const name = process.env.INTENT_SIMILARITY_STRATEGY || "jaccard";
  return SIMILARITY_STRATEGIES[name] ?? jaccardStrategy;
}

/* ================================================================== */
/*  detectIntentBoundary — Think 阶段意图漂移检测                          */
/* ================================================================== */

/** 意图检测结果 */
export interface IntentDriftResult {
  /** 是否检测到意图漂移 */
  drifted: boolean;
  /** 漂移分数 (0-1，越高越偏离) */
  driftScore: number;
  /** 漂移描述 */
  reason?: string;
  /** 是否需要重置锚定 */
  shouldResetAnchor: boolean;
}

/**
 * 在 Think 阶段检测用户意图偏移
 *
 * 对比当前用户消息与已锚定意图的语义相似度（关键词重叠 + 结构匹配）：
 * - 当偏移超过阈值时，标记为意图漂移，触发锚定重置信号
 * - 该函数不执行熔断（熔断由 checkAndEnforceIntentBoundary 处理），
 *   仅提供漂移检测结果供主循环决策
 */
export async function detectIntentBoundary(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  runId: string;
  /** 当前用户消息 / 当前迭代的 LLM 输出摘要 */
  currentMessage: string;
  /** 原始用户目标 */
  originalGoal: string;
  /** 漂移阈值 (0-1，默认 0.6，越低越严格) */
  driftThreshold?: number;
}): Promise<IntentDriftResult> {
  const { pool, tenantId, spaceId, subjectId, runId, currentMessage, originalGoal } = params;
  const threshold = params.driftThreshold ?? resolveNumber("INTENT_DRIFT_THRESHOLD", undefined, undefined, 0.6).value;

  // 1. 获取活跃意图锚点
  const anchors = await listActiveIntentAnchors({ pool, tenantId, spaceId, subjectId, runId });

  // 无锚点时仅与原始目标对比
  const referenceTexts = anchors.length > 0
    ? anchors.map(a => a.originalInstruction)
    : [originalGoal];

  // 2. 关键词重叠度计算
  const currentKeywords = new Set(extractKeywords(currentMessage));
  if (currentKeywords.size === 0) {
    return { drifted: false, driftScore: 0, shouldResetAnchor: false };
  }

  let maxOverlap = 0;
  let bestMatchRef = "";
  for (const ref of referenceTexts) {
    const refKeywords = new Set(extractKeywords(ref));
    if (refKeywords.size === 0) continue;
    const strategy = getSimilarityStrategy();
    const jaccardSimilarity = strategy.compute(currentKeywords, refKeywords);
    if (jaccardSimilarity > maxOverlap) {
      maxOverlap = jaccardSimilarity;
      bestMatchRef = ref;
    }
  }

  // 3. 结构匹配：检查原始目标与当前消息的动词/意图结构是否一致
  const goalKeywords = new Set(extractKeywords(originalGoal));
  const goalOverlap = goalKeywords.size > 0
    ? [...currentKeywords].filter(kw => goalKeywords.has(kw)).length / Math.max(goalKeywords.size, 1)
    : 1;

  // 综合得分：Jaccard 权重 0.6 + 目标重叠权重 0.4
  const combinedScore = maxOverlap * 0.6 + goalOverlap * 0.4;
  const driftScore = 1 - combinedScore; // 偏移分数：越高越偏离

  const drifted = driftScore > threshold;

  if (drifted) {
    logger.warn(
      `Intent drift detected: score=${driftScore.toFixed(3)} > threshold=${threshold}, ` +
      `bestMatch="${bestMatchRef.slice(0, 80)}", currentMsg="${currentMessage.slice(0, 80)}"`,
    );
  }

  return {
    drifted,
    driftScore,
    reason: drifted
      ? `意图偏移得分 ${driftScore.toFixed(2)} 超过阈值 ${threshold}，当前消息与原始目标偏离过大`
      : undefined,
    shouldResetAnchor: drifted && driftScore > 0.8,
  };
}
