// ─── skill-tool-discovery ── 工具自发现/自组合 ──────────────────────
// 根据目标语义匹配可用工具，推荐最相关工具并生成执行计划。
// 支持 LLM 深度推荐（需配置 SKILL_LLM_ENDPOINT）或本地语义匹配（零依赖）。
//
// 输入: { goal, availableTools, maxRecommendations? }
// 输出: { recommended, suggestedPlan }

"use strict";

// ─── 文本处理工具 ──────────────────────────────────────────────────
function tokenize(text) {
  const t = String(text ?? "").toLowerCase();
  const tokens = [];
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      tokens.push(t[i]);
      continue;
    }
    if ((code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) {
      let j = i + 1;
      while (j < t.length) {
        const c2 = t.charCodeAt(j);
        if ((c2 >= 0x61 && c2 <= 0x7a) || (c2 >= 0x30 && c2 <= 0x39)) j++;
        else break;
      }
      tokens.push(t.slice(i, j));
      i = j - 1;
    }
  }
  return tokens;
}

// ─── 语义相关性计算 ────────────────────────────────────────────────
function computeRelevance(goalTokens, toolName, toolDescription) {
  const nameTokens = tokenize(toolName);
  const descTokens = tokenize(toolDescription);
  const toolTokenSet = new Set([...nameTokens, ...descTokens]);

  if (goalTokens.length === 0 || toolTokenSet.size === 0) return 0;

  // 计算 Jaccard 相似度
  let intersection = 0;
  const goalTokenSet = new Set(goalTokens);
  for (const t of goalTokenSet) {
    if (toolTokenSet.has(t)) intersection++;
  }
  const union = new Set([...goalTokenSet, ...toolTokenSet]).size;
  const jaccard = union > 0 ? intersection / union : 0;

  // 工具名称中的关键词匹配（权重更高）
  let nameBonus = 0;
  for (const t of goalTokenSet) {
    if (nameTokens.includes(t)) nameBonus += 0.15;
  }

  // 语义映射表：常见意图 → 工具类型关联
  const semanticMap = {
    // 数据操作
    "创建": ["create", "write", "insert", "add", "new"],
    "create": ["create", "write", "insert", "add"],
    "删除": ["delete", "remove", "clear"],
    "delete": ["delete", "remove", "clear"],
    "查询": ["read", "search", "query", "list", "get", "find"],
    "search": ["read", "search", "query", "list", "find"],
    "更新": ["update", "write", "modify", "edit", "patch"],
    "update": ["update", "write", "modify", "edit"],
    // 通信
    "发送": ["send", "notify", "push", "outbox", "mail"],
    "send": ["send", "notify", "push", "outbox"],
    "通知": ["notify", "notification", "outbox", "alert"],
    "notify": ["notify", "notification", "outbox"],
    // 知识
    "搜索": ["search", "knowledge", "rag", "find", "query"],
    "知识": ["knowledge", "rag", "search", "memory"],
    "knowledge": ["knowledge", "rag", "search"],
    // 记忆
    "记住": ["memory", "write", "remember", "save"],
    "记忆": ["memory", "recall", "remember"],
    "memory": ["memory", "recall", "remember"],
    // 分析
    "分析": ["analyze", "analytics", "reasoning", "evaluate"],
    "analyze": ["analyze", "analytics", "reasoning"],
    // 自动化
    "自动": ["automation", "trigger", "schedule", "workflow"],
    "automation": ["automation", "browser", "desktop"],
    // 协作
    "协作": ["collab", "collaboration", "team"],
    "collab": ["collab", "collaboration"],
  };

  let semanticBonus = 0;
  const toolText = (toolName + " " + toolDescription).toLowerCase();
  for (const goalToken of goalTokenSet) {
    const related = semanticMap[goalToken];
    if (related) {
      for (const r of related) {
        if (toolText.includes(r)) {
          semanticBonus += 0.1;
          break;
        }
      }
    }
  }

  return Math.min(1, jaccard * 2 + nameBonus + semanticBonus);
}

