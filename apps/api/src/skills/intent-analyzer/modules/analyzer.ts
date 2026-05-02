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
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "api:intentAnalyzer" });
import { invokeModelChat, type LlmSubject } from "../../../lib/llm";
import {
  type IntentType,
  type IntentAnalyzeRequest,
  type IntentAnalyzeResponse,
  type ToolSuggestion,
  INTENT_KEYWORDS,
  CONFIDENCE_THRESHOLDS,
} from "./types";
import { buildStandardRules, matchStandardRules } from "../../../kernel/intentRuleStandard";
// 触发词表提供者注册到 kernel，确保 buildStandardRules 可获取动态词表
import "../../orchestrator/modules/intentVocabulary";

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

// ── DB 意图规则结构 ──
interface IntentRule {
  pattern: string;
  flags?: string;
  intent: string;
  confidence: number;
  tag?: string;
  prevIntent?: string;
  historyPattern?: string;
}

interface IntentRulesPayload {
  context_rules: IntentRule[];
  standalone_rules: IntentRule[];
  keywords?: Record<string, string[]>;
}

// ── 意图规则缓存（从 DB 加载，TTL 60s） ──
let _intentRuleCache: IntentRulesPayload | null = null;
let _intentRuleCacheAt = 0;
const INTENT_RULE_CACHE_TTL_MS = 60_000;

async function loadIntentPatterns(pool: Pool, tenantId: string): Promise<IntentRulesPayload | null> {
  if (_intentRuleCache && Date.now() - _intentRuleCacheAt < INTENT_RULE_CACHE_TTL_MS) {
    return _intentRuleCache;
  }
  try {
    const { rows } = await pool.query(
      `SELECT rules FROM orchestrator_rule_configs WHERE tenant_id = $1 AND rule_group = 'intent_pattern'`,
      [tenantId],
    );
    if (rows.length > 0 && rows[0].rules) {
      _intentRuleCache = rows[0].rules as IntentRulesPayload;
      _intentRuleCacheAt = Date.now();
      return _intentRuleCache;
    }
    return null;
  } catch {
    return _intentRuleCache ?? null;
  }
}

/** 安全编译正则：非法 pattern 返回 null 并打日志，不抛异常 */
function compileSafeRegex(pattern: string | undefined, flags?: string): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, flags ?? "i");
  } catch (err) {
    console.warn("[IntentAnalyzer] regex compile failed, skipping rule", {
      pattern,
      flags,
      error: (err as Error)?.message,
    });
    return null;
  }
}

/** 使用动态规则匹配意图（standalone_rules 路径） */
function matchStandaloneRules(trimmed: string, rules: IntentRule[]): RuleBasedResult | null {
  for (const rule of rules) {
    const regex = compileSafeRegex(rule.pattern, rule.flags);
    if (!regex) continue;
    if (regex.test(trimmed)) {
      return {
        intent: rule.intent as IntentType,
        confidence: rule.confidence,
        matchedKeywords: [rule.tag ?? rule.intent],
      };
    }
  }
  return null;
}

