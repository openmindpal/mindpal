import { describe, it, expect } from "vitest";
import {
  parseStructuredSummary,
  extractEntities,
  shouldTriggerEventDrivenSummary,
  buildLightChatPrompt,
  buildSystemPrompt,
} from "../modules/orchestrator";

/* ── parseStructuredSummary ── */
describe("orchestrator/parseStructuredSummary", () => {
  it("should parse JSON block wrapped in ```json```", () => {
    const text = '```json\n{"summary":"hello","activeTopic":"test"}\n```';
    const result = parseStructuredSummary(text);
    expect(result.structured).toBeTruthy();
    expect(result.structured!.summary).toBe("hello");
    expect(result.summary).toBe("hello");
  });

  it("should parse bare JSON object", () => {
    const text = '{"summary":"bare json","key":"val"}';
    const result = parseStructuredSummary(text);
    expect(result.structured).toBeTruthy();
    expect(result.summary).toBe("bare json");
  });

  it("should fallback to plain text when no JSON found", () => {
    const text = "This is just a normal summary without JSON.";
    const result = parseStructuredSummary(text);
    expect(result.structured).toBeNull();
    expect(result.summary).toBe(text);
  });

  it("should fallback on malformed JSON", () => {
    const text = '```json\n{broken json}\n```';
    const result = parseStructuredSummary(text);
    expect(result.structured).toBeNull();
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("should truncate summary to max 500 chars", () => {
    const longText = "A".repeat(1000);
    const result = parseStructuredSummary(longText);
    expect(result.summary.length).toBe(500);
  });

  it("should use text as summary when JSON has no summary field", () => {
    const text = '{"activeTopic":"something"}';
    const result = parseStructuredSummary(text);
    expect(result.structured!.activeTopic).toBe("something");
    // summary falls back to text.slice(0,500)
    expect(result.summary).toBe(text);
  });
});

/* ── extractEntities ── */
describe("orchestrator/extractEntities", () => {
  it("should extract quoted entities", () => {
    const entities = extractEntities('讨论了"XX项目"和"YY审批"的进展');
    expect(entities).toContain("XX项目");
    expect(entities).toContain("YY审批");
  });

  it("should extract 《》 entities", () => {
    const entities = extractEntities("参考了《用户手册》");
    expect(entities).toContain("用户手册");
  });

  it("should extract capitalized+keyword entities", () => {
    const entities = extractEntities("关于CRM项目和HR系统的问题");
    expect(entities.some((e) => e.includes("CRM"))).toBe(true);
  });

  it("should return empty for no entities", () => {
    const entities = extractEntities("hello world");
    expect(entities.length).toBe(0);
  });

  it("should deduplicate entities", () => {
    const entities = extractEntities('"Abc" and "Abc"');
    expect(entities.filter((e) => e === "Abc").length).toBe(1);
  });

  it("should limit to 10 entities", () => {
    const parts = Array.from({ length: 20 }, (_, i) => `"entity${i}"`).join(" ");
    const entities = extractEntities(parts);
    expect(entities.length).toBeLessThanOrEqual(10);
  });

  it("should handle undefined/empty inputs", () => {
    expect(extractEntities(undefined, undefined)).toEqual([]);
    expect(extractEntities("")).toEqual([]);
  });
});

/* ── shouldTriggerEventDrivenSummary ── */
describe("orchestrator/shouldTriggerEventDrivenSummary", () => {
  it("should trigger on topic switch keywords", () => {
    expect(shouldTriggerEventDrivenSummary("换个话题吧", 5)).toEqual({ should: true, reason: "topic_switch" });
  });

  it("should trigger on conclusion keywords", () => {
    expect(shouldTriggerEventDrivenSummary("总结一下刚才的讨论", 3)).toEqual({ should: true, reason: "conclusion" });
  });

  it("should trigger on finalization keywords", () => {
    expect(shouldTriggerEventDrivenSummary("就这样吧", 3)).toEqual({ should: true, reason: "finalization" });
  });

  it("should trigger on listing keywords", () => {
    expect(shouldTriggerEventDrivenSummary("列个清单", 3)).toEqual({ should: true, reason: "listing" });
  });

  it("should trigger on reference keywords", () => {
    expect(shouldTriggerEventDrivenSummary("按前面的方式处理", 3)).toEqual({ should: true, reason: "reference" });
  });

  it("should trigger periodically every 10 turns", () => {
    expect(shouldTriggerEventDrivenSummary("普通消息", 10).should).toBe(true);
    expect(shouldTriggerEventDrivenSummary("普通消息", 20).should).toBe(true);
    expect(shouldTriggerEventDrivenSummary("普通消息", 30).reason).toBe("periodic_10");
  });

  it("should not trigger at non-10 turn counts", () => {
    expect(shouldTriggerEventDrivenSummary("普通消息", 7).should).toBe(false);
  });

  it("should trigger on long messages after 5 turns", () => {
    const longMsg = "A".repeat(600);
    expect(shouldTriggerEventDrivenSummary(longMsg, 6).should).toBe(true);
    expect(shouldTriggerEventDrivenSummary(longMsg, 6).reason).toBe("long_message");
  });

  it("should not trigger on long messages at early turns", () => {
    const longMsg = "A".repeat(600);
    expect(shouldTriggerEventDrivenSummary(longMsg, 3).should).toBe(false);
  });

  it("should not trigger on short ordinary messages", () => {
    expect(shouldTriggerEventDrivenSummary("你好", 3)).toEqual({ should: false });
  });
});

/* ── buildLightChatPrompt ── */
describe("orchestrator/buildLightChatPrompt", () => {
  it("should include capability summary without memory", () => {
    const prompt = buildLightChatPrompt("zh-CN");
    expect(prompt).toBeTruthy();
    expect(prompt).not.toContain("相关记忆");
  });

  it("should include summary context when provided", () => {
    const prompt = buildLightChatPrompt("zh-CN", { totalTurnCount: 30, windowMessageCount: 10, summary: "之前讨论了项目进展" });
    expect(prompt).toContain("项目进展");
    expect(prompt).toContain("早期对话摘要");
  });

  it("should work for en-US locale", () => {
    const prompt = buildLightChatPrompt("en-US");
    expect(prompt).not.toContain("Recalled Memory");
  });

  it("should work with no arguments except locale", () => {
    const prompt = buildLightChatPrompt("zh-CN");
    expect(prompt).toBeTruthy();
    expect(prompt).not.toContain("相关记忆");
  });
});

/* ── buildSystemPrompt ── */
describe("orchestrator/buildSystemPrompt", () => {
  it("should include tool catalog when provided", () => {
    const prompt = buildSystemPrompt("zh-CN", "", "tool1: description\ntool2: description");
    expect(prompt).toContain("Available Tools");
    expect(prompt).toContain("tool1");
  });

  it("should not include memory section", () => {
    const prompt = buildSystemPrompt("zh-CN", "", "");
    expect(prompt).not.toContain("Recalled Memory");
  });

  it("should include task context", () => {
    const prompt = buildSystemPrompt("zh-CN", "最近任务列表", "");
    expect(prompt).toContain("最近任务列表");
    expect(prompt).toContain("Recent Tasks");
  });

  it("should include conversation context summary", () => {
    const prompt = buildSystemPrompt("zh-CN", "", "", { totalTurnCount: 50, windowMessageCount: 10, summary: "摘要" });
    expect(prompt).toContain("摘要");
  });

  it("should include platform description", () => {
    const prompt = buildSystemPrompt("zh-CN", "", "");
    expect(prompt).toContain("灵智Mindpal");
    expect(prompt).toContain("Agent OS");
  });
});
