/**
 * 公共 LLM 调用工具函数。
 * 任何 skill 均可直接 import 使用，无需依赖编排器。
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AppError } from "./errors";
import { getOrCreateBreaker, type CircuitBreakerOptions, StructuredLogger } from "@mindpal/shared";
import { createDeltaIterable } from "./streamingPipeline";

const _logger = new StructuredLogger({ module: "llm" });

/** LLM 熔断器默认配置（按候选模型集/purpose 维度熔断） */
const LLM_BREAKER_DEFAULTS: Omit<CircuitBreakerOptions, "name"> = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 2,
  onStateChange: (e) => {
    _logger.warn("circuit-breaker state change", { name: e.name, from: e.from, to: e.to, failures: e.consecutiveFailures });
  },
};

export type LlmSubject = { tenantId: string; spaceId?: string; subjectId: string; roles?: string[] };

type ModelChatMessage = { role: string; content: string | Array<{type: string; [k: string]: any}> };
type ModelChatConstraints = { candidates?: string[] };
type ModelChatRequestParams = {
  subject: LlmSubject;
  locale: string;
  authorization?: string | null;
  traceId?: string | null;
  purpose: string;
  messages: ModelChatMessage[];
  timeoutMs?: number;
  headers?: Record<string, string>;
  constraints?: ModelChatConstraints;
};

function base64UrlEncode(buf: Buffer) {
  return buf.toString("base64url");
}

/**
 * 为内部 skill 间调用生成认证 header。
 * 统一优先使用 HMAC 签名（无论 AUTHN_MODE），仅当 HMAC secret 未配置且处于 dev 模式时回退到 dev token。
 */
export function makeInternalAuthHeader(subject: LlmSubject): string {
  // 统一优先使用 HMAC，不管当前 AUTHN_MODE 是什么
  const hmacSecret = String(process.env.AUTHN_HMAC_SECRET ?? "").trim();
  if (hmacSecret) {
    const exp = Math.floor(Date.now() / 1000) + 5 * 60;
    const payload = { tenantId: subject.tenantId, subjectId: subject.subjectId, spaceId: subject.spaceId ?? null, exp };
    const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
    const sig = crypto.createHmac("sha256", hmacSecret).update(payloadPart, "utf8").digest();
    const sigPart = base64UrlEncode(sig);
    return `Bearer ${payloadPart}.${sigPart}`;
  }

  const mode = process.env.AUTHN_MODE ?? "dev";
  if (mode === "dev") {
    // 回退：dev 模式且无 HMAC secret，生成 dev token（仅限本地开发）
        _logger.warn("HMAC secret not configured, falling back to dev token", { subjectId: subject.subjectId });
    const space = subject.spaceId ?? "space_dev";
    return `Bearer ${subject.subjectId}@${space}`;
  }

    _logger.error("Cannot construct internal auth header", { mode });
  return "";
}

export function buildModelChatInvocation(params: ModelChatRequestParams) {
  const auth = (params.authorization ?? "").trim() || makeInternalAuthHeader(params.subject);
  const headers = {
    authorization: auth,
    "content-type": "application/json",
    "x-user-locale": params.locale,
    ...(params.traceId ? { "x-trace-id": params.traceId } : {}),
    ...(params.headers ?? {}),
  };
  const payload = {
    purpose: params.purpose,
    messages: params.messages,
    timeoutMs: params.timeoutMs,
    ...(params.constraints ? { constraints: params.constraints } : {}),
  };
  return { auth, headers, payload };
}

function getLlmBreakerKey(params: Pick<ModelChatRequestParams, "purpose" | "constraints">) {
  const candidates = Array.isArray(params.constraints?.candidates)
    ? params.constraints.candidates.map((candidate) => String(candidate).trim()).filter(Boolean).sort()
    : [];
  const modelScope = candidates.length > 0 ? candidates.join(",") : "auto";
  return `llm:${modelScope}:${params.purpose}`;
}

/**
 * 调用模型网关 /models/chat，返回模型输出。
 * 这是最底层的 LLM 调用函数，各 skill 按需组合 prompt 后直接调用。
 */
