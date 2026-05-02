import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { redactValue, resolveNumber } from "@mindpal/shared";
import { Errors } from "../../../lib/errors";
import { invokeModelChat, parseToolCallsFromOutput, type LlmSubject } from "../../../lib/llm";
import { executeInlineTools, formatInlineResultsForLLM, loadInlineWritableEntities } from "./inlineToolExecutor";
import { resolveExecutionClassFromSuggestions } from "../dispatch.executionPolicy";
import type { OrchestratorTurnRequest, OrchestratorTurnResponse } from "./model";
import { getSessionContext, upsertSessionContext, type SessionMessage, type SessionState } from "../../../modules/memory/sessionContextRepo";
import { getToolVersionByRef, type ToolDefinition } from "../../../modules/tools/toolRepo";
import { insertAuditEvent } from "../../../modules/audit/auditRepo";
import { getEffectiveRoutingPolicy } from "../../../modules/modelGateway/routingPolicyRepo";

// Re-export from agentContext (canonical location) for convenience
export { discoverEnabledTools, recallRelevantMemory, recallRecentTasks, recallRelevantKnowledge, type EnabledTool } from "../../../modules/agentContext";
import { discoverEnabledTools, recallRecentTasks, type EnabledTool } from "../../../modules/agentContext";

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// ── Fallback（DB 不可用时降级） ──────────────────────────────────────

const FALLBACK_EVENT_TRIGGER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /换个话题|说回|回到|继续(之前的|刚才的)/i, reason: 'topic_switch' },
  { pattern: /总结一下|归纳一下|所以(结论是|结果是)/i, reason: 'conclusion' },
  { pattern: /定稿|确认|就这样(吧|了)/i, reason: 'finalization' },
  { pattern: /列(个|出|一下)(清单|列表|要点)/i, reason: 'listing' },
  { pattern: /按(前面|之前|刚才)(的方式|的方法|的思路)/i, reason: 'reference' },
];

// 元数据驱动：分类显示名完全由 DB orchestrator_rule_configs 的 category_display 规则提供。
// 缺失时以 category key 本身作为显示名，避免硬编码业务语义。
const FALLBACK_CATEGORY_NAMES: Record<string, { zh: string; en: string }> = {};

// OS 级分层定义（四层架构是平台概念，非业务数据，可硬编码）
const FALLBACK_LAYER_NAMES: Record<string, { zh: string; en: string; examples: string[] }> = {
  "kernel": { zh: "Kernel 内核层", en: "Kernel Layer", examples: ["实体CRUD", "工具治理"] },
  "core": { zh: "Core 核心层", en: "Core Layer", examples: ["编排", "模型网关", "知识", "记忆", "安全"] },
  "optional": { zh: "Optional 可选层", en: "Optional Layer", examples: ["界面生成", "权限管理", "协作运行时"] },
  "extension": { zh: "Extension 扩展层", en: "Extension Layer", examples: ["媒体", "自动化", "分析"] },
};

const FALLBACK_ACTION_INTENT_REGEX = /执行|(帮我.{0,8}创建)|(帮我.{0,8}删除)|(帮我.{0,8}更新)|(帮我.{0,8}发送)|(帮我.{0,8}关闭)|(请.{0,8}创建)|(请.{0,8}删除)/i;

// ── 编排器规则缓存（从 DB 加载，TTL 60s） ───────────────────────────

interface OrchestratorRuleCache {
  eventTriggers: Array<{ pattern: RegExp; reason: string }>;
  categoryDisplay: Record<string, { zh: string; en: string }>;
  layerDisplay: Record<string, { zh: string; en: string; examples: string[] }>;
  intentPatterns: any;
  actionIntentRescue: RegExp | null;
}

let _ruleCache: OrchestratorRuleCache | null = null;
let _ruleCacheAt = 0;
const RULE_CACHE_TTL_MS = 60_000;

async function loadOrchestratorRuleConfigs(pool: Pool, tenantId: string): Promise<OrchestratorRuleCache> {
  if (_ruleCache && Date.now() - _ruleCacheAt < RULE_CACHE_TTL_MS) {
    return _ruleCache;
  }
  try {
    const { rows } = await pool.query(
      `SELECT rule_group, rules FROM orchestrator_rule_configs WHERE tenant_id = $1`,
      [tenantId],
    );
    const byGroup = new Map(rows.map((r: any) => [r.rule_group, r.rules]));

    // event_trigger: JSON 中 pattern 是字符串，需编译为 RegExp
    const rawTriggers: any[] = byGroup.get("event_trigger") ?? [];
    const eventTriggers = rawTriggers.map((t: any) => ({
      pattern: new RegExp(t.pattern, t.flags ?? "i"),
      reason: String(t.reason),
    }));

    _ruleCache = {
      eventTriggers: eventTriggers.length > 0 ? eventTriggers : FALLBACK_EVENT_TRIGGER_PATTERNS,
      categoryDisplay: byGroup.get("category_display") ?? FALLBACK_CATEGORY_NAMES,
      layerDisplay: byGroup.get("layer_display") ?? FALLBACK_LAYER_NAMES,
      intentPatterns: byGroup.get("intent_pattern") ?? null,
      actionIntentRescue: (() => {
        const raw = byGroup.get("action_intent_rescue");
        if (raw?.pattern) return new RegExp(raw.pattern, raw.flags ?? "i");
        return null;
      })(),
    };
    _ruleCacheAt = Date.now();
    return _ruleCache;
  } catch {
    // DB 不可用时用 fallback
    return _ruleCache ?? {
      eventTriggers: FALLBACK_EVENT_TRIGGER_PATTERNS,
      categoryDisplay: FALLBACK_CATEGORY_NAMES,
      layerDisplay: FALLBACK_LAYER_NAMES,
      intentPatterns: null,
      actionIntentRescue: null,
    };
  }
}

