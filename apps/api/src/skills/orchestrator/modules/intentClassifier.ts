import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:intentClassifier" });

/**
 * Intent Classifier Module
 * 
 * 意图分类器：将用户消息分类为不同的执行模式
 * - answer: 即时问答（纯对话，不需要工具调用）
 * - execute: 单智能体执行（需要工具调用/多步骤执行）
 * - collab: 多智能体协作（复杂任务需要多角色协同）
 * - intervene: 干预当前任务（用户想修改/停止/调整正在执行的任务）
 * 
 * P1-1/P1-2 架构升级：
 * 1. Level-1 极快规则/状态感知分类器 (<1ms)
 * 2. Level-2 灰区轻量复判（仅在灰区区间调用 LLM）
 * 3. P1-3 索引化 pattern 表，预编译正则降低扫描成本
 */

import type { Pool } from "pg";
import { invokeModelChat, type LlmSubject } from "../../../lib/llm";
import type { FastifyInstance } from "fastify";
import {
  GREETING_WORDS, COLLAB_KEYWORDS,
  GREETING_REGEX, COLLAB_REGEX,
  INTERVENTION_PATTERNS,
  HIGH_RISK_KEYWORDS, hasHighRiskKeyword,
  EXECUTE_REQUEST_RE, EXECUTE_ACTION_RE,
  QUESTION_INDICATOR_RE, OPINION_PREFIX_RE, FOLLOW_UP_RE,
  getActiveVocab,
} from "./intentVocabulary";

// P0-6→P3: 统一规则库替代跨 skill 契约调用，消除 analyzer ↔ classifier 规则重叠
import { buildStandardRules, matchStandardRules } from "../../../kernel/intentRuleStandard";

/* ================================================================== */
/*  P4-6: 配置中心灰度开关 — 允许逐项控制新功能上线                         */
/* ================================================================== */

export const FEATURE_FLAGS: Record<string, boolean> = {
  /** 新快速分类器（P1-3 索引化） */
  NEW_FAST_CLASSIFIER: (process.env.FF_NEW_FAST_CLASSIFIER ?? "1") === "1",
  /** 二阶段复判（P1-1/P1-2 两级路由） */
  TWO_LEVEL_ROUTING: (process.env.INTENT_TWO_LEVEL_ROUTING ?? "1") === "1",
  /** 新分解器（P1-4 三级策略） */
  NEW_DECOMPOSER: (process.env.FF_NEW_DECOMPOSER ?? "1") === "1",
  /** 计划 critic（P2-13） */
  PLAN_CRITIC: (process.env.FF_PLAN_CRITIC ?? "1") === "1",
  /** 并行双路 think（P1-6） */
  PARALLEL_CLASSIFY: (process.env.PARALLEL_CLASSIFY_ENABLED ?? "0") === "1",
  /** 意图复核器（P2-7） */
  INTENT_REVIEWER: (process.env.INTENT_REVIEWER_ENABLED ?? "1") === "1",
  /** 语义修复器（P2-10） */
  SEMANTIC_REPAIR: (process.env.FF_SEMANTIC_REPAIR ?? "1") === "1",
};

/**
 * 运行时热更新功能开关（配置中心/灰度发布时调用）
 *
 * @param overrides 要覆盖的开关，只传入需要变更的 key
 */
export function reloadFeatureFlags(overrides: Partial<Record<string, boolean>>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (key in FEATURE_FLAGS && typeof value === "boolean") {
      FEATURE_FLAGS[key] = value;
    }
  }
}

export type IntentMode = "answer" | "execute" | "collab" | "intervene";

/**
 * intent-analyzer Skill 使用的细粒度意图类型。
 * 两套系统共存：intentClassifier（编排层路由，输出 mode）与
 * intent-analyzer Skill（语义分析，输出 intent）。
 * 以下映射函数用于在两者之间转换，确保语义一致。
 */
export type IntentType = "chat" | "ui" | "query" | "task" | "collab";

/* ================================================================== */
/*  P2-1/P2-2: 统一意图体系与标准协议                                      */
/* ================================================================== */

/**
 * 一级意图（粗路由） — 决定 dispatch 走哪条执行管道
 *
 * conversation    → 纯对话，无副作用
 * immediate_action → 单步即时动作（查询/简单写入）
 * workflow        → 需要 GoalGraph 分解的多步工作流
 * collab          → 多智能体协作
 * intervene       → 干预当前活跃任务
 */
export type PrimaryIntent =
  | "conversation"
  | "immediate_action"
  | "workflow"
  | "collab"
  | "intervene";

/**
 * 二级意图（细分类） — 决定具体技能/处理策略
 */
export type SecondaryIntent =
  | "chat"           // 闲聊/问候
  | "query"          // 知识问答/数据查询
  | "ui"             // UI 生成/变更
  | "write_task"     // 写操作（创建/更新/删除）
  | "approval_task"  // 审批流
  | "multi_agent"    // 多角色协作
  | "task_control";  // 任务干预（暂停/继续/取消/修改）

/**
 * P2-1/P4-1: 统一意图决策模型
 *
 * 承载分类的完整上下文：一级/二级意图、置信度、可解释特征摘要、
 * 分类器来源、风险等级、以及派发层所需的 mode 和 intentType 映射。
 */
export interface IntentDecision {
  /** 一级意图 */
  primary: PrimaryIntent;
  /** 二级意图 */
  secondary: SecondaryIntent;
  /** 总体置信度 0~1 */
  confidence: number;
  /** 是否需要进入任务流 */
  needsTask: boolean;
  /** P2-6: 可解释特征摘要 — 每条命中的规则/模式/特征 */
  featureSummary: string[];
  /** 分类器来源 */
  classifierUsed: "fast" | "llm" | "two_level" | "reviewer";
  /** 风险等级 */
  riskLevel: "none" | "low" | "medium" | "high";
  /** 是否需要二次确认（高风险写操作） */
  needsConfirmation: boolean;
  /** 派发层 IntentMode */
  mode: IntentMode;
  /** 分析层 IntentType */
  intentType: IntentType;
}

/* ── 映射表 ───────────────────────────────────────────── */

