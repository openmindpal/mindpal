/**
 * Intent Analyzer Core - 意图分析核心逻辑
 * 
 * 采用混合策略：
 * 1. 规则快速匹配（关键词 + 正则）- <1ms
 * 2. LLM 深度分析（当规则置信度 < 0.7 时触发）- 50-200ms
 * 3. 上下文增强（对话历史、可用工具）
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { invokeModelChat, type LlmSubject } from "../../../lib/llm";
import {
  type IntentType,
  type IntentAnalyzeRequest,
  type IntentAnalyzeResponse,
  type ToolSuggestion,
  INTENT_KEYWORDS,
  CONFIDENCE_THRESHOLDS,
} from "./types";

// ─── LLM Configuration ─────────────────────────────────────────────────

function resolveLlmConfig() {
  const endpoint = String(
    process.env.SKILL_LLM_ENDPOINT ||
    process.env.DISTILL_LLM_ENDPOINT ||
    process.env.KNOWLEDGE_EMBEDDING_ENDPOINT ||
    ""
  ).trim();
  if (!endpoint) return null;
  return {
    endpoint,
    apiKey: String(process.env.SKILL_LLM_API_KEY || process.env.DISTILL_LLM_API_KEY || "").trim() || null,
    model: String(process.env.SKILL_LLM_MODEL || process.env.DISTILL_LLM_MODEL || "gpt-4o-mini").trim(),
    timeoutMs: Math.max(5000, Number(process.env.SKILL_LLM_TIMEOUT_MS) || 30000),
  };
}

// ─── Rule-based Intent Detection ───────────────────────────────────────

interface RuleBasedResult {
  intent: IntentType;
  confidence: number;
  matchedKeywords: string[];
}

function detectIntentFromContext(
  message: string,
  context?: IntentAnalyzeRequest["context"]
): RuleBasedResult | null {
  const trimmed = message.trim();
  const history = Array.isArray(context?.conversationHistory) ? context.conversationHistory : [];
  if (!trimmed || history.length === 0) return null;

  const lastUserTurn = [...history].reverse().find((item) => item.role === "user")?.content ?? "";
  const lastAssistantTurn = [...history].reverse().find((item) => item.role === "assistant")?.content ?? "";
  const lastRuleIntent = lastUserTurn ? detectIntentByRules(lastUserTurn).intent : "chat";
  const historyText = `${lastUserTurn}\n${lastAssistantTurn}`;

  if (/^(继续|接着来|再多看几条|再看看|继续查|再查一些)$/i.test(trimmed) && lastRuleIntent === "query") {
    return { intent: "query", confidence: 0.68, matchedKeywords: ["context_query_follow_up"] };
  }
  if (/^(就用这个方案|按这个方案来|就按这个来|用这个方案)$/i.test(trimmed) && lastRuleIntent === "ui") {
    return { intent: "ui", confidence: 0.67, matchedKeywords: ["context_ui_follow_up"] };
  }
  if (/^(对，?执行吧|执行吧|开始吧|就这样执行)$/i.test(trimmed) && lastRuleIntent === "task") {
    return { intent: "task", confidence: 0.72, matchedKeywords: ["context_task_confirm"] };
  }
  if (/^(算了，不弄了|不要继续了|换个思路|先别弄了)$/i.test(trimmed) && lastRuleIntent === "task") {
    return { intent: "task", confidence: 0.64, matchedKeywords: ["context_task_cancel"] };
  }
  if (/^(和上次一样的格式|按上次那个格式|保持上次格式)$/i.test(trimmed) && /(生成|报表|月报|导出|格式)/i.test(historyText)) {
    return { intent: "task", confidence: 0.62, matchedKeywords: ["context_task_repeat"] };
  }
  if (/^搞定了没有$/i.test(trimmed) && lastRuleIntent === "task") {
    return { intent: "query", confidence: 0.58, matchedKeywords: ["context_status_query"] };
  }

  return null;
}

export function detectIntentByRules(message: string): RuleBasedResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return { intent: "chat", confidence: 0, matchedKeywords: [] };
  }
  if (/^[.…!！?？.]+$/.test(trimmed)) {
    return { intent: "chat", confidence: 0.05, matchedKeywords: [] };
  }
  if (/^(你好|您好|hello|hi|hey)$/i.test(trimmed)) {
    return { intent: "chat", confidence: 0.85, matchedKeywords: [trimmed] };
  }
  if (/^(谢谢|感谢).*(清楚|明白|解释|帮助|啦)?$/i.test(trimmed) || /^(好的|好吧|明白了|我知道了|收到|可以吗|行吗)([，,。.!！]|$)/i.test(trimmed)) {
    return { intent: "chat", confidence: 0.85, matchedKeywords: [trimmed] };
  }
  if (/什么是|区别|怎么|怎样|为什么|缺点|优点|详细|例子|展开讲讲|还有其他方法|跟上一个方案比|天气怎么样|架构是怎样|我想了解|解释一下|你觉得.+更好|推荐.+框架/i.test(trimmed)) {
    return { intent: "chat", confidence: 0.72, matchedKeywords: ["chat_qa_pattern"] };
  }
  if (/协作|多智能体|多角色|多个 agent|多个智能体|一起调查|一起评审|并行处理|团队讨论|组织一场.+讨论|发起.+讨论/i.test(trimmed)) {
    return { intent: "collab", confidence: 0.78, matchedKeywords: ["collab_pattern"] };
  }
  if (/查询并.*(删除|创建|审批|通知)|删除然后创建|执行审批最后发通知|把.+改为.+|改成发邮件|约一下|安排一下|排查一下|弄一下吧|换个思路|不要继续了/i.test(trimmed)) {
    return { intent: "task", confidence: 0.76, matchedKeywords: ["task_explicit_pattern"] };
  }
  if (/^有个东西需要你帮忙$/i.test(trimmed)) {
    return { intent: "task", confidence: 0.46, matchedKeywords: ["task_vague_request"] };
  }
  if (/^帮我看看数据$/i.test(trimmed)) {
    return { intent: "query", confidence: 0.45, matchedKeywords: ["看看数据"] };
  }
  if (/弄一下报表|做一下报表|生成报表|报表界面/i.test(trimmed)) {
    return { intent: "ui", confidence: 0.66, matchedKeywords: ["ui_report_pattern"] };
  }
  if (/上个月的报表|查一下.+报表|按时间排序|上个月的数据|这个月的数据|搞定了没有|把.+联系方式给我|查.+联系方式|结果有问题/i.test(trimmed)) {
    return { intent: "query", confidence: 0.72, matchedKeywords: ["query_explicit_pattern"] };
  }
  if (/生成.+(面板|页面|界面)|显示.+(看板|dashboard|图表|面板)|show me.+(dashboard|page|panel)|左边.+右边.+|上面.+下面.+|三栏布局|仪表盘|dashboard/i.test(trimmed)) {
    return { intent: "ui", confidence: 0.82, matchedKeywords: ["ui_explicit_pattern"] };
  }
  if (/界面|页面|面板|布局|表单|仪表盘|dashboard|图表|看板|左边.*右边|上面.*下面/i.test(trimmed)) {
    return { intent: "ui", confidence: 0.76, matchedKeywords: ["ui_pattern"] };
  }
  if (/查询|查找|搜索|列出|统计|汇总|找下|找找|看看|看下|拉一下|找出来|翻翻|有哪些|还在不在|历史订单|最近\d+条|数据不对劲|给我拉|帮我看下|报表|联系方式|再多看几条/i.test(trimmed)) {
    return { intent: "query", confidence: 0.72, matchedKeywords: ["query_pattern"] };
  }
  if (/创建|新建|更新|修改|删除|审批|发送|发一封|导入|安排|处理|转给|设置|发布|标记|撤回|重新来过|停止|取消|暂停|回滚|执行|通知|跳过审批|继续这个任务|排查|约一下|弄一下|改成|换个思路/i.test(trimmed)) {
    return { intent: "task", confidence: 0.74, matchedKeywords: ["task_pattern"] };
  }

  const lowerMsg = message.toLowerCase();
  const scores: Record<IntentType, number> = {
    chat: 0.1, // 默认基础分
    ui: 0,
    query: 0,
    task: 0,
    collab: 0,
  };

  const matchedKeywords: Record<IntentType, string[]> = {
    chat: [],
    ui: [],
    query: [],
    task: [],
    collab: [],
  };

  // 关键词匹配
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerMsg.includes(keyword.toLowerCase())) {
        scores[intent as IntentType] += 0.3;
        matchedKeywords[intent as IntentType].push(keyword);
      }
    }
  }

  // 正则模式增强
  const patterns: Array<{ intent: IntentType; regex: RegExp; score: number }> = [
    { intent: "ui", regex: /显示.*(?:笔记|订单|任务|数据)/, score: 0.4 },
    { intent: "ui", regex: /生成.*(?:页面|界面|dashboard)/, score: 0.5 },
    { intent: "query", regex: /查询.*(?:数量|统计|汇总)/, score: 0.4 },
    { intent: "task", regex: /(?:创建|更新|删除).*(?:记录|条目)/, score: 0.4 },
    { intent: "collab", regex: /邀请.*(?:参与|协作)/, score: 0.5 },
  ];

  for (const { intent, regex, score } of patterns) {
    if (regex.test(message)) {
      scores[intent] += score;
    }
  }

  // 找出最高分的意图
  let bestIntent: IntentType = "chat";
  let maxScore = scores.chat;

  for (const [intent, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      bestIntent = intent as IntentType;
    }
  }

  // 归一化置信度到 [0, 1]
  // 最高可能分数: 默认 0.1 + 多个关键词匹配 (每个 0.3) + 正则匹配 (最多 0.5)
  // 假设最多 3 个关键词 + 1 个正则 = 0.1 + 0.9 + 0.5 = 1.5
  const confidence = Math.min(1.0, maxScore);

  return {
    intent: bestIntent,
    confidence,
    matchedKeywords: matchedKeywords[bestIntent],
  };
}

// ─── LLM-based Intent Detection ────────────────────────────────────────

async function detectIntentWithLLM(
  llmCfg: ReturnType<typeof resolveLlmConfig>,
  message: string,
  context?: IntentAnalyzeRequest["context"]
): Promise<{ intent: IntentType; confidence: number; reasoning: string; modelUsed?: string } | null> {
  if (!llmCfg) return null;

  const historyText = context?.conversationHistory
    ? context.conversationHistory.slice(-5).map(h => `${h.role}: ${h.content}`).join("\n")
    : "";

  const availableToolsText = context?.availableTools
    ? `可用工具: ${context.availableTools.join(", ")}`
    : "可用工具: nl2ui.generate, entity.read, entity.create, workflow.approve, collab.propose";

  const prompt = `你是一个意图分析专家。请分析用户的输入，判断其意图类型并推荐合适的工具。

## 用户输入
${message}

## 对话历史（最近 5 轮）
${historyText || "(无)"}

## ${availableToolsText}

## 意图类型定义
- **chat**: 闲聊、问答、解释概念（无需工具调用）
- **ui**: 请求生成可视化界面、页面、dashboard、图表
- **query**: 查询、搜索、统计数据（只读操作）
- **task**: 执行任务、创建/更新/删除数据、审批流程（写操作）
- **collab**: 多智能体协作、分配任务、团队讨论

## 输出要求
请用 JSON 格式输出，包含以下字段：
{
  "intent": "chat" | "ui" | "query" | "task" | "collab",
  "confidence": 0.85,  // 0-1 之间的置信度
  "reasoning": "简要说明为什么判断为该意图",
  "suggestedTools": [  // 推荐的工具列表（chat 意图可为空数组）
    {
      "toolRef": "nl2ui.generate@1.0",
      "inputDraft": { "userInput": "显示我的笔记" },
      "confidence": 0.9,
      "reasoning": "用户明确要求显示界面"
    }
  ],
  "requiresConfirmation": false  // 是否为写操作需要确认
}

只输出纯 JSON，不要有其他内容。`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), llmCfg.timeoutMs);

    const response = await fetch(`${llmCfg.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(llmCfg.apiKey ? { Authorization: `Bearer ${llmCfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: llmCfg.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 500,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[intent-analyzer] LLM API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    // 解析 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    
    // 验证基本结构
    if (!parsed.intent || !INTENT_KEYWORDS[parsed.intent as IntentType]) {
      console.warn("[intent-analyzer] Invalid intent from LLM:", parsed.intent);
      return null;
    }

    return {
      intent: parsed.intent,
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
      reasoning: parsed.reasoning || "LLM 分析结果",
      modelUsed: llmCfg.model,
    };
  } catch (err: any) {
    console.warn("[intent-analyzer] LLM detection failed:", err?.message);
    return null;
  }
}

async function detectIntentWithModelGateway(params: {
  app: FastifyInstance;
  message: string;
  context?: IntentAnalyzeRequest["context"];
  defaultModelRef?: string;
}): Promise<{ intent: IntentType; confidence: number; reasoning: string; modelUsed?: string } | null> {
  const tenantId = String(params.context?.tenantId ?? "").trim();
  const subjectId = String(params.context?.userId ?? "intent_analyzer").trim() || "intent_analyzer";
  const spaceId = String(params.context?.spaceId ?? "").trim() || undefined;
  if (!tenantId) return null;

  const historyText = params.context?.conversationHistory
    ? params.context.conversationHistory.slice(-5).map(h => `${h.role}: ${h.content}`).join("\n")
    : "";

  const availableToolsText = params.context?.availableTools
    ? `可用工具: ${params.context.availableTools.join(", ")}`
    : "可用工具: nl2ui.generate, entity.read, entity.create, workflow.approve, collab.propose";

  const subject: LlmSubject = {
    tenantId,
    subjectId,
    ...(spaceId ? { spaceId } : {}),
  };

  const systemPrompt = `你是一个意图分析专家。请分析用户的输入，判断其意图类型并推荐合适的工具。

## 对话历史（最近 5 轮）
${historyText || "(无)"}

## ${availableToolsText}

## 意图类型定义
- **chat**: 闲聊、问答、解释概念（无需工具调用）
- **ui**: 请求生成可视化界面、页面、dashboard、图表
- **query**: 查询、搜索、统计数据（只读操作）
- **task**: 执行任务、创建/更新/删除数据、审批流程（写操作）
- **collab**: 多智能体协作、分配任务、团队讨论

## 输出要求
请用 JSON 格式输出，包含以下字段：
{
  "intent": "chat" | "ui" | "query" | "task" | "collab",
  "confidence": 0.85,
  "reasoning": "简要说明为什么判断为该意图",
  "suggestedTools": [
    {
      "toolRef": "nl2ui.generate@1.0",
      "inputDraft": { "userInput": "显示我的笔记" },
      "confidence": 0.9,
      "reasoning": "用户明确要求显示界面"
    }
  ],
  "requiresConfirmation": false
}

只输出纯 JSON，不要有其他内容。`;

  try {
    const timeoutMs = Math.max(5_000, Number(process.env.INTENT_ANALYZER_MODEL_TIMEOUT_MS) || 20_000);
    const result = await invokeModelChat({
      app: params.app,
      subject,
      locale: "zh-CN",
      purpose: "intent.analyze",
      timeoutMs,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: params.message.slice(0, 500) },
      ],
      ...(params.defaultModelRef ? { constraints: { candidates: [params.defaultModelRef] } } : {}),
    });

    const outputText = typeof result?.outputText === "string" ? result.outputText : "";
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.intent || !INTENT_KEYWORDS[parsed.intent as IntentType]) {
      console.warn("[intent-analyzer] Invalid intent from model-gateway LLM:", parsed.intent);
      return null;
    }

    return {
      intent: parsed.intent,
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
      reasoning: parsed.reasoning || "LLM 分析结果",
      modelUsed: typeof result?.modelRef === "string" ? result.modelRef : params.defaultModelRef,
    };
  } catch (err: any) {
    console.warn("[intent-analyzer] model-gateway detection failed:", err?.message);
    return null;
  }
}

// ─── Tool Suggestion Generation ────────────────────────────────────────

function generateToolSuggestions(
  intent: IntentType,
  message: string,
  context?: IntentAnalyzeRequest["context"]
): ToolSuggestion[] {
  const suggestions: ToolSuggestion[] = [];

  switch (intent) {
    case "ui":
      suggestions.push({
        toolRef: "nl2ui.generate@1.0",
        inputDraft: { userInput: message },
        confidence: 0.9,
        reasoning: "用户请求生成可视化界面",
      });
      break;

    case "query":
      // 尝试从消息中提取实体名
      const entityMatch = message.match(/(?:查询|查看|列出)(?:的)?(.+?)(?:信息|数据|列表|记录)?$/);
      const entityName = entityMatch ? entityMatch[1].trim() : "entity";
      
      suggestions.push({
        toolRef: "entity.read@1.0",
        inputDraft: {
          entityName,
          filters: {},
          limit: 20,
        },
        confidence: 0.7,
        reasoning: `用户可能想查询 ${entityName} 相关数据`,
      });
      break;

    case "task":
      // 检测是否为创建/更新/删除操作
      if (/创建|新建/.test(message)) {
        suggestions.push({
          toolRef: "entity.create@1.0",
          inputDraft: { entityName: "unknown", data: {} },
          confidence: 0.6,
          reasoning: "用户可能想创建新记录",
        });
      } else if (/更新|修改/.test(message)) {
        suggestions.push({
          toolRef: "entity.update@1.0",
          inputDraft: { entityName: "unknown", id: "", data: {} },
          confidence: 0.6,
          reasoning: "用户可能想更新现有记录",
        });
      } else if (/审批|审核/.test(message)) {
        suggestions.push({
          toolRef: "workflow.approve@1.0",
          inputDraft: { approvalId: "" },
          confidence: 0.7,
          reasoning: "用户可能想执行审批操作",
        });
      }
      break;

    case "collab":
      suggestions.push({
        toolRef: "collab.propose@1.0",
        inputDraft: { topic: message.slice(0, 100) },
        confidence: 0.6,
        reasoning: "用户可能想发起协作讨论",
      });
      break;

    case "chat":
      // 闲聊无需工具建议
      break;
  }

  return suggestions;
}

// ─── Main Analysis Function ────────────────────────────────────────────

export async function analyzeIntent(
  pool: Pool,
  request: IntentAnalyzeRequest,
  options?: { app?: FastifyInstance; defaultModelRef?: string }
): Promise<IntentAnalyzeResponse> {
  const startTime = Date.now();
  const { message, context } = request;

  // Step 1: 规则快速匹配
  const ruleResult = detectIntentByRules(message);
  
  let intent: IntentType = ruleResult.intent;
  let confidence: number = ruleResult.confidence;
  let reasoning: string = `规则匹配: ${ruleResult.matchedKeywords.join(", ")}`;

  const contextResult = detectIntentFromContext(message, context);
  if (contextResult && contextResult.confidence >= confidence) {
    intent = contextResult.intent;
    confidence = contextResult.confidence;
    reasoning = `上下文匹配: ${contextResult.matchedKeywords.join(", ")}`;
  }

  // Step 2: 如果规则置信度低，使用 LLM 深度分析
  const llmCfg = resolveLlmConfig();
  let llmActuallyUsed = false;
  let llmModelUsed: string | undefined;
  const gatewayLlmEnabled = Boolean(options?.app && context?.tenantId);
  if (confidence < CONFIDENCE_THRESHOLDS.HIGH && (gatewayLlmEnabled || llmCfg)) {
    const llmResult = gatewayLlmEnabled
      ? await detectIntentWithModelGateway({
          app: options!.app!,
          message,
          context,
          defaultModelRef: options?.defaultModelRef,
        })
      : await detectIntentWithLLM(llmCfg, message, context);
    if (llmResult) {
      // LLM 结果权重更高
      intent = llmResult.intent;
      confidence = llmResult.confidence * 0.9 + confidence * 0.1; // LLM 占 90% 权重
      reasoning = llmResult.reasoning;
      llmActuallyUsed = true;
      llmModelUsed = llmResult.modelUsed;
    }
  }

  // Step 3: 生成工具建议
  const suggestedTools = generateToolSuggestions(intent, message, context);

  // Step 4: 判断是否需要确认
  const requiresConfirmation = 
    intent === "task" && confidence < CONFIDENCE_THRESHOLDS.HIGH;

  // Step 5: 构建响应
  const processingTimeMs = Date.now() - startTime;

  return {
    intent,
    confidence: Math.round(confidence * 100) / 100,
    reasoning,
    suggestedTools,
    requiresConfirmation,
    metadata: {
      analyzedAt: new Date().toISOString(),
      modelUsed: llmActuallyUsed ? llmModelUsed : undefined,
      processingTimeMs,
    },
  };
}
