import { describe, expect, it } from "vitest";
import { normalizeGeminiBaseUrl, normalizeOpenAiCompatibleBaseUrl } from "./helpers";

describe("normalizeOpenAiCompatibleBaseUrl", () => {
  it("strips chat completions suffixes", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("https://example.com/v1/chat/completions")).toBe("https://example.com/v1");
    expect(normalizeOpenAiCompatibleBaseUrl("https://example.com/chat/completions")).toBe("https://example.com");
  });

  it("strips anthropic messages suffixes", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("https://api.anthropic.com/v1/messages")).toBe("https://api.anthropic.com/v1");
    expect(normalizeOpenAiCompatibleBaseUrl("https://proxy.example.com/messages")).toBe("https://proxy.example.com");
  });

  it("strips gemini generate content suffixes", () => {
    expect(normalizeGeminiBaseUrl("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent")).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(normalizeGeminiBaseUrl("https://proxy.example.com/models/demo:streamGenerateContent")).toBe("https://proxy.example.com");
  });
});