export async function invokeModelChat(params: ModelChatRequestParams & {
  app: FastifyInstance;
}): Promise<{ outputText: string; [key: string]: unknown }> {
  const breakerKey = getLlmBreakerKey(params);
  const breaker = getOrCreateBreaker(breakerKey, LLM_BREAKER_DEFAULTS);

  const invocation = buildModelChatInvocation(params);
  const auth = invocation.auth;
  if (!auth) throw new AppError({ errorCode: "AUTH_UNAUTHORIZED", httpStatus: 401, message: { "zh-CN": "未认证", "en-US": "Unauthorized" } });

  return breaker.call(async () => {  const res = await params.app.inject({
    method: "POST",
    url: "/models/chat",
    headers: invocation.headers,
    payload: invocation.payload,
  });
  const body = res.body ? JSON.parse(res.body) : null;
  if (res.statusCode >= 200 && res.statusCode < 300) return body;
  const errorCode = typeof body?.errorCode === "string" ? body.errorCode : "MODEL_CHAT_FAILED";
  const message =
    body?.message && typeof body.message === "object"
      ? body.message
      : { "zh-CN": String(body?.message ?? "模型调用失败"), "en-US": String(body?.message ?? "Model invocation failed") };
  const appErr = new AppError({ errorCode, httpStatus: res.statusCode || 500, message });
  if (appErr.httpStatus === 429) {
    const retryAfterHeader = res.headers["retry-after"];
    const retryAfterSec = Number(body?.retryAfterSec ?? retryAfterHeader);
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) appErr.retryAfterSec = retryAfterSec;
  }
  throw appErr;
  }); // end breaker.call
}

/* ================================================================== */
/*  流式 LLM 调用（AsyncIterable 变体）                                  */
/* ================================================================== */

export interface ModelChatStreamResult {
  /** 逐 token 异步迭代器 */
  stream: AsyncIterable<string>;
  /** 等待流结束并获取最终结果（路由、usage、latency等） */
  result: Promise<{ outputText: string; [key: string]: unknown }>;
}

/**
 * 流式调用模型网关 /models/chat，返回 AsyncIterable<string>。
 *
 * 与 invokeModelChat 的区别：
 * - 逐 token 产出，适合实时 SSE 推送 / backpressure 控制
 * - 返回 stream + result Promise 双通道
 *
 * 用法：
 * ```ts
 * const { stream, result } = invokeModelChatStream({ ... });
 * for await (const chunk of stream) {
 *   connection.sendEvent("delta", { text: chunk });
 * }
 * const final = await result;
 * ```
 */