/** P0: 解析结构化摘要（从 LLM 输出中提取 JSON） */
export function parseStructuredSummary(text: string): { structured: Record<string, any> | null; summary: string } {
  try {
    // 提取JSON块（支持```json包裹或直接JSON）
    const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      return {
        structured: parsed,
        summary: parsed.summary || text.slice(0, 500)
      };
    }
  } catch {
    // 解析失败，降级为自由文本
  }
  return { structured: null, summary: text.slice(0, 500) };
}

/** P0: 从文本中提取焦点实体（简单启发式） */
export function extractEntities(...texts: (string|undefined)[]): string[] {
  const combined = texts.filter(Boolean).join(' ');
  const patterns = [
    /["'"](.*?)["'"]/g,  // 引号内容
    /《(.*?)》/g,          // 书名号
    /([A-Z][a-zA-Z]+(?:项目|系统|流程|审批|任务))/g,  // 专有名词
  ];
  const entities = new Set<string>();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(combined))) {
      entities.add(match[1]);
    }
  }
  return Array.from(entities).slice(0, 10);  // 最多保留10个焦点实体
}

/** P0: 检测是否应该触发事件驱动摘要 */
export function shouldTriggerEventDrivenSummary(
  message: string,
  totalTurnCount: number,
  eventTriggers?: Array<{ pattern: RegExp; reason: string }>,
): { should: boolean; reason?: string } {
  // 1. 检测到关键事件关键词
  const patterns = eventTriggers ?? FALLBACK_EVENT_TRIGGER_PATTERNS;
  
  for (const { pattern, reason } of patterns) {
    if (pattern.test(message)) {
      return { should: true, reason };
    }
  }
  
  // 2. 每10轮定期触发（防止长时间对话无摘要）
  if (totalTurnCount > 0 && totalTurnCount % 10 === 0) {
    return { should: true, reason: 'periodic_10' };
  }
  
  // 3. 消息长度突增（可能包含复杂决策）
  if (message.length > 500 && totalTurnCount > 5) {
    return { should: true, reason: 'long_message' };
  }
  
  return { should: false };
}

