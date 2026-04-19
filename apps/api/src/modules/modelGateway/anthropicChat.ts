/**
 * Anthropic Messages API adapter.
 *
 * 实现位于 modules/ 层（原属 skills/model-gateway，为修复边界违规而迁入）。
 * skills 侧通过 re-export 消费（skills → modules 合规）。
 *
 * Anthropic uses a different protocol from OpenAI:
 *   - Auth: `x-api-key` header (not Bearer token)
 *   - Request: { model, messages, max_tokens, system?, temperature? }
 *     - `system` is a top-level field, NOT a message with role "system"
 *   - Response: { content[{type:"text", text:"..."}], usage:{input_tokens, output_tokens} }
 *   - Streaming: SSE with event types: message_start, content_block_start,
 *     content_block_delta, message_delta, message_stop
 */

import { Errors, type ModelUpstreamError, isModelUpstreamError } from "../../lib/errors";

export type AnthropicContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  | { type: "input_audio"; input_audio: { data: string; format?: string } }
  | { type: "video_url"; video_url: { url: string } };

export type AnthropicChatMessage = {
  role: string;
  content: string | AnthropicContentPart[];
};

type AnthropicApiContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
    };

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MESSAGES_PATH = "/v1/messages";
const DEFAULT_MAX_TOKENS = 4096;

// ─── Non-streaming ─────────────────────────────────────────────

export async function anthropicChatWithSecretRotation(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  messagesPath?: string;
  model: string;
  messages: AnthropicChatMessage[];
  apiKeys: string[];
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
}) {
  const apiKeys = params.apiKeys.map((k) => String(k)).filter(Boolean);
  if (!apiKeys.length) throw Errors.badRequest("缺少 apiKey");

  let lastErr: ModelUpstreamError | Error | null = null;
  const baseUrl = String(params.baseUrl ?? "").replace(/\/+$/g, "");
  const pathRaw = String(params.messagesPath ?? "").trim() || DEFAULT_MESSAGES_PATH;
  const path = pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`;
  const url = `${baseUrl}${path}`;

  const { systemPrompt, userMessages } = extractSystemMessage(params.messages);

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i]!;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), params.timeoutMs);
    try {
      const res = await params.fetchFn(url, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: params.model,
          max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          messages: userMessages.map((m) => ({ role: m.role, content: toAnthropicMessageContent(m.content) })),
          ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
        }),
        signal: ctrl.signal,
      });

      const json: any = await res.json().catch(() => null);
      if (!res.ok) {
        const err = Errors.modelUpstreamFailed(`status=${res.status}`);
        err.upstreamStatus = res.status;
        err.upstreamBody = json;
        throw err;
      }

      const outputText = extractTextFromAnthropicResponse(json);
      const usage = normalizeAnthropicUsage(json?.usage);
      return { outputText, usage, secretTries: i + 1 };
    } catch (e: any) {
      const isAbort = String(e?.name ?? "") === "AbortError";
      if (isAbort) {
        const timeoutErr = Errors.modelUpstreamFailed("timeout");
        timeoutErr.upstreamTimeout = true;
        lastErr = timeoutErr;
      } else {
        lastErr = e;
      }
      const retryable = Boolean(
        isModelUpstreamError(lastErr) &&
          (lastErr.upstreamStatus === 429 || Boolean(lastErr.upstreamTimeout)),
      );
      if (retryable && i < apiKeys.length - 1) continue;
      throw lastErr;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr ?? Errors.modelUpstreamFailed("unknown");
}

// ─── Streaming ────────────────────────────────────────────────

export async function anthropicChatStreamWithSecretRotation(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  messagesPath?: string;
  model: string;
  messages: AnthropicChatMessage[];
  apiKeys: string[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onUsage?: (usage: any) => void;
}) {
  const apiKeys = params.apiKeys.map((k) => String(k)).filter(Boolean);
  if (!apiKeys.length) throw Errors.badRequest("缺少 apiKey");

  let lastErr: ModelUpstreamError | Error | null = null;
  const baseUrl = String(params.baseUrl ?? "").replace(/\/+$/g, "");
  const pathRaw = String(params.messagesPath ?? "").trim() || DEFAULT_MESSAGES_PATH;
  const path = pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`;
  const url = `${baseUrl}${path}`;

  const { systemPrompt, userMessages } = extractSystemMessage(params.messages);

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i]!;
    const ctrl = new AbortController();
    const abortByOuter = () => ctrl.abort();
    if (params.signal) {
      if (params.signal.aborted) ctrl.abort();
      else params.signal.addEventListener("abort", abortByOuter, { once: true });
    }

    let sawAnyDelta = false;
    try {
      const res = await params.fetchFn(url, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: params.model,
          max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
          stream: true,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          messages: userMessages.map((m) => ({ role: m.role, content: toAnthropicMessageContent(m.content) })),
          ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const err = Errors.modelUpstreamFailed(`status=${res.status}`);
        err.upstreamStatus = res.status;
        throw err;
      }
      if (!res.body || typeof (res.body as any).getReader !== "function") {
        const err = Errors.modelUpstreamFailed("missing_body");
        err.upstreamStatus = 502;
        throw err;
      }

      const reader = (res.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.rest;
        for (const block of parsed.blocks) {
          const { eventType, data } = extractEventData(block);

          if (eventType === "message_stop") {
            return { secretTries: i + 1 };
          }

          if (!data) continue;
          let json: any = null;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }

          if (eventType === "content_block_delta" || json?.type === "content_block_delta") {
            const text = json?.delta?.text;
            if (typeof text === "string" && text.length) {
              sawAnyDelta = true;
              params.onDelta(text);
            }
          }

          if (eventType === "message_delta" || json?.type === "message_delta") {
            const usage = json?.usage;
            if (usage && typeof usage === "object" && params.onUsage) {
              params.onUsage(normalizeAnthropicUsage(usage));
            }
          }

          if (eventType === "message_start" || json?.type === "message_start") {
            const usage = json?.message?.usage;
            if (usage && typeof usage === "object" && params.onUsage) {
              params.onUsage(normalizeAnthropicUsage(usage));
            }
          }
        }
      }
      return { secretTries: i + 1 };
    } catch (e: any) {
      const isAbort = coerceAbortError(e);
      if (isAbort) {
        lastErr = Errors.modelUpstreamFailed("用户取消请求");
      } else {
        lastErr = e;
      }
      const retryable = Boolean(
        !sawAnyDelta &&
          isModelUpstreamError(lastErr) &&
          lastErr.upstreamStatus === 429,
      );
      if (retryable && i < apiKeys.length - 1) continue;
      throw lastErr;
    } finally {
      if (params.signal) params.signal.removeEventListener("abort", abortByOuter as EventListener);
    }
  }
  throw lastErr ?? Errors.modelUpstreamFailed("unknown");
}