export function invokeModelChatStream(params: ModelChatRequestParams & {
  app: FastifyInstance;
  signal?: AbortSignal;
}): ModelChatStreamResult {
  const { iterable, onDelta, done } = createDeltaIterable();

  // 启动流式调用（后台）
  const resultPromise = (async () => {
    try {
      // 动态导入避免循环依赖
      const { invokeModelChatUpstreamStream } = await import(
        "../skills/model-gateway/modules/invokeChatUpstreamStream"
      );

      const invocation = buildModelChatInvocation(params);
      const auth = invocation.auth;
      if (!auth) {
        throw new AppError({
          errorCode: "AUTH_UNAUTHORIZED",
          httpStatus: 401,
          message: { "zh-CN": "未认证", "en-US": "Unauthorized" },
        });
      }

      const out = await invokeModelChatUpstreamStream({
        app: params.app,
        subject: params.subject,
        body: {
          stream: true,
          ...invocation.payload,
        },
        locale: params.locale,
        traceId: params.traceId,
        signal: params.signal,
        onDelta,
      });

      done();
      return out as { outputText: string; [key: string]: unknown };
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  })();

  return { stream: iterable, result: resultPromise };
}

/**
 * 解析模型输出中的 tool_call 块。
 * 约定格式：```tool_call\n[{"toolRef":"...","inputDraft":{...}}]\n```
 * 返回清理后的文本和解析出的工具调用列表。
 */
export function parseToolCallsFromOutput(text: string): {
  cleanText: string;
  toolCalls: Array<{ toolRef: string; inputDraft: Record<string, unknown> }>;
  parseErrorCount: number;
} {
  const toolCalls: Array<{ toolRef: string; inputDraft: Record<string, unknown> }> = [];
  let parseErrorCount = 0;

  /* ── Pass 1: Markdown ```tool_* ... ``` blocks (tool_call, tool_code, etc.) ── */
  const mdRegex = /```tool_\w+\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = mdRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (typeof item?.toolRef === "string" && item.toolRef.trim()) {
          toolCalls.push({
            toolRef: item.toolRef.trim(),
            inputDraft:
              item.inputDraft && typeof item.inputDraft === "object" && !Array.isArray(item.inputDraft)
                ? item.inputDraft
                : {},
          });
        }
      }
    } catch {
      parseErrorCount += 1;
    }
  }

  /* ── Pass 2 (fallback): XML <tool_*>...</tool_*> or <function_call> blocks ── */
  if (toolCalls.length === 0) {
    const xmlBlockRegex = /<(tool_\w+|function_call)[^>]*>([\s\S]*?)<\/\1>/gi;
    let xmlMatch: RegExpExecArray | null;
    while ((xmlMatch = xmlBlockRegex.exec(text)) !== null) {
      try {
        const body = xmlMatch[2];
        // Try XML-structured content first: extract tool name from <name>...</name>
        const nameMatch = body.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);

        if (nameMatch) {
          // ── XML parameter format ──
          const toolName = nameMatch[1].trim();
          if (!toolName) { parseErrorCount += 1; continue; }

          const inputDraft: Record<string, unknown> = {};
          const paramRegex = /<parameter[=\s]*([^>]*)>([\s\S]*?)<\/parameter>/gi;
          let pm: RegExpExecArray | null;
          while ((pm = paramRegex.exec(body)) !== null) {
            let key = pm[1].trim();
            let val: string = pm[2];

            if (key.startsWith("=")) key = key.slice(1).trim();
            const nameAttr = key.match(/name\s*=\s*["']?([\w.\-]+)["']?/i);
            if (nameAttr) key = nameAttr[1];

            if (!key && val.includes(">")) {
              const gt = val.indexOf(">");
              key = val.slice(0, gt).trim();
              val = val.slice(gt + 1).trim();
            }

            if (!key) { parseErrorCount += 1; continue; }

            let parsed: unknown = val;
            if (val.startsWith("{") || val.startsWith("[")) {
              try { parsed = JSON.parse(val); } catch { /* keep as string */ }
            }
            inputDraft[key] = parsed;
          }

          const normalised = normaliseInputDraft(inputDraft);
          const toolRef = toolName.includes("@") ? toolName : `${toolName}@1`;
          toolCalls.push({ toolRef, inputDraft: normalised });
        } else {
          // ── Python-style function call: entity.update(key="val", ...) ──
          const pyMatch = body.trim().match(/^([\w.]+)\s*\(([\s\S]*)\)\s*$/);
          if (pyMatch) {
            const toolName = pyMatch[1];
            const rawArgs = pyMatch[2].trim();
            const inputDraft = rawArgs ? parsePythonKwargs(rawArgs) : {};
            const normalised = normaliseInputDraft(inputDraft);
            const toolRef = toolName.includes("@") ? toolName : `${toolName}@1`;
            toolCalls.push({ toolRef, inputDraft: normalised });
          } else {
            // Try JSON fallback inside XML body
            try {
              const parsed = JSON.parse(body.trim());
              const arr = Array.isArray(parsed) ? parsed : [parsed];
              for (const item of arr) {
                if (typeof item?.toolRef === "string" && item.toolRef.trim()) {
                  toolCalls.push({
                    toolRef: item.toolRef.trim(),
                    inputDraft: item.inputDraft && typeof item.inputDraft === "object" && !Array.isArray(item.inputDraft) ? item.inputDraft : {},
                  });
                }
              }
            } catch {
              parseErrorCount += 1;
            }
          }
        }
      } catch {
        parseErrorCount += 1;
      }
    }
  }

  /* ── Clean output text: strip both markdown and XML tool_* blocks ── */
  const cleanText = text
    .replace(/\n?```tool_\w+\s*\n[\s\S]*?```\n?/g, "")
    .replace(/\n?<(?:tool_\w+|function_call)[^>]*>[\s\S]*?<\/(?:tool_\w+|function_call)>\n?/gi, "")
    .trim();
  return { cleanText, toolCalls, parseErrorCount };
}

/* ── Helper: normalise well-known field names for entity tools ── */
function normaliseInputDraft(inputDraft: Record<string, unknown>): Record<string, unknown> {
  const normalised: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputDraft)) {
    if (k === "type") normalised["entityName"] = v;
    else if (k === "entity_id" || k === "entityId") normalised["id"] = v;
    else if (k === "data" || k === "payload") {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        normalised["payload"] = v;
      } else {
        normalised[k] = v;
      }
    } else {
      normalised[k] = v;
    }
  }
  return normalised;
}

/* ── Helper: parse Python-style kwargs string into Record ── */
function parsePythonKwargs(argsStr: string): Record<string, unknown> {
  // Approach 1: convert to JSON and parse
  try {
    const jsonStr = "{" + argsStr.replace(/(\w+)\s*=/g, '"$1":') + "}";
    return JSON.parse(jsonStr);
  } catch { /* fall through */ }

  // Approach 2: regex extraction of key=value pairs
  const result: Record<string, unknown> = {};
  const kvRegex = /(\w+)\s*=\s*(?:"([^"]*?)"|'([^']*?)'|(\{[\s\S]*?\}|\[[\s\S]*?\])|([^,)\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = kvRegex.exec(argsStr)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
    if (typeof val === "string" && (val.startsWith("{") || val.startsWith("["))) {
      try { result[key] = JSON.parse(val); continue; } catch { /* keep as string */ }
    }
    result[key] = val;
  }
  return result;
}

/**
 * P0-6: tool_call 完整性检测
 *
 * 将模型输出中解析到的 tool_call 与已启用工具列表交叉校验，
 * 识别缺失（模型未引用但可能需要的）和无效（模型引用但不存在/未启用的）调用。
 *
 * 返回结构化诊断结果，供 planningKernel 记录审计和告知用户。
 */
export interface ToolCallIntegrityReport {
  /** 有效的 tool_call（已解析 + 工具已启用） */
  validCalls: Array<{ toolRef: string; inputDraft: Record<string, unknown> }>;
  /** 被丢弃的 tool_call（工具不存在/未启用/格式错误） */
  droppedCalls: Array<{ toolRef: string; reason: "not_found" | "not_enabled" | "invalid_format" }>;
  /** 解析错误数 */
  parseErrorCount: number;
  /** 是否存在潜在遗漏（模型文本中提及工具名但未生成 tool_call） */
  potentialMissing: string[];
  /** 完整性评分 0~1（validCalls / (validCalls + droppedCalls + potentialMissing)） */
  integrityScore: number;
}

export function checkToolCallIntegrity(
  modelOutput: string,
  enabledToolRefs: Set<string>,
): ToolCallIntegrityReport {
  const { toolCalls, parseErrorCount } = parseToolCallsFromOutput(modelOutput);

  const validCalls: ToolCallIntegrityReport["validCalls"] = [];
  const droppedCalls: ToolCallIntegrityReport["droppedCalls"] = [];

  for (const tc of toolCalls) {
    if (enabledToolRefs.has(tc.toolRef)) {
      validCalls.push(tc);
    } else {
      droppedCalls.push({ toolRef: tc.toolRef, reason: "not_enabled" });
    }
  }

  // 检测模型文本中提及工具名但未生成 tool_call 的情况
  const potentialMissing: string[] = [];
  const mentionRegex = /(?:调用|使用|执行|call|use|invoke|run)\s*["「]?([a-zA-Z][a-zA-Z0-9_.\-]+)["」]?/gi;
  let m: RegExpExecArray | null;
  const existingRefs = new Set(toolCalls.map((tc) => tc.toolRef));
  while ((m = mentionRegex.exec(modelOutput)) !== null) {
    const ref = m[1]!.trim();
    if (enabledToolRefs.has(ref) && !existingRefs.has(ref)) {
      potentialMissing.push(ref);
    }
  }

  const total = validCalls.length + droppedCalls.length + potentialMissing.length;
  const integrityScore = total > 0 ? validCalls.length / total : 1;

  return { validCalls, droppedCalls, parseErrorCount, potentialMissing, integrityScore };
}
