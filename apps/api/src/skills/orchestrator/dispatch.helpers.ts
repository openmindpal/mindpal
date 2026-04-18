/**
 * Dispatch Helpers
 *
 * 通用工具函数：i18n 文本取值、执行计划回复文本生成、tool_call 块过滤器
 */
import type { PlanningResult } from "../../kernel/planningKernel";

/* ------------------------------------------------------------------ */
/*  i18n 文本取值                                                      */
/* ------------------------------------------------------------------ */

export function i18nTextLocal(v: unknown, locale: string): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const obj = v as Record<string, string>;
    return String(obj[locale] ?? obj["zh-CN"] ?? Object.values(obj)[0] ?? "");
  }
  return String(v);
}

export function explainPlanningFailure(locale: string, failureCategory?: string | null): string {
  const zh = locale.startsWith("zh");
  switch (String(failureCategory ?? "").trim()) {
    case "no_tools":
    case "no_enabled_suggestion":
      return zh ? "当前环境里没有可直接执行这项请求的可用工具。" : "No available tool is enabled for this request in the current environment.";
    case "parse_error":
      return zh ? "系统暂时没能稳定解析出可执行步骤。" : "The system could not reliably parse executable steps just now.";
    case "empty":
      return zh ? "系统暂时没能为这个请求整理出明确的执行步骤。" : "The system could not derive a concrete execution plan for this request just now.";
    default:
      return zh ? "当前所需工具、权限或上下文还不完整。" : "The required tools, permissions, or context are still incomplete.";
  }
}

export function explainDispatchStreamError(locale: string, payloadMessage?: unknown): string | Record<string, string> {
  if (typeof payloadMessage === "string" && payloadMessage.trim()) return payloadMessage;
  if (payloadMessage && typeof payloadMessage === "object" && !Array.isArray(payloadMessage)) {
    const obj = payloadMessage as Record<string, unknown>;
    const zh = typeof obj["zh-CN"] === "string" ? obj["zh-CN"] : undefined;
    const en = typeof obj["en-US"] === "string" ? obj["en-US"] : undefined;
    if (zh || en) {
      return {
        "zh-CN": zh ?? en ?? "调度失败，请稍后重试。",
        "en-US": en ?? zh ?? "Dispatch failed. Please try again later.",
      };
    }
  }
  return locale.startsWith("zh")
    ? "调度失败，请稍后重试。若问题持续存在，请根据请求 ID 排查日志。"
    : "Dispatch failed. Please try again later. If the problem persists, inspect the logs with the request ID.";
}

/* ------------------------------------------------------------------ */
/*  执行计划感知的回复文本生成器                                         */
/*  替代 execute/collab 模式中对 orchestrateChatTurn 的独立LLM调用，   */
/*  确保回复文本反映实际执行计划而非LLM泛化回答                          */
/* ------------------------------------------------------------------ */

export function buildExecutionReplyText(params: {
  locale: string;
  userMessage: string;
  planResult: PlanningResult;
  phase: string;
  blockReason?: string;
}): string {
  const { locale, userMessage, planResult, phase, blockReason } = params;
  const zh = locale.startsWith("zh");
  const goal = userMessage.slice(0, 80);

  // 规划失败
  if (!planResult.ok || planResult.planSteps.length === 0) {
    const reason = blockReason?.trim() || explainPlanningFailure(locale, planResult.failureCategory);
    return zh
      ? `我先帮你梳理了一下这个请求：「${goal}」。不过当前还没能生成可执行计划。${reason}你可以补充更明确的目标，或者确认所需工具已启用后再试一次。`
      : `I started breaking down your request "${goal}", but I couldn't form an executable plan yet. ${reason} You can provide a bit more detail or enable the needed tools and try again.`;
  }

  // 从 enabledTools 构建 toolRef → 友好名称 映射
  const toolRefToName = new Map<string, string>();
  for (const t of planResult.enabledTools) {
    toolRefToName.set(t.toolRef, i18nTextLocal(t.def.displayName, locale) || t.name);
  }

  // 生成步骤描述
  const stepDescs = planResult.planSteps.map((s, i) => {
    const name = toolRefToName.get(s.toolRef) ?? s.toolRef.replace(/@\d+$/, "");
    const inputHints = Object.entries(s.inputDraft)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .slice(0, 3)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v)}`)
      .join(", ");
    return `${i + 1}. ${name}${inputHints ? ` (${inputHints})` : ""}`;
  });

  // 需要审批
  if (phase === "needs_approval") {
    const stepsText = stepDescs.join("\n");
    return zh
      ? `我已经开始处理「${goal}」，先整理出下面这些步骤：\n${stepsText}\n\n其中有步骤需要你审批，审批通过后我会继续往下执行。`
      : `I've started working on "${goal}" and prepared these steps:\n${stepsText}\n\nSome of them require your approval. Once approved, I'll continue the execution.`;
  }

  // 正常执行中
  const stepsText = stepDescs.join("\n");
  return zh
    ? `好，我来继续处理「${goal}」。我准备先这样推进：\n${stepsText}\n\n我会一边执行一边把新的进展同步给你。`
    : `Got it — I'm working on "${goal}". I'll start with this plan:\n${stepsText}\n\nI'll keep streaming progress back as I go.`;
}

/* ------------------------------------------------------------------ */
/*  tool_call 块过滤器                                                  */
/*  剥离 ```tool_call...``` 块，只向前端推送可见文本                      */
/* ------------------------------------------------------------------ */

export class ToolCallFilter {
  private readonly START_MARKER = "```tool_call";
  private readonly END_MARKER = "```";
  private mode: "text" | "tool" = "text";
  private buf = "";
  private readonly keepTail: number;
  private readonly keepEndTail: number;

  constructor(private readonly emit: (text: string) => void) {
    this.keepTail = this.START_MARKER.length - 1;
    this.keepEndTail = this.END_MARKER.length - 1;
  }

  feed(chunk: string): void {
    this.buf += chunk;
    while (this.buf) {
      if (this.mode === "text") {
        const idx = this.buf.indexOf(this.START_MARKER);
        if (idx === -1) {
          if (this.buf.length > this.keepTail) {
            const out = this.buf.slice(0, this.buf.length - this.keepTail);
            this.buf = this.buf.slice(this.buf.length - this.keepTail);
            if (out) this.emit(out);
          }
          return;
        }
        const out = this.buf.slice(0, idx);
        if (out) this.emit(out);
        this.buf = this.buf.slice(idx + this.START_MARKER.length);
        this.mode = "tool";
        continue;
      }
      const idx2 = this.buf.indexOf(this.END_MARKER);
      if (idx2 === -1) {
        if (this.buf.length > this.keepEndTail) this.buf = this.buf.slice(this.buf.length - this.keepEndTail);
        return;
      }
      this.buf = this.buf.slice(idx2 + this.END_MARKER.length);
      this.mode = "text";
    }
  }

  flush(): void {
    if (this.mode === "text" && this.buf) this.emit(this.buf);
    this.buf = "";
  }
}