const _intentTypeToMode: Record<IntentType, IntentMode> = {
  chat: "answer",
  ui: "execute",
  query: "answer",
  task: "execute",
  collab: "collab",
};

const _modeToIntentType: Record<IntentMode, IntentType> = {
  answer: "chat",
  execute: "task",
  collab: "collab",
  intervene: "task",
};

const _primaryToMode: Record<PrimaryIntent, IntentMode> = {
  conversation: "answer",
  immediate_action: "execute",
  workflow: "execute",
  collab: "collab",
  intervene: "intervene",
};

const _secondaryToType: Record<SecondaryIntent, IntentType> = {
  chat: "chat",
  query: "query",
  ui: "ui",
  write_task: "task",
  approval_task: "task",
  multi_agent: "collab",
  task_control: "task",
};

const _modeToPrimary: Record<IntentMode, PrimaryIntent> = {
  answer: "conversation",
  execute: "immediate_action",
  collab: "collab",
  intervene: "intervene",
};

const _typeToSecondary: Record<IntentType, SecondaryIntent> = {
  chat: "chat",
  query: "query",
  ui: "ui",
  task: "write_task",
  collab: "multi_agent",
};

/** 将 intent-analyzer 的 IntentType 转换为编排层 IntentMode */
export function intentTypeToMode(intentType: IntentType): IntentMode {
  return _intentTypeToMode[intentType] ?? "answer";
}

/** 将编排层 IntentMode 转换为 intent-analyzer 的 IntentType */
export function modeToIntentType(mode: IntentMode): IntentType {
  return _modeToIntentType[mode] ?? "chat";
}

/** P2-1: 从 IntentClassification 构建统一 IntentDecision */
export function buildIntentDecision(
  classification: IntentClassification,
  opts?: { classifierUsed?: IntentDecision["classifierUsed"]; featureSummary?: string[] },
): IntentDecision {
  const primary = _modeToPrimary[classification.mode] ?? "conversation";
  const mappedType = _modeToIntentType[classification.mode] ?? "chat";
  const secondary = _typeToSecondary[mappedType] ?? "chat";

  // 推断风险等级
  let riskLevel: IntentDecision["riskLevel"] = "none";
  if (classification.needsApproval) riskLevel = "high";
  else if (classification.mode === "execute" && classification.complexity !== "simple") riskLevel = "medium";
  else if (classification.mode === "execute") riskLevel = "low";

  return {
    primary,
    secondary,
    confidence: classification.confidence,
    needsTask: classification.needsTask,
    featureSummary: opts?.featureSummary ?? [classification.reason],
    classifierUsed: opts?.classifierUsed ?? "fast",
    riskLevel,
    needsConfirmation: riskLevel === "high" || (riskLevel === "medium" && classification.confidence < 0.7),
    mode: classification.mode,
    intentType: mappedType,
  };
}

/** P2-1: 从统一 IntentDecision 获取 IntentClassification */
export function intentDecisionToClassification(decision: IntentDecision): IntentClassification {
  return {
    mode: decision.mode,
    confidence: decision.confidence,
    reason: decision.featureSummary.join("; "),
    needsTask: decision.needsTask,
    needsApproval: decision.needsConfirmation,
    complexity: decision.confidence >= 0.8 ? "simple" : decision.confidence >= 0.5 ? "moderate" : "complex",
    hasToolIntent: decision.primary === "immediate_action" ||
                   decision.needsTask ||
                   decision.secondary === "write_task",
  };
}

export interface IntentClassification {
  /** 分类结果 */
  mode: IntentMode;
  /** 置信度 0-1 */
  confidence: number;
  /** 分类原因 */
  reason: string;
  /** 是否需要创建任务 */
  needsTask: boolean;
  /** 是否需要审批 */
  needsApproval: boolean;
  /** 检测到的工具意图 */
  detectedTools?: string[];
  /** 复杂度评估 */
  complexity: "simple" | "moderate" | "complex";
  /** 干预类型（仅当 mode=intervene 时） */
  interventionType?: "pause" | "resume" | "cancel" | "modify_step" | "add_step" | "remove_step" | "change_goal";
  /** 多任务干预：目标任务 ID（当 mode=intervene 且有多个活跃任务时，指明干预哪个任务） */
  targetTaskId?: string;
  /** 多任务干预：目标 entryId */
  targetEntryId?: string;
  /** answer 模式下是否需要工具上下文（用于 prompt 轻重选择） */
  hasToolIntent?: boolean;
}

/** P1-2: 灰区置信度阈值配置 */
export const GRAY_ZONE = {
  /** 低于此值：必须进入 Level-2 复判 */
  LOW: parseFloat(process.env.INTENT_GRAY_ZONE_LOW ?? "0.65"),
  /** 高于此值：直接信任 Level-1 结果 */
  HIGH: parseFloat(process.env.INTENT_GRAY_ZONE_HIGH ?? "0.85"),
  /** 是否启用两级路由 */
  ENABLED: (process.env.INTENT_TWO_LEVEL_ROUTING ?? "1") === "1",
};

export interface ClassifyIntentParams {
  pool: Pool;
  app?: FastifyInstance;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  message: string;
  /** 用户显式指定的模式 */
  explicitMode?: IntentMode;
  /** 上下文：当前活动的任务信息（单任务兼容） */
  activeRunContext?: {
    runId: string;
    taskId: string;
    taskTitle: string;
    phase: string;
  };
  /** 多任务上下文：当前会话中所有活跃任务（P1多任务并发支持） */
  activeTaskIds?: Array<{
    taskId: string;
    runId: string;
    entryId?: string;
    goal?: string;
    phase?: string;
  }>;
  /** 会话历史：最近 N 条消息，用于理解澄清/纠正等上下文依赖意图 */
  sessionHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 可用工具列表（用于匹配） */
  availableTools?: string[];
  locale?: string;
  authorization?: string | null;
  traceId?: string | null;
  /** 多模态附件元数据（可选，用于多模态意图感知） */
  attachments?: AttachmentMeta[];
}

/**
 * 使用 LLM 进行意图分类（核心分类逻辑，禁止硬编码）
 */
