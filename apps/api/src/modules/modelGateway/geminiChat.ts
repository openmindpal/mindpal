import { Errors, type ModelUpstreamError, isModelUpstreamError } from "../../lib/errors";

export type GeminiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  | { type: "input_audio"; input_audio: { data: string; format?: string } }
  | { type: "video_url"; video_url: { url: string } };

export type GeminiChatMessage = {
  role: string;
  content: string | GeminiContentPart[];
};

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

const DEFAULT_API_VERSION_PATH = "/v1beta";

export async function geminiChatWithSecretRotation(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  requestPath?: string;
  model: string;
  messages: GeminiChatMessage[];
  apiKeys: string[];
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
}) {
  const apiKeys = params.apiKeys.map((k) => String(k)).filter(Boolean);
  if (!apiKeys.length) throw Errors.badRequest("缺少 apiKey");

  let lastErr: ModelUpstreamError | Error | null = null;
  const { url, systemInstruction } = buildGeminiRequestUrl({
    baseUrl: params.baseUrl,
    model: params.model,
    requestPath: params.requestPath,
    stream: false,
  });
  const contents = toGeminiContents(params.messages);
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i]!;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), params.timeoutMs);
    try {
      const res = await params.fetchFn(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
          generationConfig: {
            ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
            ...(typeof params.maxTokens === "number" ? { maxOutputTokens: params.maxTokens } : {}),
          },
        }),
        signal: ctrl.signal,
      });
      const json: any = await res.json().catch(() => null);
      if (!res.ok) {
        const upstreamMsg = json?.error?.message ?? json?.message ?? "";
        const detail = [`status=${res.status}`, upstreamMsg && `msg=${upstreamMsg}`].filter(Boolean).join(" ");
        const err = Errors.modelUpstreamFailed(detail);
        err.upstreamStatus = res.status;
        err.upstreamBody = json;
        throw err;
      }
      return {
        outputText: extractGeminiText(json),
        usage: normalizeGeminiUsage(json?.usageMetadata),
        secretTries: i + 1,
      };
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

export async function geminiChatStreamWithSecretRotation(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  requestPath?: string;
  model: string;
  messages: GeminiChatMessage[];
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
  const { url, systemInstruction } = buildGeminiRequestUrl({
    baseUrl: params.baseUrl,
    model: params.model,
    requestPath: params.requestPath,
    stream: true,
  });
  const contents = toGeminiContents(params.messages);

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
          "x-goog-api-key": apiKey,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
          generationConfig: {
            ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
            ...(typeof params.maxTokens === "number" ? { maxOutputTokens: params.maxTokens } : {}),
          },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const json: any = await res.json().catch(() => null);
        const upstreamMsg = json?.error?.message ?? json?.message ?? "";
        const detail = [`status=${res.status}`, upstreamMsg && `msg=${upstreamMsg}`].filter(Boolean).join(" ");
        const err = Errors.modelUpstreamFailed(detail);
        err.upstreamStatus = res.status;
        err.upstreamBody = json;
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
          const dataLines = extractDataLines(block);
          for (const data of dataLines) {
            if (!data) continue;
            let json: any = null;
            try {
              json = JSON.parse(data);
            } catch {
              continue;
            }
            const text = extractGeminiText(json);
            if (text) {
              sawAnyDelta = true;
              params.onDelta(text);
            }
            const usage = normalizeGeminiUsage(json?.usageMetadata);
            if (usage && params.onUsage) params.onUsage(usage);
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

function buildGeminiRequestUrl(params: {
  baseUrl: string;
  model: string;
  requestPath?: string;
  stream: boolean;
}) {
  const baseUrl = ensureGeminiVersionPrefix(String(params.baseUrl ?? "").replace(/\/+$/g, ""));
  const pathRaw = String(params.requestPath ?? "").trim();
  const action = params.stream ? "streamGenerateContent" : "generateContent";
  const defaultPath = `/models/${encodeURIComponent(params.model)}:${action}`;
  const path = pathRaw
    ? (pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`)
        .replace(":generateContent", `:${action}`)
        .replace(":streamGenerateContent", `:${action}`)
    : defaultPath;
  const suffix = params.stream && !path.includes("alt=sse") ? `${path.includes("?") ? "&" : "?"}alt=sse` : "";
  const fullPath = path.startsWith("/v1") ? path : `${DEFAULT_API_VERSION_PATH}${path}`;
  return {
    url: `${baseUrl}${fullPath}${suffix}`,
    systemInstruction: null as { parts: Array<{ text: string }> } | null,
  };
}

function ensureGeminiVersionPrefix(baseUrl: string) {
  if (!baseUrl) return "";
  if (/\/v1(beta)?$/i.test(baseUrl)) return baseUrl;
  return `${baseUrl}${DEFAULT_API_VERSION_PATH}`;
}

function toGeminiContents(messages: GeminiChatMessage[]) {
  const out: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const parts = toGeminiParts(message.content);
    if (!parts.length) continue;
    out.push({ role, parts });
  }
  return out;
}

function toGeminiParts(content: GeminiChatMessage["content"]): GeminiPart[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  return content.map((part) => {
    if (part.type === "text") return { text: part.text } as GeminiPart;
    if (part.type === "image_url") {
      const parsed = parseDataUrl(part.image_url.url, /^image\//i, "Gemini 图片输入仅支持 data URL");
      return { inlineData: { mimeType: parsed.mimeType, data: parsed.data } } as GeminiPart;
    }
    if (part.type === "input_audio") {
      const mimeType = normalizeAudioMimeType(part.input_audio.format);
      const data = String(part.input_audio.data ?? "").trim();
      if (!data) throw Errors.badRequest("音频输入缺少 data");
      return { inlineData: { mimeType, data } } as GeminiPart;
    }
    const parsed = parseDataUrl(part.video_url.url, /^video\//i, "Gemini 视频输入仅支持 data URL");
    return { inlineData: { mimeType: parsed.mimeType, data: parsed.data } } as GeminiPart;
  });
}

function parseDataUrl(url: string, mimePattern: RegExp, errorDetail: string) {
  const match = /^data:([a-zA-Z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(url ?? "").trim());
  if (!match || !mimePattern.test(match[1])) throw Errors.badRequest(errorDetail);
  return { mimeType: match[1], data: match[2] };
}

function normalizeAudioMimeType(format?: string) {
  const normalized = String(format ?? "wav").trim().toLowerCase();
  const mapping: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    webm: "audio/webm",
    flac: "audio/flac",
  };
  return mapping[normalized] ?? `audio/${normalized}`;
}

function extractGeminiText(json: any) {
  const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
  return candidates
    .flatMap((candidate: any) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function normalizeGeminiUsage(usage: any) {
  if (!usage || typeof usage !== "object") return { tokens: null };
  return {
    prompt_tokens: usage.promptTokenCount ?? null,
    completion_tokens: usage.candidatesTokenCount ?? null,
    total_tokens: usage.totalTokenCount ?? null,
  };
}

function parseSseBlocks(buffer: string) {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { blocks: parts, rest };
}

function extractDataLines(block: string) {
  const out: string[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("data:")) out.push(trimmed.slice(5).trimStart());
  }
  return out;
}

function coerceAbortError(e: any) {
  const name = String(e?.name ?? "");
  const msg = String(e?.message ?? "");
  return name === "AbortError" || msg.includes("AbortError");
}