// ─── 生成推荐理由 ──────────────────────────────────────────────────
function generateReason(goalTokens, toolName, toolDescription, relevance) {
  const nameTokens = tokenize(toolName);
  const descTokens = tokenize(toolDescription);
  const goalTokenSet = new Set(goalTokens);

  const matchedKeywords = [];
  for (const t of goalTokenSet) {
    if (nameTokens.includes(t) || descTokens.includes(t)) {
      matchedKeywords.push(t);
    }
  }

  if (matchedKeywords.length > 0) {
    return `关键词匹配: ${matchedKeywords.slice(0, 3).join(", ")}`;
  }
  if (relevance > 0.3) return "语义关联度高";
  if (relevance > 0.1) return "可能相关";
  return "弱关联";
}

// ─── LLM 深度推荐 ─────────────────────────────────────────────────
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

async function discoverWithLlm(cfg, goal, tools, maxRecommendations) {
  const toolsDesc = tools
    .map((t, i) => `${i + 1}. ${t.name} — ${extractDescription(t.description)} [scope:${t.scope}, action:${t.action}]`)
    .join("\n");

  const prompt = `你是一个工具推荐专家。根据用户目标，从可用工具列表中推荐最合适的工具并生成执行计划。

## 用户目标
${goal}

## 可用工具列表
${toolsDesc}

请用 JSON 格式输出，包含：
{
  "recommended": [
    { "name": "工具名", "relevance": 0.9, "reason": "推荐理由" }
  ],
  "suggestedPlan": [
    { "step": 1, "toolName": "工具名", "description": "这一步做什么" }
  ]
}

要求：
- recommended 最多 ${maxRecommendations} 个，按相关度降序排列
- suggestedPlan 是实际可执行的步骤序列
- 如果没有合适的工具，recommended 返回空数组
- 只输出 JSON`;

  const headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;

  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), cfg.timeoutMs) : null;

  try {
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 1024,
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────────────
function extractDescription(desc) {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  // 多语言描述对象
  return String(desc["zh-CN"] || desc["en-US"] || Object.values(desc)[0] || "");
}

// ─── 主入口 ────────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  const input = req?.input ?? {};
  const goal = String(input.goal ?? "");
  const tools = Array.isArray(input.availableTools) ? input.availableTools : [];
  const maxRecommendations = Math.max(1, Math.min(20, Number(input.maxRecommendations) || 5));

  if (!goal || tools.length === 0) {
    return { recommended: [], suggestedPlan: [] };
  }

  // 尝试 LLM 深度推荐
  const llmCfg = resolveLlmConfig();
  if (llmCfg) {
    const llmResult = await discoverWithLlm(llmCfg, goal, tools, maxRecommendations);
    if (llmResult && Array.isArray(llmResult.recommended)) {
      return {
        recommended: llmResult.recommended.slice(0, maxRecommendations).map((r) => ({
          name: String(r.name ?? ""),
          relevance: typeof r.relevance === "number" ? Math.max(0, Math.min(1, r.relevance)) : 0.5,
          reason: String(r.reason ?? ""),
          scope: tools.find((t) => t.name === r.name)?.scope ?? "read",
        })),
        suggestedPlan: Array.isArray(llmResult.suggestedPlan)
          ? llmResult.suggestedPlan.map((s, i) => ({
              step: typeof s.step === "number" ? s.step : i + 1,
              toolName: String(s.toolName ?? ""),
              description: String(s.description ?? ""),
            }))
          : [],
      };
    }
  }

  // LLM 不可用 → 本地语义匹配
  const goalTokens = tokenize(goal);

  const scored = tools
    .map((t) => {
      const name = String(t.name ?? "");
      const desc = extractDescription(t.description);
      const relevance = computeRelevance(goalTokens, name, desc);
      return {
        name,
        relevance: Math.round(relevance * 1000) / 1000,
        reason: generateReason(goalTokens, name, desc, relevance),
        scope: t.scope ?? "read",
      };
    })
    .filter((t) => t.relevance > 0.05)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxRecommendations);

  // 简单执行计划：按相关度排序作为步骤
  const suggestedPlan = scored
    .filter((t) => t.relevance > 0.15)
    .map((t, i) => ({
      step: i + 1,
      toolName: t.name,
      description: `使用 ${t.name} (${t.reason})`,
    }));

  return { recommended: scored, suggestedPlan };
};