async function classifyByLlm(params: ClassifyIntentParams): Promise<IntentClassification> {
  if (!params.app) {
    // 没有 app 实例，安全降级为问答模式（避免误触发工具执行）
    return {
      mode: "answer",
      confidence: 0.5,
      reason: "default_fallback_no_app",
      needsTask: false,
      needsApproval: false,
      complexity: "simple",
      hasToolIntent: false,
    };
  }

  // 构建上下文感知的分类 prompt
  let activeTaskContext = "";
  // 多任务上下文（优先级高于单任务）
  if (params.activeTaskIds && params.activeTaskIds.length > 0) {
    const taskLines = params.activeTaskIds.map((t, i) =>
      `  ${i + 1}. taskId=${t.taskId} goal="${(t.goal ?? "").slice(0, 80)}" phase=${t.phase ?? "unknown"}`
    ).join("\n");
    activeTaskContext = `

## Active Tasks Context (Multi-Task Queue)
The user currently has ${params.activeTaskIds.length} active task(s):
${taskLines}

If the user wants to modify, stop, pause, resume, or comment on one of these tasks, classify as "intervene".
You MUST also identify which task the user is referring to by setting "targetTaskId" in the response.
If the user says "resume"/"continue"/"go on"/"\u7ee7\u7eed" without specifying which task, target the most recently paused task.
If the user says "stop all"/"cancel everything"/"\u505c\u6b62\u6240\u6709", classify as "intervene" with interventionType="cancel" and targetTaskId="*" (all tasks).`;
  } else if (params.activeRunContext) {
    const ctx = params.activeRunContext;
    activeTaskContext = `

## Active Task Context
The user currently has an active task:
- Task: "${ctx.taskTitle}"
- Phase: ${ctx.phase}
- RunId: ${ctx.runId}

If the user's message is about modifying, stopping, adjusting, resuming, or commenting on this active task, classify as "intervene".
If the task is paused (e.g. waiting for user answer) and the user provides a follow-up answer or says "continue"/"go on"/"resume"/"\u7ee7\u7eed", classify as "intervene" with interventionType="resume".`;
  }

  // 会话历史上下文（用于理解澄清/纠正等多轮依赖）
  let conversationHistoryContext = "";
  if (params.sessionHistory && params.sessionHistory.length > 0) {
    const recentTurns = params.sessionHistory.slice(-6); // 最近 3 轮对话（6 条消息）
    const turnLines = recentTurns.map((m) => {
      const prefix = m.role === "user" ? "User" : "Assistant";
      const shortContent = m.content.slice(0, 200);
      return `${prefix}: ${shortContent}`;
    }).join("\n");
    conversationHistoryContext = `

## Recent Conversation History
The user is continuing a conversation. Here are the most recent exchanges:
${turnLines}

Use this context to understand references like "this isn't a request", "I didn't mean that", "no, what I want is...", or follow-up answers to previous questions.`;
  }

  const systemPrompt = `You are an intent classifier for an intelligent Agent OS. Classify the user message into ONE of these modes:

- "answer": Pure Q&A, information request, explanation, general conversation. No tool execution needed.
- "execute": The user wants something DONE — an action, creation, search, navigation, file operation, etc. Requires tool calls.
- "collab": Complex task requiring multiple roles/agents working together (analysis + execution, review + action, etc.)
- "intervene": The user wants to MODIFY, STOP, PAUSE, ADJUST, or CHANGE a currently running task. (Only valid if there is an active task.)${activeTaskContext}${conversationHistoryContext}

For "intervene" mode, also classify the intervention type:
- "pause": stop/pause/wait
- "resume": resume/continue/go on/proceed — the user wants to continue a paused task or provide the answer to a previous question
- "cancel": cancel/abort/forget it/don't do this
- "modify_step": change how a specific step should work
- "add_step": add additional steps/actions
- "remove_step": skip/remove certain steps
- "change_goal": change the overall objective

Respond ONLY with a JSON object:
{"mode":"answer|execute|collab|intervene","confidence":0.0-1.0,"reason":"brief_reason","needsTask":true|false,"needsApproval":true|false,"complexity":"simple|moderate|complex","interventionType":"pause|resume|cancel|modify_step|add_step|remove_step|change_goal","targetTaskId":"the_task_id_being_targeted_or_*_for_all"}

IMPORTANT:
- "interventionType" is ONLY needed when mode is "intervene"
- "targetTaskId" is ONLY needed when mode is "intervene" AND there are multiple active tasks; set to the taskId the user is referring to, or "*" for all tasks
- If no active task exists, NEVER classify as "intervene"
- High-risk actions (delete, destroy, batch operations) should set needsApproval=true
- The KEY distinction: "answer" is for PURE INFORMATION — the user only wants to KNOW something. "execute" is for ANY action the user wants PERFORMED, regardless of how many steps or how simple it seems. If the user's intent implies doing, creating, opening, searching, modifying, navigating, or any other verb that changes state or produces a result beyond text — it is "execute"
- When ambiguous between "answer" and "execute", consider the FULL CONTEXT. If the user is expressing an OPINION, making a COMMENT, providing FEEDBACK, having a DISCUSSION, CORRECTING a misunderstanding, or engaging in CASUAL CONVERSATION, classify as "answer" even if action verbs appear. Only classify as "execute" when the user clearly wants the system to DO something.
- Examples of "answer" despite containing action verbs: "浏览器自动化不是重要功能" (opinion), "我觉得操作控制更重要" (feedback), "这不是请求，是对话" (clarification), "真正的是操作控制任何设备" (discussion)
- Examples of "execute": "帮我创建一个页面" (explicit request), "搜索最近的日志" (command), "把文件删除" (action order)`;

  try {
    const subject: LlmSubject = {
      tenantId: params.tenantId,
      subjectId: params.subjectId,
      spaceId: params.spaceId,
    };

    const result = await invokeModelChat({
      app: params.app,
      subject,
      locale: params.locale ?? "zh-CN",
      authorization: params.authorization ?? null,
      traceId: params.traceId ?? null,
      purpose: "intent.classify",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: params.message.slice(0, 500) },
      ],
    });

    const outputText = result?.outputText ?? "";
    const jsonMatch = outputText.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const validModes: IntentMode[] = ["answer", "execute", "collab", "intervene"];
      const mode: IntentMode = validModes.includes(parsed.mode) ? parsed.mode : "answer";
      
      // 安全校验：没有活动任务时不允许 intervene
      const hasActiveTask = !!params.activeRunContext || (params.activeTaskIds && params.activeTaskIds.length > 0);
      const safeMode = (mode === "intervene" && !hasActiveTask) ? "execute" : mode;

      const validInterventionTypes = ["pause", "resume", "cancel", "modify_step", "add_step", "remove_step", "change_goal"] as const;
      const interventionType = safeMode === "intervene" && validInterventionTypes.includes(parsed.interventionType)
        ? parsed.interventionType
        : undefined;

      // 多任务干预：解析目标任务 ID
      const targetTaskId = safeMode === "intervene" && typeof parsed.targetTaskId === "string" ? parsed.targetTaskId : undefined;
      // 尝试通过 targetTaskId 查找对应的 entryId
      let targetEntryId: string | undefined;
      if (targetTaskId && targetTaskId !== "*" && params.activeTaskIds) {
        const matched = params.activeTaskIds.find(t => t.taskId === targetTaskId);
        targetEntryId = matched?.entryId;
      }

      const llmNeedsTask = safeMode !== "answer" && safeMode !== "intervene";
      // hasToolIntent 独立于路由模式，基于 LLM 原始分类（parsed.mode）判定
      // 即使 auto 模式将 execute 降级为 answer，仍保留原始工具意图信号
      const llmHasToolIntent =
        parsed.mode === "execute" || parsed.mode === "collab";
      return {
        mode: safeMode,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
        reason: parsed.reason ?? "llm_classified",
        needsTask: llmNeedsTask,
        needsApproval: Boolean(parsed.needsApproval),
        complexity: ["simple", "moderate", "complex"].includes(parsed.complexity) ? parsed.complexity : "moderate",
        interventionType,
        targetTaskId,
        targetEntryId,
        hasToolIntent: llmHasToolIntent,
      };
    }
  } catch {
    // LLM 调用失败，使用默认值
  }

  // LLM 失败时安全降级为 answer（避免误触发工具执行）
  return {
    mode: "answer",
    confidence: 0.5,
    reason: "llm_fallback",
    needsTask: false,
    needsApproval: false,
    complexity: "simple",
    hasToolIntent: false,
  };
}

