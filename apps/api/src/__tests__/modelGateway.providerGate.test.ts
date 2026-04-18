import { describe, expect, it } from "vitest";
import { isSupportedModelProvider, isNativeProtocolProvider, openaiCompatibleProviders, nativeProtocolProviders, supportedModelProviders } from "../skills/model-gateway/modules/catalog";

describe("model gateway provider gate", () => {
  it("includes core providers", () => {
    expect(supportedModelProviders).toContain("openai");
    expect(supportedModelProviders).toContain("mock");
  });

  it("includes all openai-compatible providers", () => {
    for (const p of openaiCompatibleProviders) {
      expect(isSupportedModelProvider(p)).toBe(true);
    }
  });

  it("includes native protocol providers", () => {
    expect(supportedModelProviders).toContain("anthropic");
    expect(supportedModelProviders).toContain("gemini");
    expect(isNativeProtocolProvider("anthropic")).toBe(true);
    expect(isNativeProtocolProvider("gemini")).toBe(true);
    expect(isSupportedModelProvider("anthropic")).toBe(true);
    expect(isSupportedModelProvider("gemini")).toBe(true);
    for (const p of nativeProtocolProviders) {
      expect(isSupportedModelProvider(p)).toBe(true);
    }
  });

  it("rejects unknown providers", () => {
    expect(isSupportedModelProvider("cohere")).toBe(false);
    expect(isSupportedModelProvider("")).toBe(false);
  });
});
