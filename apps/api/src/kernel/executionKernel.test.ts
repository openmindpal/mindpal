import { describe, expect, it } from "vitest";
import { buildApprovalInputDigest } from "./executionKernel";

const highRiskResolved = {
  definition: {
    approvalRequired: true,
    riskLevel: "high",
  },
} as any;

const lowRiskResolved = {
  definition: {
    approvalRequired: false,
    riskLevel: "low",
  },
} as any;

describe("buildApprovalInputDigest", () => {
  it("高风险且启用双人审批时写入 approvalPolicy.requireDualApproval", () => {
    const result = buildApprovalInputDigest({
      inputDigest: { input: { title: "x" } },
      resolved: highRiskResolved,
      requireDualApprovalForHighRisk: true,
    });

    expect(result).toEqual({
      input: { title: "x" },
      approvalPolicy: { requireDualApproval: true },
    });
  });

  it("保留已有 approvalPolicy 字段并覆盖 requireDualApproval", () => {
    const result = buildApprovalInputDigest({
      inputDigest: {
        input: { title: "x" },
        approvalPolicy: { escalationTarget: "ops-manager", requireDualApproval: false },
      },
      resolved: highRiskResolved,
      requireDualApprovalForHighRisk: true,
    });

    expect(result).toEqual({
      input: { title: "x" },
      approvalPolicy: {
        escalationTarget: "ops-manager",
        requireDualApproval: true,
      },
    });
  });

  it("未启用双人审批配置时保持原始 inputDigest", () => {
    const original = { input: { title: "x" } };
    const result = buildApprovalInputDigest({
      inputDigest: original,
      resolved: highRiskResolved,
      requireDualApprovalForHighRisk: false,
    });

    expect(result).toEqual(original);
  });

  it("低风险工具不会注入双人审批策略", () => {
    const original = { input: { title: "x" } };
    const result = buildApprovalInputDigest({
      inputDigest: original,
      resolved: lowRiskResolved,
      requireDualApprovalForHighRisk: true,
    });

    expect(result).toEqual(original);
  });
});
