import { describe, expect, it, vi } from "vitest";
import * as shared from "@mindpal/shared";
import { shouldDenyPromptInjectionForTarget, summarizePromptInjection } from "./promptInjection";

describe("promptInjection guard", () => {
  it("deny 模式且 target 命中时走阻断分支", () => {
    const spy = vi.spyOn(shared, "shouldDenyPromptInjection").mockReturnValue(true);
    const result = shouldDenyPromptInjectionForTarget({
      scan: { hits: [{ ruleId: "r1" }], maxSeverity: "high" } as any,
      policy: {
        version: "v1",
        mode: "deny",
        denyTargets: new Set(["model:invoke"]),
        denyScore: 0.5,
      },
      target: "model:invoke",
    });
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("deny 模式但 target 不命中时不阻断", () => {
    const spy = vi.spyOn(shared, "shouldDenyPromptInjection").mockReturnValue(true);
    const result = shouldDenyPromptInjectionForTarget({
      scan: { hits: [{ ruleId: "r1" }], maxSeverity: "high" } as any,
      policy: {
        version: "v1",
        mode: "deny",
        denyTargets: new Set(["model:invoke"]),
        denyScore: 0.5,
      },
      target: "tool:execute",
    });
    expect(result).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("summary 在 deny 分支输出 denied", () => {
    const summary = summarizePromptInjection(
      { hits: [{ ruleId: "pi-1" }, { ruleId: "pi-2" }], maxSeverity: "critical" } as any,
      "deny",
      "model:invoke",
      true,
    );
    expect(summary.decision).toBe("denied");
    expect(summary.result).toBe("denied");
    expect(summary.ruleIds).toEqual(["pi-1", "pi-2"]);
  });
});