/** 将 SessionState 槽位动态构建为上下文文本，不硬编码字段列表 */
export function buildSessionStateContext(state: SessionState | undefined): string | null {
  if (!state) return null;
  const parts: string[] = [];
  for (const [key, val] of Object.entries(state)) {
    if (key === 'lastUpdatedAt' || val == null || val === '') continue;
    if (Array.isArray(val) && val.length === 0) continue;
    parts.push(`${key}: ${Array.isArray(val) ? val.join(', ') : String(val)}`);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function conversationWindowSize() {
  const raw = resolveNumber("ORCHESTRATOR_CONVERSATION_WINDOW").value;
  return clampInt(Number.isFinite(raw) ? Math.floor(raw) : 16, 4, 64);
}

/** 上下文元信息，用于注入 system prompt */
export type ContextMeta = {
  /** 累计对话总轮数 */
  totalTurnCount?: number;
  /** 当前窗口中保留的消息数 */
  windowMessageCount?: number;
  /** 窗口溢出时由 LLM 生成的早期对话摘要 */
  summary?: string;
};

/**
 * 将摘要上下文注入 prompt parts。
 * 简化版：只注入 LLM 生成的摘要 + 轮次提示。
 */
function appendConversationContext(parts: string[], contextMeta: ContextMeta | undefined, locale: string) {
  if (!contextMeta) return;
  const zh = locale !== "en-US";

  if (contextMeta.summary) {
    const turnInfo = contextMeta.totalTurnCount
      ? (zh
        ? `（本次对话已累计 ${contextMeta.totalTurnCount} 轮，当前窗口仅保留了最近 ${contextMeta.windowMessageCount ?? "?"} 条消息。以下是更早对话的摘要。）`
        : `(This conversation has ${contextMeta.totalTurnCount} turns total, but only the latest ${contextMeta.windowMessageCount ?? "?"} messages are in your context window. Below is a summary of the earlier conversation.)`)
      : "";
    parts.push(
      `\n## ${zh ? "早期对话摘要" : "Earlier Conversation Summary"}\n` +
      turnInfo + "\n" +
      contextMeta.summary +
      `\n\n${zh ? "基于以上摘要保持对话连续性。用户提及'刚才''前面''之前'时，请结合摘要中的信息回应。" : "Use this summary to maintain continuity. When user references earlier content, use this context."}`
    );
  } else if (contextMeta.totalTurnCount && contextMeta.totalTurnCount > (contextMeta.windowMessageCount ?? 0)) {
    parts.push(
      zh
        ? `\n（注意：本次对话已累计 ${contextMeta.totalTurnCount} 轮，当前仅可见最近 ${contextMeta.windowMessageCount} 条消息，部分早期上下文可能缺失。）`
        : `\n(Note: This conversation has ${contextMeta.totalTurnCount} turns but only the latest ${contextMeta.windowMessageCount} messages are visible. Some early context may be missing.)`
    );
  }
}

/**
 * 从已启用工具列表动态提取能力摘要（用于轻量聊天模式）
 * 不写死能力描述，而是根据实际加载的 Skills/Tools 自动生成能力画像
 */
function buildCapabilitySummary(
  tools: EnabledTool[],
  locale: string,
  categoryNames?: Record<string, { zh: string; en: string }>,
  layerNames?: Record<string, { zh: string; en: string; examples: string[] }>,
): string {
  const zh = locale !== "en-US";
  
  // 按分类聚合工具
  const categoryMap = new Map<string, { count: number; examples: string[]; layers: Set<string> }>();
  for (const tool of tools) {
    const cat = tool.def.category || "uncategorized";
    if (!categoryMap.has(cat)) {
      categoryMap.set(cat, { count: 0, examples: [], layers: new Set() });
    }
    const entry = categoryMap.get(cat)!;
    entry.count++;
    if (entry.examples.length < 2) {
      entry.examples.push(tool.name);
    }
    // 记录工具所属的分层
    const layer = tool.def.sourceLayer;
    if (layer) entry.layers.add(layer);
  }

  // 分类名称映射
  const catNames = categoryNames ?? FALLBACK_CATEGORY_NAMES;

  // 构建能力描述
  const capabilityLines: string[] = [];
  for (const [cat, info] of categoryMap.entries()) {
    const names = catNames[cat] || { zh: cat, en: cat };
    capabilityLines.push(
      zh
        ? `- ${names.zh}（${info.count}个工具）：${info.examples.join("、")}`
        : `- ${names.en} (${info.count} tools): ${info.examples.join(", ")}`
    );
  }

  const totalTools = tools.length;
  const capabilitiesText = capabilityLines.join("\n");
  
  // 动态提取当前激活的架构分层（从实际工具中推断）
  const activeLayers = new Set<string>();
  const layerSkills = new Map<string, string[]>();
  for (const tool of tools) {
    const layer = tool.def.sourceLayer || "optional";
    activeLayers.add(layer);
    if (!layerSkills.has(layer)) layerSkills.set(layer, []);
    const skillName = tool.name.split('.')[0];
    const skills = layerSkills.get(layer)!;
    if (!skills.includes(skillName)) skills.push(skillName);
  }

  // 分层名称映射
  const lyrNames = layerNames ?? FALLBACK_LAYER_NAMES;

  // 构建动态架构描述
  const activeLayerLines: string[] = [];
  for (const [layer, skills] of layerSkills.entries()) {
    const info = lyrNames[layer] || { zh: layer, en: layer, examples: [] };
    activeLayerLines.push(
      zh
        ? `- ${info.zh}：${skills.join("、")}`
        : `- ${info.en}: ${skills.join(", ")}`
    );
  }

  const architectureDesc = zh
    ? `你是 灵智Mindpal，基于 Agent OS 架构的智能体底层系统。

## 当前架构状态
- **激活分层**（${activeLayers.size}层）：${activeLayerLines.join("；")}
- **Skill 技能体系**：所有非核心功能封装为可插拔 Skill，支持沙箱隔离、声明式权限、热更新
- **治理平面**：变更集管理（草稿→提交→审批→发布→回滚）、灰度发布、评测准入、全链路审计
- **运行时流程**：意图分析 → 目标分解 → 工具编排 → 执行观测 → 结果合成
- **扩展机制**：通过注册新 Skill 包即可扩展能力，无需修改核心平台

## 当前能力` + (totalTools > 0 ? `（已启用 ${totalTools} 个工具）` : "（当前工作区未启用工具，可進行普通对话）") + `
${capabilitiesText}

你可以调用这些工具帮助用户完成任务。当用户询问能力时，请基于以上实际可用工具和架构特征作答，不要虚构不存在的功能。如需扩展新能力，可通过开发并注册新的 Skill 包实现。`
    : `You are 灵智Mindpal, an intelligent agent system based on Agent OS architecture.

## Current Architecture Status
- **Active Layers** (${activeLayers.size}): ${activeLayerLines.join("; ")}
- **Skill System**: All non-core features are encapsulated as pluggable Skills with sandbox isolation, declarative permissions, and hot-reload support
- **Governance Plane**: Changeset management (draft→submit→approve→release→rollback), canary releases, eval gating, full audit trails
- **Runtime Flow**: Intent analysis → Goal decomposition → Tool orchestration → Execution observation → Result synthesis
- **Extensibility**: Register new Skill packages to extend capabilities without modifying the core platform

## Current Capabilities` + (totalTools > 0 ? ` (${totalTools} tools enabled)` : " (No tools enabled in this workspace; regular conversation available)") + `
${capabilitiesText}

You can invoke these tools to help users complete tasks. When asked about capabilities, respond based on the actual available tools and architecture features listed above; do not fabricate features. To extend capabilities, develop and register new Skill packages.`;

  return architectureDesc;
}

/**
 * 轻量聊天版 system prompt：
 * 动态感知当前工作区已启用的 Skills/Tools，自动生成能力画像，
 * 而非写死能力描述。这样智能体始终知道自己的实际能力边界。
 */
export function buildLightChatPrompt(
  locale: string,
  contextMeta?: ContextMeta,
  enabledTools?: EnabledTool[],
  ruleCache?: OrchestratorRuleCache,
): string {
  const zh = locale !== "en-US";

  // 动态生成能力摘要（基于实际加载的工具）
  const capabilitySummary = buildCapabilitySummary(
    enabledTools ?? [],
    locale,
    ruleCache?.categoryDisplay,
    ruleCache?.layerDisplay,
  );

  const parts: string[] = [
    capabilitySummary,
    zh
      ? "根据对话上下文自主判断是否需要调用工具。当你需要查询不在当前对话上下文中的信息时，应主动通过可用工具进行查询，而非仅凭已有信息作答。保持对话的自然流畅，当用户在表达观点、纠正误解或进行讨论时，应自然地回应并保持话题连贯性。"
      : "Autonomously decide whether to invoke tools based on conversation context. When you need information not present in the current conversation, proactively use available tools to query it rather than answering with only what you have. Maintain natural conversational flow — when the user is expressing opinions, correcting misunderstandings, or having a discussion, respond naturally and maintain topic coherence.",
  ];
  appendConversationContext(parts, contextMeta, locale);
  return parts.join("\n");
}

/**
 * 完整版 system prompt（原 buildSystemPrompt）：
 * 包含完整平台描述、工具目录、记忆、摘要。
 * 用于有工具调用需求的任务执行场景。
 */
export function buildSystemPrompt(
  locale: string,
  taskContext: string,
  toolCatalog: string,
  contextMeta?: ContextMeta,
): string {
  const parts: string[] = [
    "You are 灵智Mindpal, the intelligent agent of an Agent OS / Agent Infrastructure platform.",
    "Your underlying system — the 灵智Mindpal Agent OS — is a governed agent foundation designed for enterprises and edge environments.",
    "It turns LLM capabilities into controlled, auditable execution in real systems, with built-in RBAC, DLP, approval workflows, changeset-based release/rollback, policy snapshots, and full audit trails.",
    "Core architecture layers: (1) Governance plane — identity, RBAC, safety policies, approvals, audit, release management; (2) Execution plane — tool contracts with versioned schemas, idempotency, workflows, async tasks; (3) Device runtime — edge devices, gateways, robot controllers, desktop executors under the same permission boundary; (4) Knowledge & Memory — RAG with evidence chains, long-term memory, task history; (5) Multi-channel interop — IM/Webhook ingress, reliable outbox, receipts.",
    "The platform is extensible via Skills (sandboxed tool packages with manifest-declared permissions and network policies). Any business domain — enterprise operations, industrial automation, embodied intelligence, smart cities, finance, healthcare, logistics and more — can be served by developing and registering new Skills, without modifying the core platform.",
    "You have access to the user's long-term memory, task history, and a set of platform tools/skills.",
    "When you need information not present in the current conversation (user data, preferences, history, knowledge, etc.), proactively use available tools to query it rather than answering with only what you have.",
    "Follow user locale when replying. Be concise and helpful.",
    "You CANNOT execute tools directly. You can only suggest tool invocations using the required tool_call block format.",
    "NEVER claim that a tool has been executed or that data has been saved unless the system provides an execution receipt/result.",
    "When suggesting a tool, use conditional language (e.g., 'I can help you with this by running the tool below') and avoid 'already saved' wording.",
    "When you identify information worth remembering (user preferences, important facts, explicit save requests), use memory.write to persist it. Do not ask for confirmation when the save intent is clear.",
    "When recalling user memory, do NOT pass a 'types' filter unless the user explicitly asks for a specific category. Always use a broad query and set limit=10 or higher to ensure all memory types are covered.",
  ];
  if (toolCatalog) {
    parts.push(
      "\n## Available Tools (enabled in current workspace)\n" +
      toolCatalog +
      "\nTOOL CALL FORMAT: When you decide to use a tool, include a tool_call block in this markdown format at the END of your reply:" +
      '\n```tool_call\n[{"toolRef":"<toolRef>","inputDraft":{<key>:<value>}}]\n```' +
      "\nAlways use this markdown code block format for tool invocations."
    );
  } else {
    parts.push(
      "\n\nNo database tools are currently enabled in this workspace. You can still help with information, analysis, and suggestions."
    );
  }
  if (taskContext) {
    parts.push(
      "\n## Recent Tasks\n" +
      taskContext +
      "\n\nUse the above task history to understand what the user has been working on recently."
    );
  }
  appendConversationContext(parts, contextMeta, locale);
  return parts.join("\n");
}

function conversationTtlMs() {
  const rawDays = resolveNumber("ORCHESTRATOR_CONVERSATION_TTL_DAYS").value;
  const days = clampInt(Number.isFinite(rawDays) ? Math.floor(rawDays) : 14, 1, 30);
  return days * 24 * 60 * 60 * 1000;
}

/* ═══ 滑动窗口溢出时的 LLM 摘要 ═══ */

/**
 * 窗口溢出时，使用 LLM 对被截断的早期消息生成简洁摘要。
 * 这是主流大模型平台的通用做法，比正则提取更准确。
 * 仅在窗口实际发生溢出时调用（并非每轮）。
 * 失败时降级为简单截断拼接。
 */
export async function summarizeDroppedMessages(params: {
  app: FastifyInstance;
  subject: LlmSubject;
  dropped: SessionMessage[];
  prevSummary?: string;
  locale?: string;
  authorization?: string | null;
  traceId?: string | null;
}): Promise<{ summary: string; sessionState?: SessionState }> {
  const { dropped, prevSummary } = params;
  if (!dropped.length && !prevSummary) return { summary: "" };

  // 拼接要摘要的消息（每条截取前 300 字控制输入长度）
  const messagesToSummarize = dropped.map(m => {
    const prefix = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统";
    return `${prefix}: ${(m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}`;
  }).join("\n");

  const zh = (params.locale ?? "zh-CN") !== "en-US";
  const prompt = prevSummary
    ? (zh
      ? `以下是之前的对话摘要和新的对话消息。请生成一个更新后的结构化摘要（不超过800字）。

之前的摘要：
${prevSummary}

新消息：
${messagesToSummarize}

请严格按以下JSON格式输出（不要输出其他内容）：
{
  "activeTopic": "当前讨论的核心主题（1-2句话）",
  "userIntent": "用户明确表达的任务意图或目标",
  "keyDecisions": ["用户决策1", "决策2"],
  "constraints": ["约束条件1", "条件2"],
  "pendingQuestions": ["待回答问题1"],
  "riskPoints": ["风险点1"],
  "summary": "整体对话的简洁摘要（300字以内）"
}`
      : `Below is the previous summary and new messages. Generate an updated structured summary (max 800 chars).

Previous summary:
${prevSummary}

New messages:
${messagesToSummarize}

Please output strictly in the following JSON format (no other content):
{
  "activeTopic": "Current core topic (1-2 sentences)",
  "userIntent": "User's explicit task intent or goal",
  "keyDecisions": ["decision1", "decision2"],
  "constraints": ["constraint1", "constraint2"],
  "pendingQuestions": ["pending question1"],
  "riskPoints": ["risk point1"],
  "summary": "Concise overall summary (within 300 chars)"
}`)
    : (zh
      ? `请为以下对话生成一个结构化摘要（不超过800字）。

对话内容：
${messagesToSummarize}

请严格按以下JSON格式输出（不要输出其他内容）：
{
  "activeTopic": "当前讨论的核心主题（1-2句话）",
  "userIntent": "用户明确表达的任务意图或目标",
  "keyDecisions": ["用户决策1", "决策2"],
  "constraints": ["约束条件1", "条件2"],
  "pendingQuestions": ["待回答问题1"],
  "riskPoints": ["风险点1"],
  "summary": "整体对话的简洁摘要（300字以内）"
}`
      : `Generate a structured summary (max 800 chars) for the conversation below.

Conversation:
${messagesToSummarize}

Please output strictly in the following JSON format (no other content):
{
  "activeTopic": "Current core topic (1-2 sentences)",
  "userIntent": "User's explicit task intent or goal",
  "keyDecisions": ["decision1", "decision2"],
  "constraints": ["constraint1", "constraint2"],
  "pendingQuestions": ["pending question1"],
  "riskPoints": ["risk point1"],
  "summary": "Concise overall summary (within 300 chars)"
}`);

  try {
    const result = await invokeModelChat({
      app: params.app,
      subject: params.subject,
      locale: params.locale ?? "zh-CN",
      authorization: params.authorization ?? undefined,
      traceId: params.traceId ?? undefined,
      purpose: "orchestrator.summarize",
      messages: [
        { role: "system", content: zh ? "你是一个对话摘要助手。请提取对话中的关键信息生成简洁摘要。" : "You are a conversation summarizer. Extract key information and generate a concise summary." },
        { role: "user", content: prompt },
      ],
    });
    const summary = typeof result?.outputText === "string" ? result.outputText.trim().slice(0, 1500) : "";
    const { structured, summary: finalSummary } = parseStructuredSummary(summary || fallbackTruncate(dropped));
    
    // 提取 sessionState
    const sessionState = structured ? {
      activeTopic: structured.activeTopic,
      userIntent: structured.userIntent,
      entitiesInFocus: extractEntities(structured.activeTopic, structured.userIntent),
      constraints: Array.isArray(structured.constraints) ? structured.constraints : [],
      pendingQuestions: Array.isArray(structured.pendingQuestions) ? structured.pendingQuestions : [],
      riskPoints: Array.isArray(structured.riskPoints) ? structured.riskPoints : [],
      lastUpdatedAt: new Date().toISOString()
    } : undefined;
    
    return { summary: finalSummary || fallbackTruncate(dropped), sessionState };
  } catch {
    // LLM 调用失败时降级为简单截断
    return { summary: fallbackTruncate(dropped) };
  }
}

/** 降级方案：简单截断拼接 */
function fallbackTruncate(dropped: SessionMessage[]): string {
  if (!dropped.length) return "";
  const MAX = 1500;
  let total = 0;
  const lines: string[] = [];
  for (const m of dropped) {
    if (!m?.content) continue;
    const prefix = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统";
    const snippet = m.content.replace(/\s+/g, " ").trim().slice(0, 150);
    if (!snippet) continue;
    const line = `[${prefix}] ${snippet}${m.content.length > 150 ? "..." : ""}`;
    if (total + line.length > MAX) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

/** 导出的 fallbackTruncate 别名，供 dispatch/stream 路由在不阻塞 LLM 的情况下即时生成摘要 */
export { fallbackTruncate as fallbackTruncateSummary };

export async function orchestrateChatTurn(params: {
  app: FastifyInstance;
  pool: Pool;
  subject: LlmSubject;
  message: string;
  locale?: string;
  conversationId?: string | null;
  authorization?: string | null;
  traceId?: string | null;
  /** 是否持久化会话上下文（默认 true）。代理/协作/渠道等非对话场景应设为 false */
  persistSession?: boolean;
  /** 是否将模型错误向上传播（默认 false，保持 turn 200 + fallback 文案行为） */
  propagateModelErrors?: boolean;
  /** 用户指定的默认模型（可选） */
  defaultModelRef?: string;
  /** 多模态附件（图片 base64 data URL 等） */
  attachments?: Array<{ type: string; mimeType: string; name?: string; dataUrl: string }>;
}) {
  const locale = (params.locale ?? "zh-CN").trim() || "zh-CN";
  const msg = params.message.trim();
  if (!msg) throw Errors.badRequest("message 为空");

  // 从 DB 加载编排器规则（带 60s 缓存，DB 不可用时自动降级到 FALLBACK）
  const ruleCache = await loadOrchestratorRuleConfigs(params.pool, params.subject.tenantId);

  const conversationId = (params.conversationId ?? "").trim() || crypto.randomUUID();

  const spaceId = params.subject.spaceId ?? "";
  const historyLimit = conversationWindowSize();
  const nowIso = new Date().toISOString();
  const redactedMsg = redactValue(msg);
  const userContent = String(redactedMsg.value ?? "");

  const prev =
    spaceId
      ? await getSessionContext({ pool: params.pool, tenantId: params.subject.tenantId, spaceId, subjectId: params.subject.subjectId, sessionId: conversationId })
      : null;
  const prevMsgs = Array.isArray(prev?.context?.messages) ? prev!.context.messages : [];
  const droppedCount = Math.max(0, prevMsgs.length - (historyLimit - 2));
  const clippedPrev = prevMsgs.slice(droppedCount);
  const droppedMsgs = droppedCount > 0 ? prevMsgs.slice(0, droppedCount) : [];

  // 上下文管理：读取历史摘要 + 计算溢出
  const prevSummary = prev?.context?.summary ?? "";
  // 窗口溢出时使用 LLM 生成摘要
  let newSummary = prevSummary;
  let newSessionState: SessionState | undefined = prev?.context?.sessionState;
  if (droppedMsgs.length > 0) {
    try {
      const summaryResult = await summarizeDroppedMessages({
        app: params.app,
        subject: params.subject,
        dropped: droppedMsgs,
        prevSummary: prevSummary || undefined,
        locale,
        authorization: params.authorization,
        traceId: params.traceId,
      });
      newSummary = summaryResult.summary;
      newSessionState = summaryResult.sessionState;
    } catch {
      newSummary = prevSummary;
    }
  }
  // 累计总轮数
  const prevTotalTurns = prev?.context?.totalTurnCount ?? prevMsgs.length;
  const totalTurnCount = prevTotalTurns + 2; // +2 for new user + assistant

  params.app.log.info({
    traceId: params.traceId,
    conversationId,
    totalMessages: prevMsgs.length,
    droppedCount,
    windowSize: clippedPrev.length,
    historyLimit,
    totalTurnCount,
    hasDroppedSummary: !!newSummary,
    droppedSummaryLen: newSummary.length,
  }, "[context-debug] orchestrateChatTurn 对话上下文组装详情");

  /* ── 记忆召回 + 工具发现阶段（架构-08§7 + 架构-11§4.1）── */
  const auditContext = params.traceId ? { traceId: params.traceId } : undefined;
  const [taskRecall, toolDiscovery] = await Promise.all([
    spaceId
      ? recallRecentTasks({ pool: params.pool, tenantId: params.subject.tenantId, spaceId, subjectId: params.subject.subjectId, auditContext })
      : Promise.resolve({ text: "" }),
    spaceId
      ? discoverEnabledTools({ pool: params.pool, tenantId: params.subject.tenantId, spaceId, locale })
      : Promise.resolve({ catalog: "", tools: [] as EnabledTool[] }),
  ]);
  const taskContext = taskRecall.text;

  const modelMessages: { role: string; content: string | Array<{type: string; [k: string]: any}> }[] = [
    { role: "system", content: toolDiscovery.catalog
      ? buildSystemPrompt(locale, taskContext, toolDiscovery.catalog, {
          totalTurnCount,
          windowMessageCount: clippedPrev.length,
          summary: newSummary || undefined,
        })
      : buildLightChatPrompt(locale, {
          totalTurnCount,
          windowMessageCount: clippedPrev.length,
          summary: newSummary || undefined,
        }, toolDiscovery.tools, ruleCache)  // 传递实际的工具列表，让智能体动态感知能力
    },
    ...clippedPrev
      .filter((m: any) => m && typeof m === "object")
      .flatMap((m: any) => {
        const msg = { role: String(m.role ?? "user"), content: String(m.content ?? "") };
        if (m.toolContext && m.role === "assistant") {
          return [msg, { role: "system" as const, content: String(m.toolContext) }];
        }
        return [msg];
      })
      .filter((m: any) => m.content),
  ];

  // SessionState 槽位恢复：将结构化会话状态注入 LLM 上下文
  const sessionStateCtx = buildSessionStateContext(prev?.context?.sessionState);
  if (sessionStateCtx) {
    modelMessages.push({ role: "system", content: `## Session State\n${sessionStateCtx}` });
  }

  // 多模态附件处理：将图片附件融合到 user message 的 content 中（OpenAI Vision 格式）
  const imageAttachments = (params.attachments ?? []).filter(a => a.type === "image" && a.dataUrl);
  const docAttachments = (params.attachments ?? []).filter(a => a.type === "document");

  // 文档附件处理：提取文本内容拼入用户消息
  let augmentedUserContent = userContent;
  if (docAttachments.length > 0) {
    const docParts: string[] = [];
    for (const doc of docAttachments) {
      if ((doc as any).textContent) {
        docParts.push(`─── 文件: ${doc.name ?? "未命名"} ───\n${String((doc as any).textContent).slice(0, 100_000)}`);
      } else {
        docParts.push(`[用户上传了文件: ${doc.name ?? "未命名"} (${doc.mimeType})，当前不支持解析此格式，请提示用户使用文本格式文件]`);
      }
    }
    augmentedUserContent = (augmentedUserContent ? augmentedUserContent + "\n\n" : "") + docParts.join("\n\n");
  }

  if (imageAttachments.length > 0) {
    const contentParts: Array<{type: string; [k: string]: any}> = [];
    for (const att of imageAttachments) {
      contentParts.push({ type: "image_url", image_url: { url: att.dataUrl, detail: "auto" } });
    }
    if (augmentedUserContent) {
      contentParts.push({ type: "text", text: augmentedUserContent });
    }
    modelMessages.push({ role: "user", content: contentParts });
  } else {
    modelMessages.push({ role: "user", content: augmentedUserContent });
  }

  // ── 构建模型候选列表：defaultModelRef + DB路由策略fallback ──
  let fallbackCandidates: string[] = params.defaultModelRef ? [params.defaultModelRef] : [];
  if (params.defaultModelRef) {
    try {
      const routingPolicy = await getEffectiveRoutingPolicy({
        pool: params.pool,
        tenantId: params.subject.tenantId,
        purpose: "orchestrator.turn",
        spaceId: params.subject.spaceId ?? null,
      });
      if (routingPolicy?.enabled && Array.isArray(routingPolicy.fallbackModelRefs) && routingPolicy.fallbackModelRefs.length > 0) {
        // 去重：避免fallback列表中包含与defaultModelRef相同的模型
        const extras = routingPolicy.fallbackModelRefs.filter((ref: string) => ref !== params.defaultModelRef);
        fallbackCandidates = [params.defaultModelRef, ...extras];
        params.app.log.info({
          traceId: params.traceId,
          defaultModelRef: params.defaultModelRef,
          fallbackCount: extras.length,
          candidates: fallbackCandidates,
        }, "[orchestrator] 已合并DB路由策略fallback模型到候选列表");
      }
    } catch (fbErr: any) {
      // fallback查询失败不阻塞主流程，静默降级为单模型
      params.app.log.warn(
        { traceId: params.traceId, error: fbErr?.message },
        "[orchestrator] 查询路由策略fallback失败，降级为单模型候选",
      );
    }
  }

  let outputText = "";
  let modelError = false;
  let modelErrorDetail = "";
  let followUpText = "";
  let savedToolContext = "";
  try {
    const modelOut = await invokeModelChat({
      app: params.app,
      subject: params.subject,
      locale,
      authorization: params.authorization,
      traceId: params.traceId,
      purpose: "orchestrator.turn",
      messages: modelMessages,
      // 传递用户选择的默认模型 + DB路由策略中的fallback候选模型
      ...(params.defaultModelRef ? { constraints: { candidates: fallbackCandidates } } : {}),
    });
    outputText = typeof modelOut?.outputText === "string" ? modelOut.outputText : "";
  } catch (err: any) {
    if (params.propagateModelErrors && err && typeof err === "object" && (err.httpStatus === 429 || err.errorCode === "RATE_LIMITED")) throw err;
    outputText = "";
    modelError = true;
    const errMsg = err?.messageI18n ?? err?.message;
    if (errMsg && typeof errMsg === "object") {
      modelErrorDetail = String(errMsg[locale] ?? errMsg["zh-CN"] ?? Object.values(errMsg)[0] ?? "");
    } else if (typeof errMsg === "string") {
      modelErrorDetail = errMsg;
    }
    if (!modelErrorDetail && err?.errorCode) {
      modelErrorDetail = String(err.errorCode);
    }
  }

  let parsed = parseToolCallsFromOutput(outputText);
  let parsedReplyText = parsed.cleanText;
  let toolCalls = parsed.toolCalls;

  /* ── P0: tool_call 遗漏检测 + 强制校验与自动补全（修复首页对话工具调用遗漏缺陷）── */
  if (!modelError && toolCalls.length === 0 && toolDiscovery.tools.length > 0) {
    const toolNames = toolDiscovery.tools.map((t) => t.name);
    const mentionedTool = toolNames.find((name) => parsedReplyText.includes(name));
    
    // 场景 1：回复中提到了工具名称但未生成 tool_call → 强制重试
    if (mentionedTool) {
      params.app.log.warn({ 
        traceId: params.traceId, 
        mentionedTool, 
        replyTextLength: parsedReplyText.length 
      }, "[P0-ToolCall-Omission] 检测到工具提及但缺少 tool_call 代码块，触发强制重试");
      
      try {
        const retryOut = await invokeModelChat({
          app: params.app,
          subject: params.subject,
          locale,
          authorization: params.authorization,
          traceId: params.traceId,
          purpose: "orchestrator.turn.retry",
          messages: [
            ...modelMessages,
            { role: "assistant", content: outputText },
            { 
              role: "user", 
              content: `检测到您提到了工具 ${mentionedTool}，请补充完整的 \`\`\`tool_call\`\`\` 代码块。格式示例：\n\`\`\`tool_call\n[{"toolRef":"${mentionedTool}@v1","inputDraft":{...}}]\n\`\`\``
            },
          ],
        });
        const retryText = typeof retryOut?.outputText === "string" ? retryOut.outputText : "";
        const retryParsed = parseToolCallsFromOutput(retryText);
        if (retryParsed.toolCalls.length > 0) {
          toolCalls = retryParsed.toolCalls;
          params.app.log.info({ 
            traceId: params.traceId, 
            retryToolCount: retryParsed.toolCalls.length 
          }, "[P0-ToolCall-Omission] 重试成功，已补全 tool_call");
        }
      } catch (retryErr: any) {
        params.app.log.error({ err: retryErr, traceId: params.traceId }, "[P0-ToolCall-Omission] 重试失败");
      }
    }
    
    // 场景 2：回复包含行动意图但未生成 tool_call → 二次 LLM 校验
    else if ((ruleCache.actionIntentRescue ?? FALLBACK_ACTION_INTENT_REGEX).test(parsedReplyText)) {
      params.app.log.warn({ 
        traceId: params.traceId, 
        replyTextPreview: parsedReplyText.slice(0, 100) 
      }, "[P0-ToolCall-Omission] 检测到行动意图但缺少 tool_call 代码块，触发二次校验");
      
      try {
        const validationOut = await invokeModelChat({
          app: params.app,
          subject: params.subject,
          locale,
          authorization: params.authorization,
          traceId: params.traceId,
          purpose: "orchestrator.turn.validation",
          messages: [
            ...modelMessages,
            { role: "assistant", content: outputText },
            { 
              role: "user", 
              content: `请分析您的回复是否需要调用工具来完成任务？如果需要，请生成 \`\`\`tool_call\`\`\` 代码块。可用工具：${toolDiscovery.catalog}`
            },
          ],
        });
        const validationText = typeof validationOut?.outputText === "string" ? validationOut.outputText : "";
        const validationParsed = parseToolCallsFromOutput(validationText);
        if (validationParsed.toolCalls.length > 0) {
          toolCalls = validationParsed.toolCalls;
          params.app.log.info({ 
            traceId: params.traceId, 
            validationToolCount: validationParsed.toolCalls.length 
          }, "[P0-ToolCall-Omission] 二次校验成功，已添加工具调用");
        }
      } catch (validationErr: any) {
        params.app.log.error({ err: validationErr, traceId: params.traceId }, "[P0-ToolCall-Omission] 二次校验失败");
      }
    }
  }

  /* ━━━ 输入补全：为缺少 entityName 的 entity 工具调用自动推断 ━━━ */
  const enabledToolRefSet = new Set(toolDiscovery.tools.map((t) => t.toolRef));
  const enabledToolMap = new Map(toolDiscovery.tools.map((t) => [t.toolRef, t]));
  for (const tc of toolCalls) {
    const tool = enabledToolMap.get(tc.toolRef);
    if (!tool) continue;
    if (tool.def.resourceType !== "entity") continue;

    // 字段归一化：payload/data → patch
    if (tool.def.action === "update") {
      if (!tc.inputDraft.patch && (tc.inputDraft.payload || tc.inputDraft.data)) {
        tc.inputDraft.patch = tc.inputDraft.payload ?? tc.inputDraft.data;
        delete tc.inputDraft.payload;
        delete tc.inputDraft.data;
      }
    }

    // entityName 推断
    if (!tc.inputDraft.entityName && tc.inputDraft.id) {
      try {
        const { lookupEntityNameByRecordId } = await import("../../../modules/data/dataRepo");
        const inferred = await lookupEntityNameByRecordId({
          pool: params.pool,
          tenantId: params.subject.tenantId,
          spaceId: params.subject.spaceId,
          id: String(tc.inputDraft.id),
        });
        if (inferred) {
          tc.inputDraft.entityName = inferred;
          params.app.log.info(
            { traceId: params.traceId, toolRef: tc.toolRef, id: tc.inputDraft.id, entityName: inferred },
            "[orchestrator] 自动补全 entityName 成功",
          );
        }
      } catch (e: any) {
        params.app.log.warn(
          { traceId: params.traceId, toolRef: tc.toolRef, id: tc.inputDraft.id, error: e?.message },
          "[orchestrator] 自动补全 entityName 失败",
        );
      }
    }
  }

  /* ── 验证 tool_call：仅保留确实已启用的工具 ── */
  const validatedToolCalls = toolCalls.filter((tc) => enabledToolRefSet.has(tc.toolRef));

  /* ── 内联工具执行：分类 + 执行只读/安全写入工具 ── */
  const inlineWritableEntities = await loadInlineWritableEntities(params.pool);
  const resolution = await resolveExecutionClassFromSuggestions({
    toolCalls: validatedToolCalls,
    enabledTools: toolDiscovery.tools,
    inlineWritableEntities,
    dbCtx: { pool: params.pool, tenantId: params.subject.tenantId },
  });

  if (resolution.inlineTools.length > 0) {
    params.app.log.info(
      { traceId: params.traceId, inlineTools: resolution.inlineTools.map(t => t.toolRef) },
      "[orchestrator] 检测到可内联工具调用，执行内联查询",
    );
    const inlineResults = await executeInlineTools(resolution.inlineTools, {
      pool: params.pool,
      tenantId: params.subject.tenantId,
      spaceId: params.subject.spaceId ?? "",
      subjectId: params.subject.subjectId,
      enabledTools: toolDiscovery.tools,
      app: params.app,
      traceId: params.traceId,
    });
    const toolResultText = formatInlineResultsForLLM(inlineResults, locale);
    savedToolContext = toolResultText;

    // 二次 LLM 回复：基于工具结果生成自然语言
    const effectiveToolResultText = toolResultText || (locale !== "en-US"
      ? "## 工具执行结果\n工具已执行但未返回有效数据。\n"
      : "## Tool Execution Results\nTools executed but returned no valid data.\n");
    try {
      const followUpOut = await invokeModelChat({
        app: params.app,
        subject: params.subject,
        locale,
        authorization: params.authorization,
        traceId: params.traceId,
        purpose: "orchestrator.turn.inline_followup",
        messages: [
          ...modelMessages,
          { role: "assistant", content: outputText },
          { role: "user", content: effectiveToolResultText + (locale !== "en-US"
            ? "\n\n请基于上面的工具返回数据，直接向用户展示结果。用自然语言组织数据，不要提及工具调用过程。"
            : "\n\nBased on the tool results above, present the data to the user directly. Organize it in natural language.") },
        ],
      });
      followUpText = typeof followUpOut?.outputText === "string" ? followUpOut.outputText : "";
    } catch (followUpErr: any) {
      params.app.log.warn({ err: followUpErr, traceId: params.traceId }, "[orchestrator] 内联工具二次回复失败");
    }
  }

  const validatedSuggestions: Array<{
    toolRef: string;
    inputDraft: Record<string, unknown>;
    riskLevel: "low" | "medium" | "high";
    approvalRequired: boolean;
    idempotencyKey?: string;
  }> = [];
  for (const tc of resolution.workflowTools) {
    const tool = enabledToolMap.get(tc.toolRef);
    validatedSuggestions.push({
      toolRef: tc.toolRef,
      inputDraft: tc.inputDraft,
      riskLevel: tool?.def.riskLevel ?? "low",
      approvalRequired: tool?.def.approvalRequired ?? false,
      // scope=write 的工具需要 idempotencyKey，供前端手动执行时使用
      idempotencyKey: tool?.def.scope === "write" ? crypto.randomUUID() : undefined,
    });
  }

  const modelFallback = modelError
    ? (locale === "en-US"
        ? `I'm sorry, I couldn't process your request right now.${modelErrorDetail ? ` Reason: ${modelErrorDetail}` : " Please make sure a model binding is configured correctly in Settings > Model Onboarding."}`
        : `抱歉，当前无法处理您的请求。${modelErrorDetail ? `原因：${modelErrorDetail}` : "请确认已在【设置 > 模型接入】中正确配置模型绑定。"}`)
    : "";
  const replyText = parsedReplyText.trim() || modelFallback;

  if (params.persistSession !== false && spaceId) {
    function coerceRole(v: any): "user" | "assistant" | "system" {
      const r = String(v ?? "");
      if (r === "assistant" || r === "system" || r === "user") return r;
      return "user";
    }
    const assistantRedacted = redactValue(replyText);
    const assistantContent = String(assistantRedacted.value ?? "");
    const finalAssistantContent = followUpText || assistantContent;
    const assistantMsg: SessionMessage = {
      role: "assistant" as const,
      content: String(redactValue(finalAssistantContent).value ?? ""),
      at: nowIso,
      ...(savedToolContext ? { toolContext: savedToolContext } : {}),
    };
    const nextMsgs: SessionMessage[] = [
      ...clippedPrev.map((m) => ({ role: coerceRole(m.role), content: String(m.content ?? ""), at: typeof m.at === "string" ? m.at : undefined, ...(m.toolContext ? { toolContext: String(m.toolContext) } : {}) })).filter((m) => m.content),
      { role: "user", content: userContent, at: nowIso },
      assistantMsg,
    ];
    const trimmed = nextMsgs.slice(Math.max(0, nextMsgs.length - historyLimit));
    // 窗口再次溢出时，为新截断的消息更新摘要
    const persistDroppedCount = Math.max(0, nextMsgs.length - historyLimit);
    let persistSummary = newSummary;
    let persistSessionState = newSessionState;
    if (persistDroppedCount > 0) {
      try {
        const summaryResult = await summarizeDroppedMessages({
          app: params.app,
          subject: params.subject,
          dropped: nextMsgs.slice(0, persistDroppedCount),
          prevSummary: newSummary || undefined,
          locale,
          authorization: params.authorization,
          traceId: params.traceId,
        });
        persistSummary = summaryResult.summary;
        persistSessionState = summaryResult.sessionState;
      } catch {
        persistSummary = newSummary;
      }
    }
    const expiresAt = new Date(Date.now() + conversationTtlMs()).toISOString();
    await upsertSessionContext({
      pool: params.pool,
      tenantId: params.subject.tenantId,
      spaceId,
      subjectId: params.subject.subjectId,
      sessionId: conversationId,
      context: { v: 2, messages: trimmed, summary: persistSummary || undefined, sessionState: persistSessionState, totalTurnCount },
      expiresAt,
    });
  }

  const res: OrchestratorTurnResponse = {
    conversationId,
    replyText,
    ...(validatedSuggestions.length ? { toolSuggestions: validatedSuggestions } : {}),
  };
  return res;
}