/**
 * 主入口：分类用户意图（全由 LLM 完成，禁止硬编码）
 */
export async function classifyIntent(params: ClassifyIntentParams): Promise<IntentClassification> {
  const message = params.message.trim();
  
  // 空消息返回问答模式
  if (!message) {
    return {
      mode: "answer",
      confidence: 1.0,
      reason: "empty_message",
      needsTask: false,
      needsApproval: false,
      complexity: "simple",
      hasToolIntent: false,
    };
  }

  // 用户显式指定模式时直接尊重
  if (params.explicitMode) {
    return {
      mode: params.explicitMode,
      confidence: 1.0,
      reason: "user_explicit",
      needsTask: params.explicitMode !== "answer" && params.explicitMode !== "intervene",
      needsApproval: false,
      complexity: params.explicitMode === "collab" ? "complex" : "moderate",
      hasToolIntent: params.explicitMode === "execute" || params.explicitMode === "collab",
    };
  }

  // 所有意图分类全部由 LLM 完成，禁止硬编码关键词
  return classifyByLlm(params);
}

/**
 * 快速分类器的可选上下文（跨轮状态感知）
 */
/** 多模态附件摘要（仅传递分类器所需的轻量元数据） */
export interface AttachmentMeta {
  type: string;
  mimeType?: string;
  name?: string;
}

export interface FastClassifyContext {
  /** 是否有活跃任务 */
  hasActiveTask?: boolean;
  /** 活跃任务数量 */
  activeTaskCount?: number;
}

/**
 * 极薄快速分类器 — 确定性硬短路规则
 *
 * 架构重构：在原有 5 条规则基础上扩展到 10+ 条，覆盖五大一级意图：
 * 1. 空消息 → answer
 * 2. 极短消息（≤5字）→ answer（先检查干预/跟进）
 * 3. 问候/寒暄 → answer
 * 4. 协作关键词 → collab
 * 5. 干预意图（停止/暂停/继续）→ intervene
 * 6. 观点/意见表达 → answer（防止包含动作词的观点被误分为 execute）
 * 7. 跟进确认词 + 有活跃任务 → intervene/resume
 * 8. 请求前缀（帮我/please）→ execute
 * 9. 动作词开头 → execute
 * 10. 纯问句模式 → answer
 *
 * 其余所有场景交给 LLM 。
 *
 * @param context 可选跨轮上下文（活跃任务状态）
 * @returns null 表示无法快速短路，应走 LLM 分类
 */
