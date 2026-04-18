import { describe, expect, it, beforeAll } from "vitest";
import {
  buildIntentDecision,
  intentDecisionToClassification,
  reviewIntentDecision,
  type IntentClassification,
} from "./intentClassifier";
import { _initVocabData } from "./intentVocabulary";

function createParams(message: string) {
  return {
    pool: {} as any,
    tenantId: "tenant-1",
    spaceId: "space-1",
    subjectId: "subject-1",
    message,
    locale: "zh-CN",
    authorization: null,
    traceId: "trace-1",
  };
}

describe("intentClassifier reviewer", () => {
  beforeAll(() => {
    // 初始化词表数据，测试环境不经过 initVocabLoader 启动流程
    _initVocabData({
      greetingWords: [],
      collabKeywords: [],
      highRiskKeywords: ["删除", "移除", "清空", "格式化", "重置", "销毁", "回滚", "drop", "delete", "remove", "destroy", "reset", "purge"],
    });
  });

  it("会把低置信高风险 execute 标记为需要确认", async () => {
    const reviewed = await reviewIntentDecision(
      createParams("删除这条记录"),
      {
        mode: "execute",
        confidence: 0.72,
        reason: "two_level_override",
        needsTask: true,
        needsApproval: false,
        complexity: "moderate",
        classifierUsed: "two_level",
      },
    );

    expect(reviewed.classifierUsed).toBe("reviewer");
    expect(reviewed.needsConfirmation).toBe(true);
    expect(reviewed.riskLevel).toBe("high");
  });

  it("低置信 answer 的动作请求保持 two_level 分类器标记（低置信复判已迁移至 LLM）", async () => {
    const reviewed = await reviewIntentDecision(
      createParams("帮我发个通知给全员"),
      {
        mode: "answer",
        confidence: 0.45,
        reason: "uncertain_answer",
        needsTask: false,
        needsApproval: false,
        complexity: "simple",
        classifierUsed: "two_level",
      },
    );

    const classification = intentDecisionToClassification(reviewed);
    // 低置信 answer 复判已迁移至 LLM（reviewIntentDecision 不再做正则旁路检查）
    // classifierUsed 保持原始分类器标记
    expect(reviewed.classifierUsed).toBe("two_level");
    expect(classification.mode).toBe("answer");
  });

  it("统一模型和旧分类结构能双向映射", () => {
    const classification: IntentClassification = {
      mode: "execute",
      confidence: 0.9,
      reason: "request_prefix_detected",
      needsTask: true,
      needsApproval: true,
      complexity: "moderate",
    };

    const decision = buildIntentDecision(classification, {
      classifierUsed: "reviewer",
      featureSummary: ["request_prefix_detected", "reviewer:high_risk_execute_flagged"],
    });
    const restored = intentDecisionToClassification(decision);

    expect(decision.primary).toBe("immediate_action");
    expect(decision.secondary).toBe("write_task");
    expect(restored.mode).toBe("execute");
    expect(restored.needsApproval).toBe(true);
  });
});
