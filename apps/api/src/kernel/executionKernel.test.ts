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
  it("requiredApprovals >= 2 时写入 approvalPolicy", () => {
    const result = buildApprovalInputDigest({
      inputDigest: { input: { title: "x" } },
      resolved: highRiskResolved,
      requiredApprovals: 2,
    });

    expect(result).toEqual({
      input: { title: "x" },
      approvalPolicy: { requiredApprovals: 2 },
    });
  });

  it("保留已有 approvalPolicy 字段并覆盖 requiredApprovals", () => {
    const result = buildApprovalInputDigest({
      inputDigest: {
        input: { title: "x" },
        approvalPolicy: { escalationTarget: "ops-manager" },
      },
      resolved: highRiskResolved,
      requiredApprovals: 2,
    });

    expect(result).toEqual({
      input: { title: "x" },
      approvalPolicy: {
        escalationTarget: "ops-manager",
        requiredApprovals: 2,
      },
    });
  });

  it("requiredApprovals <= 1 时保持原始 inputDigest", () => {
    const original = { input: { title: "x" } };
    const result = buildApprovalInputDigest({
      inputDigest: original,
      resolved: highRiskResolved,
      requiredApprovals: 1,
    });

    expect(result).toEqual(original);
  });

  it("低风险工具 requiredApprovals=0 不会注入审批策略", () => {
    const original = { input: { title: "x" } };
    const result = buildApprovalInputDigest({
      inputDigest: original,
      resolved: lowRiskResolved,
      requiredApprovals: 0,
    });

    expect(result).toEqual(original);
  });
});