export function classifyIntentFast(
  message: string,
  explicitMode?: IntentMode,
  context?: FastClassifyContext,
  attachments?: AttachmentMeta[],
): IntentClassification | null {
  // 用户显式指定模式时直接尊重
  if (explicitMode) {
    const result: IntentClassification = {
      mode: explicitMode,
      confidence: 1.0,
      reason: "user_explicit",
      needsTask: explicitMode !== "answer" && explicitMode !== "intervene",
      needsApproval: false,
      complexity: explicitMode === "collab" ? "complex" : "moderate",
      hasToolIntent: explicitMode === "execute" || explicitMode === "collab",
    };
    _logClassification(message, result);
    return result;
  }

  const msg = message.trim();
  const msgLower = msg.toLowerCase();

  // ────── 规则 1: 空消息 → answer ──────
  if (!msg) {
    return { mode: "answer", confidence: 1.0, reason: "empty_message", needsTask: false, needsApproval: false, complexity: "simple", hasToolIntent: false };
  }

  // ────── 规则 2: 极短消息（≤5字）→ answer ──────
  if (msg.length <= 5) {
    // 先检查是否是干预关键词（如 "停止"、"取消"、"继续"）
    for (const pat of INTERVENTION_PATTERNS) {
      if (pat.re.test(msg)) {
        const r: IntentClassification = {
          mode: "intervene", confidence: 0.92, reason: `intervention_${pat.type}`,
          needsTask: false, needsApproval: false, complexity: "simple",
          interventionType: pat.type,
        };
        _logClassification(message, r);
        return r;
      }
    }
    // 再检查跟进确认词（如 "好的"、"行"、"ok"）+ 活跃任务
    if (context?.hasActiveTask && FOLLOW_UP_RE.test(msg)) {
      const r: IntentClassification = {
        mode: "intervene", confidence: 0.86, reason: "follow_up_confirm_with_active_task",
        needsTask: false, needsApproval: false, complexity: "simple",
        interventionType: "resume",
      };
      _logClassification(message, r);
      return r;
    }
    const r: IntentClassification = { mode: "answer", confidence: 0.9, reason: "short_message_likely_greeting", needsTask: false, needsApproval: false, complexity: "simple", hasToolIntent: false };
    _logClassification(message, r);
    return r;
  }

  // ────── 规则 3: 问候/寒暄 → answer ──────
  if (GREETING_WORDS.some(g => msg === g || msgLower === g.toLowerCase())) {
    const r: IntentClassification = { mode: "answer", confidence: 0.95, reason: "greeting_pattern", needsTask: false, needsApproval: false, complexity: "simple", hasToolIntent: false };
    _logClassification(message, r);
    return r;
  }

  // ────── 规则 4: 协作关键词 → collab ──────
  if (COLLAB_KEYWORDS.some(k => msg.includes(k) || msgLower.includes(k))) {
    const r: IntentClassification = { mode: "collab", confidence: 0.75, reason: "collab_keyword_detected", needsTask: true, needsApproval: false, complexity: "complex", hasToolIntent: true };
    _logClassification(message, r);
    return r;
  }

  // ────── 规则 5: 干预意图（停止/暂停/继续/修改/回滚）→ intervene ──────
  for (const pat of INTERVENTION_PATTERNS) {
    if (pat.re.test(msg)) {
      const r: IntentClassification = {
        mode: "intervene", confidence: 0.88, reason: `intervention_${pat.type}`,
        needsTask: false, needsApproval: false, complexity: "simple",
        interventionType: pat.type,
      };
      _logClassification(message, r);
      return r;
    }
  }

  // ────── 规则 6: 观点/意见表达 → answer ──────
  // 必须在执行意图检测之前，防止"我觉得浏览器自动化不是重要功能"被误分为 execute
  // 消歧：若观点前缀后紧跟执行性词汇（"我觉得应该创建..."），不短路，留给后续规则或 LLM
  if (OPINION_PREFIX_RE.test(msg)) {
    const afterPrefix = msg.replace(OPINION_PREFIX_RE, "").trim();
    const hasExecuteAfter = EXECUTE_ACTION_RE.test(afterPrefix) || EXECUTE_REQUEST_RE.test(afterPrefix);
    if (!hasExecuteAfter) {
      const r: IntentClassification = { mode: "answer", confidence: 0.88, reason: "opinion_expression", needsTask: false, needsApproval: false, complexity: "simple", hasToolIntent: false };
      _logClassification(message, r);
      return r;
    }
  }

  // ────── 规则 7: 跟进确认词 + 有活跃任务 → intervene/resume ──────
  if (context?.hasActiveTask && FOLLOW_UP_RE.test(msg)) {
    const r: IntentClassification = {
      mode: "intervene", confidence: 0.86, reason: "follow_up_confirm_with_active_task",
      needsTask: false, needsApproval: false, complexity: "simple",
      interventionType: "resume",
    };
    _logClassification(message, r);
    return r;
  }

  // ────── 规则 8: 请求前缀（帮我/please/can you）→ execute ──────
  if (EXECUTE_REQUEST_RE.test(msg)) {
    const isHighRisk = hasHighRiskKeyword(msg);
    const r: IntentClassification = {
      mode: "execute", confidence: 0.85, reason: "execute_request_prefix",
      needsTask: true, needsApproval: isHighRisk, complexity: "moderate",
      hasToolIntent: true,
    };
    _logClassification(message, r);
    return r;
  }

  // ────── 规则 9: 动作词开头（创建/搜索/create/search）→ execute ──────
  // 置信度 0.60：低于灰区 LOW(0.65)，确保两级路由时必须经过 LLM 复判
  // 高歧义动词（修改/更新/设置/配置/添加等）已从词表移除，交由 LLM 自主判断
  if (EXECUTE_ACTION_RE.test(msg)) {
    const isHighRisk = hasHighRiskKeyword(msg);
    const r: IntentClassification = {
      mode: "execute", confidence: 0.60, reason: "execute_action_verb",
      needsTask: true, needsApproval: isHighRisk, complexity: "moderate",
      hasToolIntent: true,
    };
    _logClassification(message, r);
    return r;
  }

  // ────── 规则 10: 纯问句模式 → answer ──────
  // 问句指示词开头（什么/怎么/为什么/what/how/why）
  if (QUESTION_INDICATOR_RE.test(msg)) {
    const r: IntentClassification = { mode: "answer", confidence: 0.82, reason: "question_pattern", needsTask: false, needsApproval: false, complexity: "simple", hasToolIntent: false };
    _logClassification(message, r);
    return r;
  }
  // 问号结尾 + 无动作词
  if (/[?？]$/.test(msg) || /[吗呢么呀嘛]$/.test(msg)) {
    const r: IntentClassification = { mode: "answer", confidence: 0.78, reason: "question_suffix", needsTask: false, needsApproval: false, complexity: "simple", hasToolIntent: false };
    _logClassification(message, r);
    return r;
  }

  // ────── 无法快速短路 → 使用统一规则库作为倒数第二层 ──────
  let _analyzerResult: IntentClassification | null = null;
  try {
    const standardRules = buildStandardRules();
    const standardResult = matchStandardRules(message, standardRules);
    if (standardResult && standardResult.confidence >= 0.5 && standardResult.intent !== "chat") {
      const mappedMode = _intentTypeToMode[standardResult.intent as keyof typeof _intentTypeToMode];
      if (mappedMode) {
        _analyzerResult = {
          mode: mappedMode,
          confidence: Math.min(standardResult.confidence, 0.72),
          reason: `standard_rule:${standardResult.matchedRule}`,
          needsTask: mappedMode === "execute" || mappedMode === "collab",
          needsApproval: false,
          complexity: mappedMode === "collab" ? "complex" : "moderate",
          hasToolIntent: mappedMode === "execute" || mappedMode === "collab",
        };
        // 先不返回，继续到多模态层
      }
    }
  } catch { /* 统一规则库不可用时静默降级 */ }

  // ────── 多模态附件感知（补充性，词表驱动，无硬编码） ──────
  if (attachments && attachments.length > 0) {
    const vocab = getActiveVocab();
    const hints = vocab.multimodalHints ?? [];
    let bestBoost: { intent: string; confidence: number; attachmentType: string } | null = null;

    for (const attachment of attachments) {
      for (const hint of hints) {
        if (attachment.type === hint.attachmentType) {
          // 如果有文本模式要求，检查消息是否匹配
          if (hint.textPattern) {
            try {
              const textRe = new RegExp(hint.textPattern, "i");
              if (!textRe.test(message)) continue;
            } catch { continue; }
          }
          // 取最大 boost
          if (!bestBoost || hint.boostConfidence > bestBoost.confidence) {
            bestBoost = { intent: hint.boostIntent, confidence: hint.boostConfidence, attachmentType: hint.attachmentType };
          }
        }
      }
    }

    if (bestBoost) {
      // 如果 analyzer 已有结果，应用 boost 微调
      if (_analyzerResult) {
        _analyzerResult.confidence = Math.min(1.0, _analyzerResult.confidence + bestBoost.confidence);
        _analyzerResult.reason += ` +multimodal:${bestBoost.attachmentType}`;
        _logClassification(message, _analyzerResult);
        return _analyzerResult;
      }
      // 如果没有任何规则命中，多模态提示提供分类线索
      const boostMode = (bestBoost.intent === "execute" ? "execute" : bestBoost.intent === "collab" ? "collab" : "answer") as IntentMode;
      const r: IntentClassification = {
        mode: boostMode,
        confidence: Math.min(0.70, 0.50 + bestBoost.confidence),
        reason: `multimodal_hint:${bestBoost.attachmentType}`,
        needsTask: boostMode === "execute" || boostMode === "collab",
        needsApproval: false,
        complexity: "moderate",
        hasToolIntent: boostMode === "execute" || boostMode === "collab",
      };
      _logClassification(message, r);
      return r;
    }
  }

  // 如果 analyzer 有结果但无多模态 boost，返回 analyzer 结果
  if (_analyzerResult) {
    _logClassification(message, _analyzerResult);
    return _analyzerResult;
  }

  // --- 上下文感知兜底规则（减少灰区LLM调用）---

  // 规则B：问号结尾 — 几乎一定是提问（补充覆盖前置规则未命中的场景）
  if (/[?？]$/.test(msg)) {
    const r: IntentClassification = { mode: "answer", confidence: 0.80, reason: "question_mark_ending", needsTask: false, needsApproval: false, complexity: "simple", hasToolIntent: false };
    _logClassification(message, r);
    return r;
  }

  // 规则C：不含任何执行动作词的纯文本 — 大概率是对话
  if (!EXECUTE_ACTION_RE.test(msg) && !EXECUTE_REQUEST_RE.test(msg)) {
    const r: IntentClassification = { mode: "answer", confidence: 0.78, reason: "no_action_verb", needsTask: false, needsApproval: false, complexity: "simple", hasToolIntent: false };
    _logClassification(message, r);
    return r;
  }

  // ────── 所有规则均未命中 → 返回 null，交给 LLM ──────
  _logClassification(message, { mode: "answer", confidence: 0, reason: "fast_no_match_delegate_to_llm", needsTask: false, needsApproval: false, complexity: "simple" });
  return null;
}

