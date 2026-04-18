/**
 * runtimeStepManager.ts 单元测试
 * 
 * 该模块所有函数都依赖 DB Pool，此测试验证：
 * 1. 类型导出完整性
 * 2. 函数签名正确性
 * 3. 模块可正确导入
 */
import { describe, it, expect } from "vitest";
import type {
  RuntimeStep,
  InsertStepParams,
  InsertStepResult,
  ReplanContext,
  ReplanResult,
} from "./runtimeStepManager";
import {
  insertStep,
  appendStep,
  removeStep,
  replanFromCurrent,
  getEditableSteps,
} from "./runtimeStepManager";

/* ================================================================== */
/*  模块导出完整性                                                       */
/* ================================================================== */

describe("runtimeStepManager exports", () => {
  it("insertStep 是函数", () => {
    expect(typeof insertStep).toBe("function");
  });

  it("appendStep 是函数", () => {
    expect(typeof appendStep).toBe("function");
  });

  it("removeStep 是函数", () => {
    expect(typeof removeStep).toBe("function");
  });

  it("replanFromCurrent 是函数", () => {
    expect(typeof replanFromCurrent).toBe("function");
  });

  it("getEditableSteps 是函数", () => {
    expect(typeof getEditableSteps).toBe("function");
  });
});

/* ================================================================== */
/*  类型结构验证（通过 TypeScript 编译时检查）                           */
/* ================================================================== */

describe("runtimeStepManager types", () => {
  it("RuntimeStep 类型结构正确", () => {
    const step: RuntimeStep = {
      stepId: "test-id",
      actorRole: "executor",
      kind: "tool",
      toolRef: "test@1.0.0",
      inputDraft: { key: "value" },
      dependsOn: ["dep1"],
      approvalRequired: false,
    };
    expect(step.stepId).toBe("test-id");
    expect(step.kind).toBe("tool");
    expect(step.toolRef).toBe("test@1.0.0");
    expect(step.dependsOn).toHaveLength(1);
  });

  it("RuntimeStep 可选字段", () => {
    const step: RuntimeStep = {
      stepId: "s1",
      actorRole: "executor",
      kind: "tool",
      toolRef: "t@1.0",
      inputDraft: {},
      dependsOn: [],
      approvalRequired: true,
      status: "pending",
      seq: 1,
    };
    expect(step.status).toBe("pending");
    expect(step.seq).toBe(1);
  });

  it("InsertStepResult 类型结构", () => {
    const success: InsertStepResult = {
      ok: true,
      stepId: "step-123",
      seq: 5,
      message: "步骤已插入",
    };
    expect(success.ok).toBe(true);

    const failure: InsertStepResult = {
      ok: false,
      message: "验证失败",
      validationErrors: ["toolRef 不能为空"],
    };
    expect(failure.ok).toBe(false);
    expect(failure.validationErrors).toHaveLength(1);
  });

  it("ReplanResult 类型结构", () => {
    const result: ReplanResult = {
      ok: true,
      insertedCount: 3,
      removedCount: 2,
      message: "重新规划完成",
      newStepIds: ["s1", "s2", "s3"],
    };
    expect(result.insertedCount).toBe(3);
    expect(result.removedCount).toBe(2);
    expect(result.newStepIds).toHaveLength(3);
  });
});
