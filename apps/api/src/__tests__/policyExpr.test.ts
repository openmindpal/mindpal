import { describe, expect, it } from "vitest";
import { compilePolicyExprWhere, evaluateAbacPolicySet, validatePolicyExpr } from "@mindpal/shared";

describe("policyExpr", () => {
  it("validatePolicyExpr: accepts basic eq expr", () => {
    const v = validatePolicyExpr({
      op: "eq",
      left: { kind: "record", key: "ownerSubjectId" },
      right: { kind: "subject", key: "subjectId" },
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.usedPayloadPaths).toEqual([]);
  });

  it("validatePolicyExpr: accepts enhanced comparison operator", () => {
    const v = validatePolicyExpr({ op: "gt", left: { kind: "subject", key: "subjectId" }, right: "x" });
    expect(v.ok).toBe(true);
  });

  it("compilePolicyExprWhere: parameterizes payload path and values", () => {
    const args: any[] = [];
    const out = compilePolicyExprWhere({
      expr: { op: "eq", left: { kind: "payload", path: "a" }, right: "x" },
      subject: { subjectId: "u1", tenantId: "t1", spaceId: "s1" },
      args,
      idxStart: 0,
      ownerColumn: "owner_subject_id",
      payloadColumn: "payload",
    });
    expect(out.sql).toContain("#>>");
    expect(args.length).toBeGreaterThan(0);
    expect(JSON.stringify(args)).toContain("a");
  });

  it("compilePolicyExprWhere: rejects unsafe payload path", () => {
    const args: any[] = [];
    expect(() =>
      compilePolicyExprWhere({
        expr: { op: "exists", operand: { kind: "payload", path: "a);drop table x;--" } },
        subject: { subjectId: "u1", tenantId: "t1", spaceId: "s1" },
        args,
        idxStart: 0,
        ownerColumn: "owner_subject_id",
        payloadColumn: "payload",
      }),
    ).toThrow();
  });

  it("evaluateAbacPolicySet: applies deny_overrides with enhanced operators", () => {
    const result = evaluateAbacPolicySet(
      {
        policySetId: "ps-1",
        tenantId: "t1",
        name: "test",
        version: 1,
        combiningAlgorithm: "deny_overrides",
        enabled: true,
        rules: [
          {
            ruleId: "allow-owner",
            name: "allow-owner",
            resourceType: "entity:note",
            actions: ["read"],
            effect: "allow",
            priority: 10,
            enabled: true,
            condition: {
              op: "eq",
              left: { kind: "record", key: "ownerSubjectId" },
              right: { kind: "subject", key: "subjectId" },
            },
          },
          {
            ruleId: "deny-high-risk",
            name: "deny-high-risk",
            resourceType: "entity:note",
            actions: ["read"],
            effect: "deny",
            priority: 20,
            enabled: true,
            condition: {
              op: "gte",
              left: { kind: "payload", path: "riskScore" },
              right: 80,
            },
          },
        ],
      },
      {
        action: "read",
        subject: { subjectId: "u1", tenantId: "t1", spaceId: "s1", attributes: {} },
        resource: {
          resourceType: "entity:note",
          resourceId: "n1",
          ownerSubjectId: "u1",
          attributes: { riskScore: 92 },
        },
        environment: {},
      },
    );

    expect(result.decision).toBe("deny");
    expect(result.matchedRules.filter(rule => rule.matched)).toHaveLength(2);
  });
});