/** 分类诊断日志输出（仅在 Node 环境有效） */
function _logClassification(
  message: string,
  result: IntentClassification,
  matchDetails?: Record<string, unknown>,
): void {
  try {
    const snippet = message.length > 60 ? message.slice(0, 60) + "…" : message;
    const detail = matchDetails ? ` match=${JSON.stringify(matchDetails)}` : "";
    if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
      _logger.info("classifyIntentFast", { mode: result.mode, confidence: result.confidence, reason: result.reason, snippet, ...matchDetails });
    }
  } catch { /* 静默 */ }
}

/* ================================================================== */
/*  P2-3: 特征打分 + 上下文状态升级                                        */
/*  P2-4: 跨轮上下文分类                                                  */
/*  P2-5: 多任务干预识别                                                  */
/*  P2-6: 可解释特征摘要                                                  */
/* ================================================================== */

/** P2-3: 特征向量（用于特征打分分类） */
export interface IntentFeatureVector {
  /** 消息长度类别 */
  lengthBucket: "ultra_short" | "short" | "medium" | "long";
  /** 是否包含动作词 */
  hasActionVerb: boolean;
  /** 是否包含请求前缀 */
  hasRequestPrefix: boolean;
  /** 是否是问句 */
  isQuestion: boolean;
  /** 是否包含高风险关键词 */
  hasHighRiskKeyword: boolean;
  /** 是否有活跃任务上下文 */
  hasActiveTask: boolean;
  /** 是否是干预意图 */
  isIntervention: boolean;
  /** 是否是多任务语境 */
  isMultiTask: boolean;
  /** 原始特征标签列表（P2-6） */
  featureLabels: string[];
}

/** P2-5: 干预意图模式 — 从 intentVocabulary.ts 共享引用 (INTERVENTION_PATTERNS) */

/**
 * P2-3/P2-4/P2-5/P2-6: 提取意图特征向量
 *
 * 从消息 + 上下文状态的多维特征，用于特征打分分类。
 * 输出可解释的特征标签（P2-6）。
 */
