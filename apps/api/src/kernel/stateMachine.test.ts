/**
 * stateMachine.ts 单元测试
 * 测试状态机定义、转换函数、规范化函数和状态不变量检查
 */
import { describe, it, expect } from "vitest";
import {
  STEP_STATUSES, STEP_TERMINAL, STEP_BLOCKING, STEP_TRANSITIONS,
  RUN_STATUSES, RUN_TERMINAL, RUN_TRANSITIONS,
  COLLAB_PHASES, COLLAB_TERMINAL, COLLAB_TRANSITIONS,
  transitionStep, transitionRun, transitionCollab,
  tryTransitionStep, tryTransitionRun, tryTransitionCollab,
  normalizeStepStatus, normalizeRunStatus, normalizeCollabPhase,
  checkStateInvariant,
} from "@mindpal/shared";

/* ================================================================== */
/*  常量定义完整性                                                       */
/* ================================================================== */

describe("stateMachine constants", () => {
  it("STEP_STATUSES 包含所有状态", () => {
    expect(STEP_STATUSES).toContain("pending");
    expect(STEP_STATUSES).toContain("running");
    expect(STEP_STATUSES).toContain("paused");
    expect(STEP_STATUSES).toContain("succeeded");
    expect(STEP_STATUSES).toContain("failed");
    expect(STEP_STATUSES).toContain("deadletter");
    expect(STEP_STATUSES).toContain("canceled");
    expect(STEP_STATUSES).toContain("needs_approval");
    expect(STEP_STATUSES).toContain("needs_device");
    expect(STEP_STATUSES).toContain("needs_arbiter");
    expect(STEP_STATUSES).toContain("streaming");
  });

  it("STEP_TERMINAL 包含终态", () => {
    expect(STEP_TERMINAL.has("succeeded")).toBe(true);
    expect(STEP_TERMINAL.has("deadletter")).toBe(true);
    expect(STEP_TERMINAL.has("pending")).toBe(false);
    expect(STEP_TERMINAL.has("running")).toBe(false);
  });

  it("STEP_BLOCKING 包含阻塞态", () => {
    expect(STEP_BLOCKING.has("needs_approval")).toBe(true);
    expect(STEP_BLOCKING.has("needs_device")).toBe(true);
    expect(STEP_BLOCKING.has("needs_arbiter")).toBe(true);
    expect(STEP_BLOCKING.has("paused")).toBe(true);
    expect(STEP_BLOCKING.has("running")).toBe(false);
  });

  it("RUN_STATUSES 包含所有状态", () => {
    expect(RUN_STATUSES).toContain("created");
    expect(RUN_STATUSES).toContain("queued");
    expect(RUN_STATUSES).toContain("running");
    expect(RUN_STATUSES).toContain("paused");
    expect(RUN_STATUSES).toContain("succeeded");
    expect(RUN_STATUSES).toContain("failed");
    expect(RUN_STATUSES).toContain("canceled");
    expect(RUN_STATUSES).toContain("stopped");
    expect(RUN_STATUSES).toContain("compensating");
    expect(RUN_STATUSES).toContain("compensated");
  });

  it("RUN_TERMINAL 包含终态", () => {
    expect(RUN_TERMINAL.has("succeeded")).toBe(true);
    expect(RUN_TERMINAL.has("failed")).toBe(true);
    expect(RUN_TERMINAL.has("canceled")).toBe(true);
    expect(RUN_TERMINAL.has("stopped")).toBe(true);
    expect(RUN_TERMINAL.has("compensated")).toBe(true);
    expect(RUN_TERMINAL.has("running")).toBe(false);
  });

  it("COLLAB_PHASES 包含所有阶段", () => {
    expect(COLLAB_PHASES).toContain("planning");
    expect(COLLAB_PHASES).toContain("executing");
    expect(COLLAB_PHASES).toContain("paused");
    expect(COLLAB_PHASES).toContain("succeeded");
    expect(COLLAB_PHASES).toContain("failed");
    expect(COLLAB_PHASES).toContain("stopped");
  });

  it("每个状态都有对应的转换表", () => {
    for (const s of STEP_STATUSES) {
      expect(STEP_TRANSITIONS[s]).toBeDefined();
    }
    for (const s of RUN_STATUSES) {
      expect(RUN_TRANSITIONS[s]).toBeDefined();
    }
    for (const s of COLLAB_PHASES) {
      expect(COLLAB_TRANSITIONS[s]).toBeDefined();
    }
  });
});

