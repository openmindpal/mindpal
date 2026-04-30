// ─── skill-reflexion ── 自主反思引擎 ──────────────────────────────
// 分析任务执行轨迹，生成结构化反思与可操作策略。
// 支持 LLM 深度分析（需配置 SKILL_LLM_ENDPOINT）或本地规则分析（零依赖）。
//
// 输入: { goal, outcome, steps, totalDurationMs?, context?, requestStrategy?, synthesisMode? }
// 输出: { reflection, lesson, strategy?, confidence }

"use strict";

// ─── LLM 配置 ──────────────────────────────────────────────────────
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

// ─── LLM 反思 ──────────────────────────────────────────────────────
async function reflectWithLlm(cfg, goal, outcome, steps, totalDurationMs, context, opts) {
  const stepsDesc = (steps || [])
    .map((s, i) => {
      const dur = s.durationMs ? ` (${s.durationMs}ms)` : "";
      const err = s.error ? ` error: ${String(s.error).slice(0, 100)}` : "";
      return `  ${i + 1}. [${s.status || "?"}] ${s.toolRef || "unknown"}${dur}${err}`;
    })
    .join("\n");

  const isSynthesis = !!(opts && opts.synthesisMode);
  const wantStrategy = !!(opts && opts.requestStrategy);

  const roleDesc = isSynthesis
    ? "你是一个智能体策略综合专家。请综合分析以下多条策略发现，提炼出最核心的可操作改进建议。"
    : "你是一个智能体执行反思专家。请根据以下任务执行轨迹进行深度反思分析。";

  const prompt = `${roleDesc}

## 任务目标
${goal}

## 最终结果
${outcome}

## 执行步骤
${stepsDesc || "(无步骤记录)"}

## 总耗时
${totalDurationMs ? `${totalDurationMs}ms` : "未知"}
${context ? `\n## 额外上下文\n${context}` : ""}

请用 JSON 格式输出反思结果，包含以下字段：
{
  "whatWorked": "做对了什么（简要列出成功的决策和步骤）",
  "whatFailed": "做错了什么（简要列出失败的决策和步骤，如果全部成功则为空字符串）",
  "rootCause": "根本原因分析（如果有失败，分析根因；如果成功，分析关键成功因素）",
  "lessonsLearned": ["教训1", "教训2"],
  "improvementSuggestions": ["改进建议1", "改进建议2"],
  "lesson": "一句话教训摘要（不超过100字，可直接作为未来决策参考）",
  "strategy": "基于此次执行的可操作策略建议（不超过200字，描述下次遇到类似任务时应采取的具体步骤或注意事项）",
  "confidence": 0.85
}

只输出 JSON，不要有其他内容。`;

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
        temperature: 0.3,
        max_tokens: 1024,
      }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return null;

    // 提取 JSON（兼容 ```json ... ``` 包裹）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 本地规则分析（无 LLM 降级） ─────────────────────────────────
function reflectLocal(goal, outcome, steps, totalDurationMs, opts) {
  const totalSteps = (steps || []).length;
  const succeeded = (steps || []).filter((s) => s.status === "succeeded" || s.status === "completed").length;
  const failed = (steps || []).filter((s) => s.status === "failed" || s.status === "error").length;
  const timedOut = (steps || []).filter((s) => s.status === "timeout").length;

  const failedTools = (steps || [])
    .filter((s) => s.status === "failed" || s.status === "error")
    .map((s) => s.toolRef || "unknown");
  const slowest = (steps || [])
    .filter((s) => typeof s.durationMs === "number")
    .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))[0];

  const whatWorked = succeeded > 0
    ? `${succeeded}/${totalSteps} 步骤成功完成`
    : "无成功步骤";

  const whatFailed = failed > 0
    ? `${failed} 步骤失败: ${failedTools.join(", ")}`
    : timedOut > 0
      ? `${timedOut} 步骤超时`
      : "";

  const rootCause = failed > 0
    ? `工具调用失败 (${failedTools[0]})`
    : timedOut > 0
      ? "执行超时"
      : outcome === "succeeded"
        ? "任务顺利完成"
        : "未知原因";

  const lessonsLearned = [];
  const suggestions = [];

  if (failed > 0) {
    lessonsLearned.push(`工具 ${failedTools[0]} 不可靠，需要备选方案`);
    suggestions.push("为关键步骤添加重试或降级逻辑");
  }
  if (slowest && slowest.durationMs > 10000) {
    lessonsLearned.push(`${slowest.toolRef} 耗时 ${slowest.durationMs}ms，是性能瓶颈`);
    suggestions.push("考虑并行执行或缓存优化");
  }
  if (outcome === "succeeded" && totalSteps > 0) {
    lessonsLearned.push("当前工具链路有效");
  }
  if (totalSteps === 0) {
    lessonsLearned.push("无执行步骤记录，可能是规划阶段即失败");
    suggestions.push("增强任务分解能力");
  }

  const successRate = totalSteps > 0 ? succeeded / totalSteps : 0;

  const lesson = outcome === "succeeded"
    ? `任务"${(goal || "").slice(0, 30)}"成功，${succeeded}步完成，成功率${Math.round(successRate * 100)}%`
    : `任务"${(goal || "").slice(0, 30)}"${outcome}，失败点: ${failedTools[0] || "未知"}`;

  // 本地策略生成
  let strategy = "";
  if (opts && opts.requestStrategy) {
    const parts = [];
    if (failed > 0) {
      parts.push(`遇到类似任务时，优先检查工具 ${failedTools[0]} 的可用性，准备备选工具链路`);
    }
    if (slowest && slowest.durationMs > 10000) {
      parts.push(`对 ${slowest.toolRef} 设置超时保护（建议 ${Math.round(slowest.durationMs * 1.5)}ms），并行化前置无依赖步骤`);
    }
    if (totalSteps > 8) {
      parts.push(`将复杂目标拆分为 3-5 个子目标（当前 ${totalSteps} 步效率偏低），使用 GoalGraph 结构化分解`);
    }
    if (outcome === "succeeded" && totalSteps > 0 && totalSteps <= 8) {
      parts.push(`当前工具链路有效（${succeeded}/${totalSteps} 成功），可作为同类任务的参考执行路径`);
    }
    if (parts.length === 0 && totalSteps > 0) {
      const toolChain = [...new Set(steps.map(s => s.toolRef).filter(Boolean))];
      if (toolChain.length > 0) {
        parts.push(
          `工具链路[${toolChain.slice(0, 3).join(",")}]在此类任务中表现良好` +
          `（${succeeded}/${totalSteps}成功，耗时${Math.round((totalDurationMs || 0) / 1000)}s），可作为同类任务首选方案`
        );
      }
    }
    strategy = parts.length > 0 ? parts.join("；") : lesson;
  }

  const baseConf = outcome === 'succeeded' ? 0.7 : failed > 0 ? 0.65 : 0.5;
  const successBonus = totalSteps > 0 ? (succeeded / totalSteps) * 0.15 : 0;

  return {
    reflection: {
      whatWorked,
      whatFailed,
      rootCause,
      lessonsLearned,
      improvementSuggestions: suggestions,
    },
    lesson: lesson.slice(0, 200),
    strategy: strategy.slice(0, 400),
    confidence: Math.min(0.9, baseConf + successBonus),
  };
}

// ─── 主入口 ────────────────────────────────────────────────────────
exports.execute = async function execute(req) {
  const input = req?.input ?? {};
  const goal = String(input.goal ?? "");
  const outcome = String(input.outcome ?? "unknown");
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const totalDurationMs = typeof input.totalDurationMs === "number" ? input.totalDurationMs : null;
  const context = input.context ? String(input.context) : null;

  if (!goal) {
    return {
      reflection: { whatWorked: "", whatFailed: "未提供任务目标", rootCause: "输入不完整", lessonsLearned: [], improvementSuggestions: ["确保提供任务目标"] },
      lesson: "反思需要明确的任务目标",
      confidence: 0.1,
    };
  }

  const wantStrategy = !!input.requestStrategy;
  const synthesisMode = !!input.synthesisMode;

  // 尝试 LLM 深度分析
  const llmCfg = resolveLlmConfig();
  if (llmCfg) {
    const llmResult = await reflectWithLlm(llmCfg, goal, outcome, steps, totalDurationMs, context, { requestStrategy: wantStrategy, synthesisMode });
    if (llmResult) {
      return {
        reflection: {
          whatWorked: String(llmResult.whatWorked ?? ""),
          whatFailed: String(llmResult.whatFailed ?? ""),
          rootCause: String(llmResult.rootCause ?? ""),
          lessonsLearned: Array.isArray(llmResult.lessonsLearned) ? llmResult.lessonsLearned.map(String) : [],
          improvementSuggestions: Array.isArray(llmResult.improvementSuggestions) ? llmResult.improvementSuggestions.map(String) : [],
        },
        lesson: String(llmResult.lesson ?? "").slice(0, 200),
        strategy: String(llmResult.strategy ?? llmResult.lesson ?? "").slice(0, 400),
        confidence: typeof llmResult.confidence === "number" ? Math.max(0, Math.min(1, llmResult.confidence)) : 0.8,
      };
    }
  }

  // LLM 不可用或失败 → 本地规则分析
  return reflectLocal(goal, outcome, steps, totalDurationMs, { requestStrategy: wantStrategy });
};