export function extractIntentFeatures(
  message: string,
  params?: Pick<ClassifyIntentParams, "activeRunContext" | "activeTaskIds">,
): IntentFeatureVector {
  const msg = message.trim();
  const len = msg.length;
  const featureLabels: string[] = [];

  // 长度分桶
  let lengthBucket: IntentFeatureVector["lengthBucket"] = "medium";
  if (len <= 5) lengthBucket = "ultra_short";
  else if (len <= 20) lengthBucket = "short";
  else if (len > 80) lengthBucket = "long";
  featureLabels.push(`len:${lengthBucket}`);

  // 请求前缀 — 使用词表驱动的预编译正则
  const hasRequestPrefix = EXECUTE_REQUEST_RE.test(msg);
  if (hasRequestPrefix) featureLabels.push("has_request_prefix");

  // 动作词 — 使用词表驱动的预编译正则
  const hasActionVerb = EXECUTE_ACTION_RE.test(msg);
  if (hasActionVerb) featureLabels.push("has_action_verb");

  // 问句
  const isQuestion = /[?？]$|[吗呢么呀嘛]$/.test(msg) || /^(?:什么|怎么|为什么|哪个|几个|多少)/.test(msg);
  if (isQuestion) featureLabels.push("is_question");

  // 高风险关键词
  const hasHighRiskKeyword = HIGH_RISK_KEYWORDS.some((k) => msg.includes(k) || msg.toLowerCase().includes(k));
  if (hasHighRiskKeyword) featureLabels.push("high_risk");

  // P2-4: 跨轮上下文
  const hasActiveTask = !!(params?.activeRunContext || (params?.activeTaskIds && params.activeTaskIds.length > 0));
  if (hasActiveTask) featureLabels.push("has_active_task");

  // P2-5: 干预意图
  let isIntervention = false;
  for (const pat of INTERVENTION_PATTERNS) {
    if (pat.re.test(msg)) {
      isIntervention = true;
      featureLabels.push(`intervention:${pat.type}`);
      break;
    }
  }

  // 多任务语境
  const isMultiTask = (params?.activeTaskIds?.length ?? 0) > 1;
  if (isMultiTask) featureLabels.push("multi_task");

  return {
    lengthBucket, hasActionVerb, hasRequestPrefix, isQuestion,
    hasHighRiskKeyword, hasActiveTask, isIntervention, isMultiTask,
    featureLabels,
  };
}

/**
 * P2-5: 从干预模式推断具体干预类型
 */
export function detectInterventionType(
  message: string,
): IntentClassification["interventionType"] | undefined {
  const msg = message.trim();
  for (const pat of INTERVENTION_PATTERNS) {
    if (pat.re.test(msg)) return pat.type;
  }
  return undefined;
}

/* ================================================================== */
/*  P1-3: 索引化 Pattern 表（预编译，模块加载时一次性生成）     */
/* ================================================================== */

/** 单个 pattern 规则 */
interface PatternEntry {
  id: string;
  mode: IntentMode;
  confidence: number;
  reason: string;
  /** 预编译的正则 */
  regex: RegExp;
  /** 是否为高风险写操作 */
  isHighRisk?: boolean;
  /** 是否需要任务 */
  needsTask?: boolean;
  /** 复杂度 */
  complexity?: IntentClassification["complexity"];
}

/** P1-3: 精简后的预编译 pattern 表 — 包含所有短路规则 */
const COMPILED_PATTERNS: PatternEntry[] = (() => {
  const entries: PatternEntry[] = [];

  // 问候 pattern
  entries.push({ id: "greeting", mode: "answer", confidence: 0.95, reason: "greeting_pattern", regex: GREETING_REGEX });

  // 协作关键词
  entries.push({ id: "collab", mode: "collab", confidence: 0.75, reason: "collab_keyword_detected", regex: COLLAB_REGEX, needsTask: true, complexity: "complex" });

  // 干预模式
  for (let i = 0; i < INTERVENTION_PATTERNS.length; i++) {
    entries.push({ id: `intervention_${i}`, mode: "intervene", confidence: 0.88, reason: `intervention_${INTERVENTION_PATTERNS[i].type}`, regex: INTERVENTION_PATTERNS[i].re });
  }

  // 观点/意见表达
  entries.push({ id: "opinion", mode: "answer", confidence: 0.88, reason: "opinion_expression", regex: OPINION_PREFIX_RE });

  // 请求前缀
  entries.push({ id: "exec_request", mode: "execute", confidence: 0.85, reason: "execute_request_prefix", regex: EXECUTE_REQUEST_RE, needsTask: true });

  // 动作词（置信度 0.60：低于灰区 LOW，确保走 LLM 复判）
  entries.push({ id: "exec_action", mode: "execute", confidence: 0.60, reason: "execute_action_verb", regex: EXECUTE_ACTION_RE, needsTask: true });

  // 问句指示词
  entries.push({ id: "question", mode: "answer", confidence: 0.82, reason: "question_pattern", regex: QUESTION_INDICATOR_RE });

  return entries;
})();

const COMPILED_EN_ACTION_RE: RegExp = /^$/;

/* ================================================================== */
/*  P1-1: 两级路由主入口                                          */
/* ================================================================== */

/**
 * P1-1: 两级路由分类器
 *
 * Level-1: classifyIntentFast (极快规则 <1ms)
 * Level-2: 灰区复判 —— 仅当 Level-1 置信度在灰区 [LOW, HIGH] 内时才调用 LLM
 *
 * 这样可以:
 * - 高置信度请求直接走快速路径（<1ms）
 * - 灰区请求才调用轻量 LLM，减少保守误伤
 * - 低置信度请求也进行复判，避免漏判执行请求
 */
