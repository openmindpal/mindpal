import { describe, expect, it } from "vitest";
import { buildExecutionReplyText, explainDispatchStreamError, explainPlanningFailure } from "./dispatch.helpers";
import type { PlanningResult, PlanFailureCategory } from "../../kernel/planningKernel";

function planningFailure(failureCategory: PlanFailureCategory): PlanningResult {
  return {
    ok: false,
    failureCategory,
    modelOutputText: "",
    enabledTools: [],
    planSteps: [],
    rawSuggestionCount: 0,
    filteredSuggestionCount: 0,
    toolCatalog: "",
  };
}

describe("dispatch planning failure messaging", () => {
  it("maps empty to user-friendly zh text", () => {
    expect(explainPlanningFailure("zh-CN", "empty")).toContain("明确的执行步骤");
  });

  it("does not expose raw failure category in reply text", () => {
    const text = buildExecutionReplyText({
      locale: "zh-CN",
      userMessage: "打开百度网页",
      planResult: planningFailure("empty"),
      phase: "failed",
    });

    expect(text).not.toContain("empty");
    expect(text).toContain("还没能生成可执行计划");
  });

  it("falls back to generic stream error text instead of raw internal message", () => {
    const text = explainDispatchStreamError("zh-CN", undefined);
    expect(String(text)).toContain("调度失败");
  });

  it("preserves localized payload messages when already safe", () => {
    const text = explainDispatchStreamError("zh-CN", { "zh-CN": "权限不足", "en-US": "Forbidden" });
    expect(typeof text).toBe("object");
    expect((text as Record<string, string>)["zh-CN"]).toBe("权限不足");
  });
});