/* ================================================================== */
/*  transitionStep / tryTransitionStep                                  */
/* ================================================================== */

describe("transitionStep", () => {
  it("合法转换: pending → running", () => {
    expect(transitionStep("pending", "running")).toBe("running");
  });

  it("合法转换: running → succeeded", () => {
    expect(transitionStep("running", "succeeded")).toBe("succeeded");
  });

  it("合法转换: running → paused (P1-1.1)", () => {
    expect(transitionStep("running", "paused")).toBe("paused");
  });

  it("相同状态不抛异常", () => {
    expect(transitionStep("pending", "pending")).toBe("pending");
  });

  it("非法转换抛异常: pending → succeeded", () => {
    expect(() => transitionStep("pending", "succeeded")).toThrow();
  });

  it("终态不可转换: succeeded → running", () => {
    expect(() => transitionStep("succeeded", "running")).toThrow();
  });
});

describe("tryTransitionStep", () => {
  it("合法转换返回 ok: true", () => {
    const result = tryTransitionStep("pending", "running");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("running");
    expect(result.violation).toBeUndefined();
  });

  it("非法转换返回 ok: false 并包含 violation", () => {
    const result = tryTransitionStep("pending", "succeeded");
    expect(result.ok).toBe(false);
    expect(result.status).toBe("pending"); // 保持原状态
    expect(result.violation).toBeDefined();
    expect(result.violation?.entity).toBe("step");
    expect(result.violation?.from).toBe("pending");
    expect(result.violation?.to).toBe("succeeded");
  });

  it("相同状态返回 ok: true", () => {
    const result = tryTransitionStep("running", "running");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("running");
  });
});

/* ================================================================== */
/*  transitionRun / tryTransitionRun                                    */
/* ================================================================== */

describe("transitionRun", () => {
  it("合法转换: created → queued", () => {
    expect(transitionRun("created", "queued")).toBe("queued");
  });

  it("合法转换: running → paused (P1-1.1)", () => {
    expect(transitionRun("running", "paused")).toBe("paused");
  });

  it("合法转换: paused → queued (恢复)", () => {
    expect(transitionRun("paused", "queued")).toBe("queued");
  });

  it("合法转换: failed → queued (重试)", () => {
    expect(transitionRun("failed", "queued")).toBe("queued");
  });

  it("非法转换: created → succeeded", () => {
    expect(() => transitionRun("created", "succeeded")).toThrow();
  });
});

describe("tryTransitionRun", () => {
  it("合法转换返回 ok: true", () => {
    const result = tryTransitionRun("created", "queued");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("queued");
  });

  it("非法转换返回 ok: false", () => {
    const result = tryTransitionRun("created", "succeeded");
    expect(result.ok).toBe(false);
    expect(result.status).toBe("created");
  });
});

/* ================================================================== */
/*  transitionCollab / tryTransitionCollab                              */
/* ================================================================== */

describe("transitionCollab", () => {
  it("合法转换: planning → executing", () => {
    expect(transitionCollab("planning", "executing")).toBe("executing");
  });

  it("合法转换: executing → paused", () => {
    expect(transitionCollab("executing", "paused")).toBe("paused");
  });

  it("非法转换: succeeded → planning", () => {
    expect(() => transitionCollab("succeeded", "planning")).toThrow();
  });
});

describe("tryTransitionCollab", () => {
  it("合法转换返回 ok: true", () => {
    const result = tryTransitionCollab("planning", "executing");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("executing");
  });

  it("非法转换返回 ok: false", () => {
    const result = tryTransitionCollab("succeeded", "planning");
    expect(result.ok).toBe(false);
  });
});

/* ================================================================== */
/*  Normalizer                                                          */
/* ================================================================== */

describe("normalizeStepStatus", () => {
  it("正常状态原样返回", () => {
    expect(normalizeStepStatus("pending")).toBe("pending");
    expect(normalizeStepStatus("running")).toBe("running");
    expect(normalizeStepStatus("succeeded")).toBe("succeeded");
  });

  it("created 映射为 pending", () => {
    expect(normalizeStepStatus("created")).toBe("pending");
  });

  it("compensating 映射为 running", () => {
    expect(normalizeStepStatus("compensating")).toBe("running");
  });

  it("未知状态返回 null", () => {
    expect(normalizeStepStatus("unknown_status")).toBeNull();
    expect(normalizeStepStatus("")).toBeNull();
    expect(normalizeStepStatus(null)).toBeNull();
    expect(normalizeStepStatus(undefined)).toBeNull();
  });

  it("处理前后空格", () => {
    expect(normalizeStepStatus("  running  ")).toBe("running");
  });
});