export async function classifyIntentTwoLevel(
  params: ClassifyIntentParams,
): Promise<IntentClassification & { classifierUsed: "fast" | "llm" | "two_level" }> {
  // Level-1: 极薄快速规则分类
  const hasActiveTask = !!(params.activeRunContext || (params.activeTaskIds && params.activeTaskIds.length > 0));
  const fastCtx: FastClassifyContext = {
    hasActiveTask,
    activeTaskCount: params.activeTaskIds?.length ?? (params.activeRunContext ? 1 : 0),
  };
  const fastResult = classifyIntentFast(params.message, params.explicitMode, fastCtx, params.attachments);

  // 用户显式指定，直接信任
  if (params.explicitMode && fastResult) {
    return { ...fastResult, classifierUsed: "fast" };
  }

  // 快速短路命中且未启用两级路由，直接返回
  if (fastResult && !GRAY_ZONE.ENABLED) {
    return { ...fastResult, classifierUsed: "fast" };
  }

  // 快速短路命中且高置信度：直接信任 Level-1
  if (fastResult && fastResult.confidence >= GRAY_ZONE.HIGH) {
    return { ...fastResult, classifierUsed: "fast" };
  }

  // 无法快速短路 / 灰区 / 低置信度：进入 LLM 分类
  try {
    const llmResult = await classifyByLlm(params);

    // 如果快速短路有结果且与 LLM 一致，提升置信度
    if (fastResult && llmResult.mode === fastResult.mode) {
      return {
        ...llmResult,
        confidence: Math.min(1.0, Math.max(llmResult.confidence, fastResult.confidence) + 0.1),
        reason: `two_level_agree: ${fastResult.reason} + ${llmResult.reason}`,
        classifierUsed: "two_level" as const,
      };
    }

    // LLM 结果优先（它能感知上下文）
    return {
      ...llmResult,
      reason: fastResult
        ? `two_level_override: fast=${fastResult.mode}(${fastResult.confidence.toFixed(2)}) llm=${llmResult.mode}(${llmResult.confidence.toFixed(2)})`
        : `llm_primary: ${llmResult.reason}`,
      classifierUsed: fastResult ? "two_level" as const : "llm" as const,
    };
  } catch {
    // LLM 失败，回退到 Level-1 或默认
    if (fastResult) return { ...fastResult, classifierUsed: "fast" };
    return {
      mode: "answer" as IntentMode,
      confidence: 0.5,
      reason: "llm_fallback",
      needsTask: false,
      needsApproval: false,
      complexity: "simple" as const,
      hasToolIntent: false,
      classifierUsed: "fast" as const,
    };
  }
}

/* ================================================================== */
/*  P2-7: 意图复核器 (Intent Reviewer)                                    */
/* ================================================================== */

/**
 * P2-7: 复核配置
 *
 * REVIEW_HIGH_RISK_EXECUTE: 对高风险 execute 做二次模型确认
 * REVIEW_LOW_CONF_ANSWER:   对低置信 answer 做工具建议旁路检查
 */
export const INTENT_REVIEW_CONFIG = {
  /** 启用复核器 */
  ENABLED: (process.env.INTENT_REVIEWER_ENABLED ?? "1") === "1",
  /** 高风险 execute 置信度阈值（低于此值触发复核） */
  HIGH_RISK_THRESHOLD: parseFloat(process.env.INTENT_REVIEW_HR_THRESHOLD ?? "0.85"),
  /** 低置信 answer 阈值（低于此值触发旁路检查） */
  LOW_CONF_ANSWER_THRESHOLD: parseFloat(process.env.INTENT_REVIEW_LCA_THRESHOLD ?? "0.70"),
};

/**
 * P2-7: 意图复核器
 *
 * 接收 classifyIntentTwoLevel 的输出，进行额外安全检查：
 * 1. 高风险 execute + 低置信度 → 标记 needsConfirmation + 降置信
 * 2. 低置信 answer + 检测到工具意图 → 上调为 execute
 * 3. 输出 IntentDecision 统一模型
 */
export async function reviewIntentDecision(
  params: ClassifyIntentParams,
  classification: IntentClassification & { classifierUsed: "fast" | "llm" | "two_level" },
): Promise<IntentDecision> {
  const msg = params.message.trim();
  const msgLower = msg.toLowerCase();

  // 构建初始决策
  const featureSummary: string[] = [classification.reason];
  let reviewed = { ...classification };
  let classifierUsed: IntentDecision["classifierUsed"] = classification.classifierUsed;

  if (INTENT_REVIEW_CONFIG.ENABLED) {
    // ── 1. 高风险 execute 复核
    if (reviewed.mode === "execute" && reviewed.confidence < INTENT_REVIEW_CONFIG.HIGH_RISK_THRESHOLD) {
      const isHighRisk = HIGH_RISK_KEYWORDS.some(
        (k) => msg.includes(k) || msgLower.includes(k),
      );
      if (isHighRisk) {
        reviewed.needsApproval = true;
        reviewed.confidence = Math.max(0.3, reviewed.confidence - 0.1);
        featureSummary.push("reviewer:high_risk_execute_flagged");
        classifierUsed = "reviewer";
      }
    }

    // ── 2. 低置信 answer 旁路检查：检测是否应升级为 execute
    if (reviewed.mode === "answer" && reviewed.confidence < INTENT_REVIEW_CONFIG.LOW_CONF_ANSWER_THRESHOLD) {
      const hasExecuteSignal =
        EXECUTE_REQUEST_RE.test(msg) ||
        EXECUTE_ACTION_RE.test(msg);
      const hasActiveCtx = !!(params.activeRunContext || (params.activeTaskIds && params.activeTaskIds.length > 0));

      if (hasExecuteSignal) {
        // 消息含有明确的执行性词汇（"帮我创建"、"搜索"等），升级为 execute
        reviewed.mode = "execute" as IntentMode;
        reviewed.needsTask = true;
        reviewed.confidence = Math.max(0.60, reviewed.confidence + 0.05);
        featureSummary.push("reviewer:low_conf_answer_upgrade_execute");
        classifierUsed = "reviewer";
      } else if (hasActiveCtx && FOLLOW_UP_RE.test(msg)) {
        // 有活跃任务 + 跟进确认词（"好的继续"），升级为 intervene/resume
        reviewed.mode = "intervene" as IntentMode;
        reviewed.interventionType = "resume";
        reviewed.confidence = Math.max(0.65, reviewed.confidence + 0.05);
        featureSummary.push("reviewer:low_conf_answer_upgrade_intervene");
        classifierUsed = "reviewer";
      } else {
        // 无明确信号 → 保持 answer 但标记低置信度以便上层感知
        featureSummary.push("reviewer:low_conf_answer_kept");
      }
    }
  }

  return buildIntentDecision(reviewed, { classifierUsed, featureSummary });
}
