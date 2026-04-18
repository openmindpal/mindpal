import { Errors } from "../../../lib/errors";
import { isNativeProtocolProvider, isOpenAiCompatibleProvider } from "./catalog";
import { anthropicChatStreamWithSecretRotation, anthropicChatWithSecretRotation } from "./anthropicChat";
import { geminiChatStreamWithSecretRotation, geminiChatWithSecretRotation } from "./geminiChat";
import { openAiChatStreamWithSecretRotation, openAiChatWithSecretRotation } from "./openaiChat";

export type ProviderChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  | { type: "input_audio"; input_audio: { data: string; format?: string } }
  | { type: "video_url"; video_url: { url: string } };

export type ProviderChatMessage = {
  role: string;
  content: string | ProviderChatContentPart[];
};

type CommonInvokeParams = {
  provider: string;
  fetchFn: typeof fetch;
  baseUrl: string;
  requestPath?: string | null;
  model: string;
  messages: ProviderChatMessage[];
  apiKeys: string[];
  temperature?: number;
  maxTokens?: number;
};

type NonStreamInvokeParams = CommonInvokeParams & {
  timeoutMs: number;
};

type StreamInvokeParams = CommonInvokeParams & {
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onUsage?: (usage: any) => void;
};

export function getProviderProtocolFamily(provider: string) {
  if (provider === "openai" || provider === "mock" || isOpenAiCompatibleProvider(provider)) return "openai";
  if (provider === "anthropic" || provider === "custom_anthropic") return "anthropic";
  if (provider === "gemini" || provider === "custom_gemini") return "gemini";
  if (isNativeProtocolProvider(provider)) return "native";
  return "unknown";
}

export async function invokeProviderChatWithSecretRotation(params: NonStreamInvokeParams) {
  const family = getProviderProtocolFamily(params.provider);
  if (family === "openai") {
    return openAiChatWithSecretRotation({
      fetchFn: params.fetchFn,
      baseUrl: params.baseUrl,
      chatCompletionsPath: params.requestPath ?? "/chat/completions",
      model: params.model,
      messages: params.messages as any,
      apiKeys: params.apiKeys,
      timeoutMs: params.timeoutMs,
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
    });
  }
  if (family === "anthropic") {
    return anthropicChatWithSecretRotation({
      fetchFn: params.fetchFn,
      baseUrl: params.baseUrl,
      messagesPath: params.requestPath ?? "/v1/messages",
      model: params.model,
      messages: params.messages as any,
      apiKeys: params.apiKeys,
      timeoutMs: params.timeoutMs,
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
    });
  }
  if (family === "gemini") {
    return geminiChatWithSecretRotation({
      fetchFn: params.fetchFn,
      baseUrl: params.baseUrl,
      requestPath: params.requestPath ?? undefined,
      model: params.model,
      messages: params.messages as any,
      apiKeys: params.apiKeys,
      timeoutMs: params.timeoutMs,
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
    });
  }
  throw Errors.modelProviderUnsupported(params.provider);
}

export async function invokeProviderChatStreamWithSecretRotation(params: StreamInvokeParams) {
  const family = getProviderProtocolFamily(params.provider);
  if (family === "openai") {
    return openAiChatStreamWithSecretRotation({
      fetchFn: params.fetchFn,
      baseUrl: params.baseUrl,
      chatCompletionsPath: params.requestPath ?? "/chat/completions",
      model: params.model,
      messages: params.messages as any,
      apiKeys: params.apiKeys,
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
      signal: params.signal,
      onDelta: params.onDelta,
      onUsage: params.onUsage,
    });
  }
  if (family === "anthropic") {
    return anthropicChatStreamWithSecretRotation({
      fetchFn: params.fetchFn,
      baseUrl: params.baseUrl,
      messagesPath: params.requestPath ?? "/v1/messages",
      model: params.model,
      messages: params.messages as any,
      apiKeys: params.apiKeys,
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
      signal: params.signal,
      onDelta: params.onDelta,
      onUsage: params.onUsage,
    });
  }
  if (family === "gemini") {
    return geminiChatStreamWithSecretRotation({
      fetchFn: params.fetchFn,
      baseUrl: params.baseUrl,
      requestPath: params.requestPath ?? undefined,
      model: params.model,
      messages: params.messages as any,
      apiKeys: params.apiKeys,
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
      signal: params.signal,
      onDelta: params.onDelta,
      onUsage: params.onUsage,
    });
  }
  throw Errors.modelProviderUnsupported(params.provider);
}
