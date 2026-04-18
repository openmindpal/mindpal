import { beforeEach, describe, expect, it, vi } from "vitest";
import { decomposeGoal } from "./goalDecomposer";

const { invokeModelChat } = vi.hoisted(() => ({
  invokeModelChat: vi.fn(),
}));

vi.mock("../lib/llm", () => ({
  invokeModelChat,
}));

function createParams(goal: string) {
  return {
    app: {
      log: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
      metrics: {
        observeGoalDecompose: vi.fn(),
        observePlanQualityScore: vi.fn(),
      },
    } as any,
    pool: {} as any,
    subject: {
      tenantId: "tenant-1",
      subjectId: "subject-1",
    } as any,
    locale: "zh-CN",
    authorization: null,
    traceId: "trace-1",
    goal,
    runId: "run-1",
    toolCatalog: "entity.read@1\nworkflow.approve@1\nmail.send@1",
  };
}

describe("goalDecomposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("简单目标 early-exit 也会生成质量报告并打点", async () => {
    const params = createParams("查询最近的订单");
    const result = await decomposeGoal(params);

    expect(invokeModelChat).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.planningQualityReport).toBeDefined();
    expect(result.graph.subGoals).toHaveLength(1);
    expect(params.app.metrics.observePlanQualityScore).toHaveBeenCalledWith(
      expect.objectContaining({ repairApplied: false }),
    );
  });

  it("LLM 分解结果会经过质量分析与语义修复", async () => {
    invokeModelChat.mockResolvedValue({
      outputText: [
        "```goal_decomposition",
        JSON.stringify({
          reasoning: "需要先查询再汇总",
          subGoals: [
            {
              goalId: "g1",
              description: "查询客户数据",
              dependsOn: [],
              suggestedToolRefs: ["entity.read@1"],
              successCriteria: [{ description: "拿到客户数据", weight: 1, required: true }],
              completionEvidence: ["查询结果"],
            },
            {
              goalId: "g2",
              description: "查询客户数据",
              dependsOn: [],
              suggestedToolRefs: ["entity.read@1"],
              successCriteria: [{ description: "拿到客户数据", weight: 1, required: true }],
              completionEvidence: ["查询结果"],
            },
            {
              goalId: "g3",
              description: "汇总并输出报告",
              dependsOn: ["g1"],
              suggestedToolRefs: ["mail.send@1"],
              preconditions: [{ description: "客户数据已查询", assertionType: "data_exists" }],
              postconditions: [{ description: "报告已输出" }],
              successCriteria: [{ description: "成功输出报告", weight: 1, required: true }],
              completionEvidence: ["报告文件"],
            },
          ],
          globalSuccessCriteria: [{ description: "完成客户数据报告", weight: 1, required: true }],
        }),
        "```",
      ].join("\n"),
      modelRef: "mock-model",
    });

    const params = createParams("为客户经营分析生成执行计划");
    const result = await decomposeGoal(params);

    expect(result.ok).toBe(true);
    expect(invokeModelChat).toHaveBeenCalledTimes(1);
    expect(result.graph.subGoals).toHaveLength(2);
    expect(result.graph.subGoals[0]?.description).toBe("查询客户数据");
    expect(result.graph.subGoals[1]?.description).toBe("汇总并输出报告");
    expect(result.planningQualityReport).toBeDefined();
    expect(result.planningQualityReport?.repairs.some((repair) => repair.applied)).toBe(true);
    expect(params.app.metrics.observePlanQualityScore).toHaveBeenCalledWith(
      expect.objectContaining({ repairApplied: true }),
    );
  });

  it("多步骤串行目标会走确定性模板分解", async () => {
    const params = createParams("查询客户张三的所有订单，然后导出为 Excel");
    const result = await decomposeGoal(params);

    expect(invokeModelChat).not.toHaveBeenCalled();
    expect(result.graph.subGoals).toHaveLength(2);
    expect(result.graph.subGoals[0]?.suggestedToolRefs).toContain("entity.read@1");
    expect(result.graph.subGoals[1]?.dependsOn).toEqual([result.graph.subGoals[0]?.goalId]);
  });

  it("条件型目标的模板分解会保留关键条件词", async () => {
    const params = createParams("先检查库存，如果充足就创建发货单");
    const result = await decomposeGoal(params);

    expect(invokeModelChat).not.toHaveBeenCalled();
    expect(result.graph.subGoals).toHaveLength(2);
    expect(result.graph.subGoals[0]?.postconditions.map((item) => item.description)).toContain("确认库存是否充足");
    expect(result.graph.subGoals[1]?.preconditions.map((item) => item.description)).toContain("库存充足");
  });
});