/** 使用动态规则匹配上下文意图（context_rules 路径） */
function matchContextRules(
  trimmed: string,
  rules: IntentRule[],
  lastRuleIntent: string,
  historyText: string,
): RuleBasedResult | null {
  for (const rule of rules) {
    // prevIntent 条件
    if (rule.prevIntent && lastRuleIntent !== rule.prevIntent) continue;
    // historyPattern 条件
    if (rule.historyPattern) {
      const hp = compileSafeRegex(rule.historyPattern, "i");
      if (!hp || !hp.test(historyText)) continue;
    }
    const regex = compileSafeRegex(rule.pattern, rule.flags);
    if (!regex) continue;
    if (regex.test(trimmed)) {
      return {
        intent: rule.intent as IntentType,
        confidence: rule.confidence,
        matchedKeywords: [rule.tag ?? rule.intent],
      };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────

interface RuleBasedResult {
  intent: IntentType;
  confidence: number;
  matchedKeywords: string[];
}

function detectIntentFromContext(
  message: string,
  context?: IntentAnalyzeRequest["context"],
  dbContextRules?: IntentRule[],
): RuleBasedResult | null {
  const trimmed = message.trim();
  const history = Array.isArray(context?.conversationHistory) ? context.conversationHistory : [];
  if (!trimmed || history.length === 0) return null;

  const lastUserTurn = [...history].reverse().find((item) => item.role === "user")?.content ?? "";
  const lastAssistantTurn = [...history].reverse().find((item) => item.role === "assistant")?.content ?? "";
  const lastRuleIntent = lastUserTurn ? detectIntentByRules(lastUserTurn).intent : "chat";
  const historyText = `${lastUserTurn}\n${lastAssistantTurn}`;

  // 优先使用 DB 动态规则
  if (dbContextRules && dbContextRules.length > 0) {
    return matchContextRules(trimmed, dbContextRules, lastRuleIntent, historyText);
  }

  // Fallback：硬编码上下文规则

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

export function detectIntentByRules(message: string, dbStandaloneRules?: IntentRule[]): RuleBasedResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return { intent: "chat", confidence: 0, matchedKeywords: [] };
  }

  // 优先使用 DB 动态规则
  if (dbStandaloneRules && dbStandaloneRules.length > 0) {
    const dbResult = matchStandaloneRules(trimmed, dbStandaloneRules);
    if (dbResult) return dbResult;
    // DB 规则未命中，继续走关键词打分逻辑
  } else {
    // Fallback：无 DB 规则时使用统一规则库（词表驱动，无硬编码）
    if (/^[.…!！?？.]+$/.test(trimmed)) {
      return { intent: "chat", confidence: 0.05, matchedKeywords: [] };
    }
    const standardRules = buildStandardRules();
    const standardResult = matchStandardRules(trimmed, standardRules);
    if (standardResult) {
      const kw: string[] = [`standard_rule:${standardResult.matchedRule}`];
      if (standardResult.matchedText) kw.push(standardResult.matchedText);
      return {
        intent: standardResult.intent,
        confidence: standardResult.confidence,
        matchedKeywords: kw,
      };
    }
  }

  // DB 规则命中后或两个分支均未命中时，使用统一规则库兜底
  const standardRules = buildStandardRules();
  const standardResult = matchStandardRules(message, standardRules);
  if (standardResult) {
    const kw: string[] = [`standard_rule:${standardResult.matchedRule}`];
    if (standardResult.matchedText) kw.push(standardResult.matchedText);
    return {
      intent: standardResult.intent,
      confidence: standardResult.confidence,
      matchedKeywords: kw,
    };
  }

  // Fallback: 内联关键词优先级匹配（当词表系统不可用时兜底）
  {
    const lower = trimmed.toLowerCase();

    // P20: 协作关键词
    const _collabKw = ["协作", "讨论", "辩论", "多智能体", "团队", "分配", "分工", "合作",
      "collaborate", "discuss", "debate", "assign", "team"];
    const mCollab = _collabKw.find(k => lower.includes(k.toLowerCase()));
    if (mCollab) {
      return { intent: "collab", confidence: 0.78, matchedKeywords: [mCollab] };
    }

    // P50: 执行动作词（task）
    const _taskKw = ["执行", "运行", "启动", "停止", "创建", "更新", "修改", "删除",
      "审批", "提交", "发布", "部署", "改为", "设为", "帮忙",
      "发送", "分析", "计算", "下载", "上传",
      "execute", "run", "create", "update", "delete", "submit", "approve", "deploy"];
    const mTask = _taskKw.find(k => lower.includes(k.toLowerCase()));
    if (mTask) {
      return { intent: "task", confidence: 0.82, matchedKeywords: [mTask] };
    }

    // P55: UI 生成模式（动词 + 目标词组合）
    const _uiVerbs = ["显示", "展示", "生成", "弄", "做", "设计", "show me", "design"];
    const _uiTargets = ["页面", "界面", "面板", "看板", "dashboard", "图表",
      "仪表盘", "布局", "表单", "报表"];
    const mVerb = _uiVerbs.find(v => lower.includes(v.toLowerCase()));
    const mTarget = _uiTargets.find(t => lower.includes(t.toLowerCase()));
    if (mVerb && mTarget) {
      return { intent: "ui", confidence: 0.82, matchedKeywords: [mVerb, mTarget] };
    }

    // P60: 查询特征词
    const _queryKw = ["查询", "查找", "搜索", "查看", "列出", "统计", "汇总", "报表",
      "筛选", "query", "search", "find", "list"];
    const mQuery = _queryKw.find(k => lower.includes(k.toLowerCase()));
    if (mQuery) {
      return { intent: "query", confidence: 0.72, matchedKeywords: [mQuery] };
    }

    // P68: UI 展示动词独立匹配
    const _uiDisplayVerbs = ["显示", "展示", "show me", "show", "display", "open"];
    const mDisplay = _uiDisplayVerbs.find(v => lower.includes(v.toLowerCase()));
    if (mDisplay) {
      return { intent: "ui", confidence: 0.72, matchedKeywords: [mDisplay] };
    }

    // P100: 问句指示词 → chat
    const _questionKw = ["什么是", "怎么", "为什么", "如何", "是否", "能不能",
      "可以吗", "有没有", "有哪些", "多少",
      "what is", "how to", "why", "which", "what", "how", "when", "where"];
    const mQuestion = _questionKw.find(k => lower.includes(k.toLowerCase()));
    if (mQuestion) {
      return { intent: "chat", confidence: 0.72, matchedKeywords: [mQuestion] };
    }
  }

  // 所有规则均未命中 → 默认 chat
  return {
    intent: "chat",
    confidence: 0.1,
    matchedKeywords: [],
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
    : "可用工具: entity.read, entity.create, workflow.approve, collab.propose";

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
      "toolRef": "entity.read@1.0",
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
      _logger.warn("LLM API error", { status: response.status });
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
      _logger.warn("invalid intent from LLM", { intent: parsed.intent });
      return null;
    }

    return {
      intent: parsed.intent,
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
      reasoning: parsed.reasoning || "LLM 分析结果",
      modelUsed: llmCfg.model,
    };
  } catch (err: any) {
    _logger.warn("LLM detection failed", { error: err?.message });
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
    : "可用工具: entity.read, entity.create, workflow.approve, collab.propose";

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
      "toolRef": "entity.read@1.0",
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
      _logger.warn("invalid intent from model-gateway LLM", { intent: parsed.intent });
      return null;
    }

    return {
      intent: parsed.intent,
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
      reasoning: parsed.reasoning || "LLM 分析结果",
      modelUsed: typeof result?.modelRef === "string" ? result.modelRef : params.defaultModelRef,
    };
  } catch (err: any) {
    _logger.warn("model-gateway detection failed", { error: err?.message });
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
        toolRef: "ui.page.generate@1.0",
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

  // 从 DB 加载意图规则（带 60s 缓存，DB 不可用时降级到硬编码 fallback）
  const tenantId = String(context?.tenantId ?? "tenant_dev").trim() || "tenant_dev";
  const intentRules = await loadIntentPatterns(pool, tenantId);

  // Step 1: 规则快速匹配
  const ruleResult = detectIntentByRules(message, intentRules?.standalone_rules);
  
  let intent: IntentType = ruleResult.intent;
  let confidence: number = ruleResult.confidence;
  let reasoning: string = `规则匹配: ${ruleResult.matchedKeywords.join(", ")}`;

  const contextResult = detectIntentFromContext(message, context, intentRules?.context_rules);
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
