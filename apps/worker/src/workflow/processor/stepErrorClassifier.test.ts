import { describe, expect, it } from "vitest";
import { extractErrorInfo, getErrorRecoveryDecision } from "./stepErrorClassifier";

describe("stepErrorClassifier", () => {
  it("会把 concurrency_limit 归一化为 resource_exhausted", () => {
    const info = extractErrorInfo(new Error("concurrency_limit:worker"));

    expect(info.message).toBe("resource_exhausted:max_concurrency");
    expect(info.category).toBe("resource_exhausted");
  });

  it("会为 policy_violation 返回不再抛出的恢复决策", () => {
    const decision = getErrorRecoveryDecision("policy_violation");

    expect(decision.shouldRethrow).toBe(false);
    expect(decision.isTerminal).toBe(true);
  });

  it("会为 retryable 返回继续抛出的恢复决策", () => {
    const decision = getErrorRecoveryDecision("retryable");

    expect(decision.shouldRethrow).toBe(true);
    expect(decision.isTerminal).toBe(false);
  });
});