describe("normalizeRunStatus", () => {
  it("正常状态原样返回", () => {
    expect(normalizeRunStatus("created")).toBe("created");
    expect(normalizeRunStatus("running")).toBe("running");
    expect(normalizeRunStatus("paused")).toBe("paused");
  });

  it("未知状态返回 null", () => {
    expect(normalizeRunStatus("unknown")).toBeNull();
    expect(normalizeRunStatus(null)).toBeNull();
  });
});

describe("normalizeCollabPhase", () => {
  it("正常阶段原样返回", () => {
    expect(normalizeCollabPhase("planning")).toBe("planning");
    expect(normalizeCollabPhase("executing")).toBe("executing");
  });

  it("canceled 映射为 stopped", () => {
    expect(normalizeCollabPhase("canceled")).toBe("stopped");
  });

  it("未知阶段返回 null", () => {
    expect(normalizeCollabPhase("unknown")).toBeNull();
  });
});

/* ================================================================== */
/*  checkStateInvariant                                                 */
/* ================================================================== */

describe("checkStateInvariant", () => {
  it("正常状态组合无违规", () => {
    const violations = checkStateInvariant({
      runStatus: "running",
      steps: [
        { stepId: "s1", status: "succeeded" },
        { stepId: "s2", status: "running" },
      ],
    });
    expect(violations).toHaveLength(0);
  });

  it("检测无效 Run 状态", () => {
    const violations = checkStateInvariant({
      runStatus: "invalid_status",
      steps: [],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].code).toBe("run.invalid_status");
    expect(violations[0].severity).toBe("error");
  });

  it("检测无效 Step 状态", () => {
    const violations = checkStateInvariant({
      runStatus: "running",
      steps: [{ stepId: "s1", status: "bogus_status" }],
    });
    expect(violations.some(v => v.code === "step.invalid_status")).toBe(true);
  });

  it("检测终态 Run 仍有活跃 Steps", () => {
    const violations = checkStateInvariant({
      runStatus: "succeeded",
      steps: [
        { stepId: "s1", status: "succeeded" },
        { stepId: "s2", status: "running" },
      ],
    });
    expect(violations.some(v => v.code === "run.terminal_with_active_steps")).toBe(true);
  });

  it("检测 succeeded Run 有 failed Steps", () => {
    const violations = checkStateInvariant({
      runStatus: "succeeded",
      steps: [
        { stepId: "s1", status: "succeeded" },
        { stepId: "s2", status: "failed" },
      ],
    });
    expect(violations.some(v => v.code === "run.succeeded_with_failed_steps")).toBe(true);
  });

  it("检测所有 Steps 终态但 Run 未终态", () => {
    const violations = checkStateInvariant({
      runStatus: "running",
      steps: [
        { stepId: "s1", status: "succeeded" },
        { stepId: "s2", status: "deadletter" },
      ],
    });
    expect(violations.some(v => v.code === "run.non_terminal_all_steps_done")).toBe(true);
  });

  it("检测 CollabPhase 无效值", () => {
    const violations = checkStateInvariant({
      runStatus: "running",
      steps: [],
      collabPhase: "invalid_phase",
    });
    expect(violations.some(v => v.code === "collab.invalid_phase")).toBe(true);
  });

  it("检测 CollabPhase 终态但 Run 活跃", () => {
    const violations = checkStateInvariant({
      runStatus: "running",
      steps: [],
      collabPhase: "succeeded",
    });
    expect(violations.some(v => v.code === "collab.terminal_run_active")).toBe(true);
  });

  it("检测 CollabPhase 活跃但 Run 终态", () => {
    const violations = checkStateInvariant({
      runStatus: "succeeded",
      steps: [],
      collabPhase: "executing",
    });
    expect(violations.some(v => v.code === "collab.active_run_terminal")).toBe(true);
  });

  it("空 Steps 数组无额外违规", () => {
    const violations = checkStateInvariant({
      runStatus: "created",
      steps: [],
    });
    expect(violations).toHaveLength(0);
  });
});
