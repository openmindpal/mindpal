/**
 * Model Provider Contract — kernel-level type + validation.
 *
 * This module lives in lib/ so that core governance code can check whether a
 * provider string is supported WITHOUT importing from the model-gateway Skill.
 * The model-gateway Skill's catalog.ts re-exports these for convenience.
 */

export const openaiCompatibleProviders = [
  "openai_compatible",
  "deepseek",
  "hunyuan",
  "qianwen",
  "zhipu",
  "doubao",
  "kimi",
  "custom_openai",
] as const;

export type OpenAiCompatibleProvider = (typeof openaiCompatibleProviders)[number];

export function isOpenAiCompatibleProvider(v: string): v is OpenAiCompatibleProvider {
  return (openaiCompatibleProviders as readonly string[]).includes(v);
}

/** Providers with their own (non-OpenAI-compatible) protocol adapters. */
export const nativeProtocolProviders = ["anthropic", "gemini", "custom_anthropic", "custom_gemini"] as const;
export type NativeProtocolProvider = (typeof nativeProtocolProviders)[number];

export function isNativeProtocolProvider(v: string): v is NativeProtocolProvider {
  return (nativeProtocolProviders as readonly string[]).includes(v);
}

export const supportedModelProviders = ["openai", "mock", ...nativeProtocolProviders, ...openaiCompatibleProviders] as const;
export type SupportedModelProvider = (typeof supportedModelProviders)[number];

export function isSupportedModelProvider(v: string): v is SupportedModelProvider {
  return v === "openai" || v === "mock" || isNativeProtocolProvider(v) || isOpenAiCompatibleProvider(v);
}
