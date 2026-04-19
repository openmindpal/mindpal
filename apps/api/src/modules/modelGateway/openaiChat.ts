import { Errors, type ModelUpstreamError, isModelUpstreamError } from "../../lib/errors";

export type OpenAiChatMessage = { role: string; content: string };

export async function openAiChatWithSecretRotation(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  model: string;
  messages: OpenAiChatMessage[];
  apiKeys: string[];
  timeoutMs: number;
}) {
  const apiKeys = params.apiKeys.map((k) => String(k)).filter(Boolean);
  if (!apiKeys.length) throw Errors.badRequest("缺少 apiKey");

  let lastErr: ModelUpstreamError | Error | null = null;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i]!;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), params.timeoutMs);
    try {
      const res = await params.fetchFn(`${params.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: ctrl.signal,
      });

      const json: any = await res.json().catch(() => null);
      if (!res.ok) {
        const err = Errors.modelUpstreamFailed(`status=${res.status}`);
        err.upstreamStatus = res.status;
        throw err;
      }

      const content = json?.choices?.[0]?.message?.content;
      const outputText = typeof content === "string" ? content : content != null ? String(content) : "";
      const usage = json?.usage && typeof json.usage === "object" ? json.usage : { tokens: null };
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