// ─── Helpers ─────────────────────────────────────────────────

function extractSystemMessage(messages: AnthropicChatMessage[]): {
  systemPrompt: string | null;
  userMessages: AnthropicChatMessage[];
} {
  const systemParts: string[] = [];
  const userMessages: AnthropicChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text = extractTextContent(m.content);
      if (text) systemParts.push(text);
    } else {
      userMessages.push(m);
    }
  }
  return {
    systemPrompt: systemParts.length ? systemParts.join("\n\n") : null,
    userMessages,
  };
}

function extractTextFromAnthropicResponse(json: any): string {
  if (!json || !Array.isArray(json.content)) return "";
  return json.content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => String(b.text ?? ""))
    .join("");
}

function extractTextContent(content: AnthropicChatMessage["content"]) {
  if (typeof content === "string") return content.trim();
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function toAnthropicMessageContent(content: AnthropicChatMessage["content"]): string | AnthropicApiContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text } as AnthropicApiContentBlock;
    }
    if (part.type !== "image_url") {
      throw Errors.badRequest("Anthropic 当前仅支持 text/image 输入");
    }
    const parsed = parseImageDataUrl(part.image_url.url);
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: parsed.mediaType,
        data: parsed.data,
      },
    } as AnthropicApiContentBlock;
  });
}

function parseImageDataUrl(url: string) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(url ?? "").trim());
  if (!match) {
    throw Errors.badRequest("Anthropic 图片输入仅支持 data URL");
  }
  return { mediaType: match[1], data: match[2] };
}

function normalizeAnthropicUsage(usage: any): Record<string, any> {
  if (!usage || typeof usage !== "object") return { tokens: null };
  return {
    prompt_tokens: usage.input_tokens ?? null,
    completion_tokens: usage.output_tokens ?? null,
    total_tokens:
      typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
        ? usage.input_tokens + usage.output_tokens
        : null,
  };
}

function parseSseBlocks(buffer: string) {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { blocks: parts, rest };
}

function extractEventData(block: string): { eventType: string | null; data: string | null } {
  let eventType: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("event:")) {
      eventType = trimmed.slice(6).trim();
    } else if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
  }
  return { eventType, data: dataLines.length ? dataLines.join("\n") : null };
}

function coerceAbortError(e: any) {
  const name = String(e?.name ?? "");
  const msg = String(e?.message ?? "");
  return name === "AbortError" || msg.includes("AbortError");
}
