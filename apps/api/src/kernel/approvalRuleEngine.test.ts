import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ApprovalRule, MatchCondition, RuleEffect,
  ToolExecutionAssessment, ChangesetGateAssessment,
} from "./approvalRuleEngine";
import {
  assessToolExecutionRisk,
  assessChangesetGate,
  checkEvalAdmission,
  loadApprovalRules,
} from "./approvalRuleEngine";

/* ── Mock Pool ─────────────────────────────────────────────── */

function mockPool(rows: any[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as any;
}

/** 快速构建一条 DB 行格式的规则 */
function dbRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    rule_id: "r-1",
    tenant_id: "t-1",
    rule_type: "tool_execution",
    name: "Test Rule",
    description: "desc",
    priority: 10,
    enabled: true,
    match_condition: { match: "always" },
    effect: { riskLevel: "medium", approvalRequired: true },
    scope_type: null,
    scope_id: null,
    metadata: {},
    ...overrides,
  };
}

/* ================================================================== */
/*  assessToolExecutionRisk                                            */
/* ================================================================== */

describe("assessToolExecutionRisk", () => {
  it("should return low risk when no rules match", async () => {
    const pool = mockPool([]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "echo@1.0", inputDraft: {},
    });
    expect(result.riskLevel).toBe("low");
    expect(result.approvalRequired).toBe(false);
    expect(result.matchedRules.length).toBe(0);
    expect(result.humanSummary).toContain("无需审批");
  });

  it("should match tool_name_regex rule", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "tool_name_regex", pattern: "^file\\.delete" }, effect: { riskLevel: "high", approvalRequired: true } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "file.delete@1.0", inputDraft: {},
    });
    expect(result.riskLevel).toBe("high");
    expect(result.approvalRequired).toBe(true);
    expect(result.matchedRules.length).toBe(1);
    expect(result.matchedRules[0].explanation).toContain("file.delete");
  });

  it("should NOT match when tool_name_regex does not match", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "tool_name_regex", pattern: "^file\\.delete" }, effect: { riskLevel: "high" } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "echo@1.0", inputDraft: {},
    });
    expect(result.riskLevel).toBe("low");
    expect(result.matchedRules.length).toBe(0);
  });

  it("should match input_content_regex", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "input_content_regex", pattern: "DROP\\s+TABLE" }, effect: { riskLevel: "high", approvalRequired: true } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "sql.execute@1.0",
      inputDraft: { query: "DROP TABLE users" },
    });
    expect(result.approvalRequired).toBe(true);
    expect(result.matchedRules.length).toBe(1);
  });

  it("should match input_batch_size when exceeding threshold", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "input_batch_size", threshold: 5 }, effect: { riskLevel: "medium", approvalRequired: true } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "bulk.update@1.0",
      inputDraft: { items: [1, 2, 3, 4, 5, 6, 7] },
    });
    expect(result.approvalRequired).toBe(true);
    expect(result.matchedRules[0].explanation).toContain("7");
  });

  it("should NOT match input_batch_size below threshold", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "input_batch_size", threshold: 10 }, effect: { riskLevel: "medium" } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "bulk.update@1.0",
      inputDraft: { items: [1, 2] },
    });
    expect(result.matchedRules.length).toBe(0);
  });

  it("should match input_field_gte", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "input_field_gte", field: "amount", threshold: 1000 }, effect: { riskLevel: "high", approvalRequired: true } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "payment@1.0",
      inputDraft: { amount: 5000 },
    });
    expect(result.riskLevel).toBe("high");
    expect(result.approvalRequired).toBe(true);
  });

  it("should match nested input_field_gte (dotted path)", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "input_field_gte", field: "payload.amount", threshold: 100 }, effect: { riskLevel: "medium" } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "transfer@1.0",
      inputDraft: { payload: { amount: 200 } },
    });
    expect(result.matchedRules.length).toBe(1);
  });

  it("should match input_field_regex", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "input_field_regex", field: "target", pattern: "prod" }, effect: { riskLevel: "high" } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "deploy@1.0",
      inputDraft: { target: "production-cluster" },
    });
    expect(result.matchedRules.length).toBe(1);
  });

  it("should match tool_scope", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "tool_scope", scope: "write" }, effect: { riskLevel: "medium", approvalRequired: true } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "data.update@1.0",
      inputDraft: {},
      toolDefinition: { scope: "write" },
    });
    expect(result.approvalRequired).toBe(true);
  });

  it("should match 'always' rule", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "always" }, effect: { riskLevel: "low", approvalRequired: true } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "any.tool@1.0", inputDraft: {},
    });
    expect(result.approvalRequired).toBe(true);
    expect(result.matchedRules[0].explanation).toContain("始终生效");
  });

  /* ── AND/OR recursive conditions ──────────────────────────── */

  it("should match AND condition (all sub-conditions satisfied)", async () => {
    const pool = mockPool([
      dbRow({
        match_condition: {
          match: "and",
          conditions: [
            { match: "tool_name_regex", pattern: "deploy" },
            { match: "input_field_regex", field: "env", pattern: "prod" },
          ],
        },
        effect: { riskLevel: "high", approvalRequired: true },
      }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "deploy@1.0",
      inputDraft: { env: "production" },
    });
    expect(result.riskLevel).toBe("high");
    expect(result.approvalRequired).toBe(true);
  });

  it("should NOT match AND condition when one sub-condition fails", async () => {
    const pool = mockPool([
      dbRow({
        match_condition: {
          match: "and",
          conditions: [
            { match: "tool_name_regex", pattern: "deploy" },
            { match: "input_field_regex", field: "env", pattern: "prod" },
          ],
        },
        effect: { riskLevel: "high" },
      }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "deploy@1.0",
      inputDraft: { env: "staging" },
    });
    expect(result.matchedRules.length).toBe(0);
  });

  it("should match OR condition (any sub-condition satisfied)", async () => {
    const pool = mockPool([
      dbRow({
        match_condition: {
          match: "or",
          conditions: [
            { match: "tool_name_regex", pattern: "^delete" },
            { match: "tool_name_regex", pattern: "^drop" },
          ],
        },
        effect: { riskLevel: "high", approvalRequired: true },
      }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "drop.table@1.0", inputDraft: {},
    });
    expect(result.approvalRequired).toBe(true);
  });

  /* ── Risk escalation & multi-rule accumulation ─────────── */

  it("should escalate risk to the highest matched rule", async () => {
    const pool = mockPool([
      dbRow({ rule_id: "r-1", match_condition: { match: "always" }, effect: { riskLevel: "low" } }),
      dbRow({ rule_id: "r-2", match_condition: { match: "tool_name_regex", pattern: "danger" }, effect: { riskLevel: "high" } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "danger.op@1.0", inputDraft: {},
    });
    expect(result.riskLevel).toBe("high");
    expect(result.approvalRequired).toBe(true); // high → auto-approval
  });

  it("should accumulate approverRoles from multiple rules", async () => {
    const pool = mockPool([
      dbRow({ rule_id: "r-1", match_condition: { match: "always" }, effect: { approverRoles: ["admin"] } }),
      dbRow({ rule_id: "r-2", match_condition: { match: "always" }, effect: { approverRoles: ["admin", "security"] } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "op@1.0", inputDraft: {},
    });
    expect(result.approverRoles).toContain("admin");
    expect(result.approverRoles).toContain("security");
    expect(result.approverRoles.length).toBe(2); // de-duplicated
  });

  it("should pick the smallest expiresInMinutes from multiple rules", async () => {
    const pool = mockPool([
      dbRow({ rule_id: "r-1", match_condition: { match: "always" }, effect: { expiresInMinutes: 60 } }),
      dbRow({ rule_id: "r-2", match_condition: { match: "always" }, effect: { expiresInMinutes: 30 } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "op@1.0", inputDraft: {},
    });
    expect(result.expiresInMinutes).toBe(30);
  });

  it("should use toolDefinition as baseline risk", async () => {
    const pool = mockPool([]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "op@1.0", inputDraft: {},
      toolDefinition: { riskLevel: "medium", approvalRequired: true },
    });
    expect(result.riskLevel).toBe("medium");
    expect(result.approvalRequired).toBe(true);
  });

  it("should handle invalid regex gracefully (skip rule)", async () => {
    const pool = mockPool([
      dbRow({ match_condition: { match: "tool_name_regex", pattern: "[invalid" }, effect: { riskLevel: "high" } }),
    ]);
    const result = await assessToolExecutionRisk({
      pool, tenantId: "t-1", toolRef: "anything@1.0", inputDraft: {},
    });
    expect(result.matchedRules.length).toBe(0);
  });
});

/* ================================================================== */
/*  assessChangesetGate                                                */
/* ================================================================== */

describe("assessChangesetGate", () => {
  it("should return low risk for empty item kinds", async () => {
    const pool = mockPool([]);
    const result = await assessChangesetGate({ pool, tenantId: "t-1", itemKinds: [] });
    expect(result.riskLevel).toBe("low");
    expect(result.requiredApprovals).toBe(1);
    expect(result.evalAdmissionRequired).toBe(false);
  });

  it("should match item_kind_prefix rule", async () => {
    // The pool.query is called twice (gate + eval), so we need different responses per call
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [dbRow({
            rule_type: "changeset_gate",
            match_condition: { match: "item_kind_prefix", pattern: "tool." },
            effect: { riskLevel: "high", requiredApprovals: 2 },
          })],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    } as any;

    const result = await assessChangesetGate({
      pool, tenantId: "t-1", itemKinds: ["tool.execute"],
    });
    expect(result.riskLevel).toBe("high");
    expect(result.requiredApprovals).toBe(2);
  });

  it("should match item_kind_exact rule", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [dbRow({
            rule_type: "changeset_gate",
            match_condition: { match: "item_kind_exact", pattern: "deploy.production" },
            effect: { riskLevel: "high", requiredApprovals: 3 },
          })],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    } as any;

    const result = await assessChangesetGate({
      pool, tenantId: "t-1", itemKinds: ["deploy.production"],
    });
    expect(result.requiredApprovals).toBe(3);
  });

  it("should detect eval_admission requirement", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // gate rules
        .mockResolvedValueOnce({
          rows: [dbRow({
            rule_type: "eval_admission",
            match_condition: { match: "item_kind_prefix", pattern: "model." },
            effect: { evalRequired: true },
          })],
          rowCount: 1,
        }),
    } as any;

    const result = await assessChangesetGate({
      pool, tenantId: "t-1", itemKinds: ["model.config"],
    });
    expect(result.evalAdmissionRequired).toBe(true);
  });

  it("should enforce minimum 2 approvals for high risk", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [dbRow({
            match_condition: { match: "always" },
            effect: { riskLevel: "high", requiredApprovals: 1 },
          })],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    } as any;

    const result = await assessChangesetGate({
      pool, tenantId: "t-1", itemKinds: ["anything"],
    });
    expect(result.requiredApprovals).toBe(2); // enforced minimum for high risk
  });
});

/* ================================================================== */
/*  checkEvalAdmission                                                 */
/* ================================================================== */

describe("checkEvalAdmission", () => {
  it("should return required=false when no rules match", async () => {
    const pool = mockPool([]);
    const result = await checkEvalAdmission({ pool, tenantId: "t-1", kind: "any" });
    expect(result.required).toBe(false);
    expect(result.matchedRule).toBeNull();
  });

  it("should return required=true when eval rule matches", async () => {
    const pool = mockPool([
      dbRow({
        rule_type: "eval_admission",
        match_condition: { match: "item_kind_prefix", pattern: "model." },
        effect: { evalRequired: true },
      }),
    ]);
    const result = await checkEvalAdmission({ pool, tenantId: "t-1", kind: "model.update" });
    expect(result.required).toBe(true);
    expect(result.matchedRule).toBeDefined();
    expect(result.explanation).toContain("model.update");
  });
});
