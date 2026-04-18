/**
 * P0-2 验证：GoalGraph DAG 验证 + WorldState 工具函数 + Verifier 解析测试
 */
import { describe, it, expect } from "vitest";
import {
  createGoalGraph,
  getExecutableSubGoals,
  computeGoalProgress,
  isGoalGraphComplete,
  validateGoalGraphDAG,
  topologicalSort,
} from "@openslin/shared";
import type { SubGoal, GoalGraph } from "@openslin/shared";
import {
  createWorldState,
  upsertEntity,
  addRelation,
  upsertFact,
  getValidFacts,
  getEntityRelations,
  getEntitiesByCategory,
  worldStateToPromptText,
} from "@openslin/shared";
import type { WorldEntity, WorldFact, WorldRelation } from "@openslin/shared";

/* ================================================================== */
/*  GoalGraph 基础函数                                                  */
/* ================================================================== */

describe("createGoalGraph", () => {
  it("创建空目标图", () => {
    const g = createGoalGraph("run-1", "完成部署");
    expect(g.runId).toBe("run-1");
    expect(g.mainGoal).toBe("完成部署");
    expect(g.subGoals).toEqual([]);
    expect(g.status).toBe("draft");
  });
});

describe("validateGoalGraphDAG", () => {
  function buildGraph(goals: Array<{ id: string; deps: string[] }>): GoalGraph {
    const g = createGoalGraph("run-test", "test");
    g.subGoals = goals.map(({ id, deps }) => ({
      goalId: id,
      parentGoalId: null,
      dependsOn: deps,
      description: `Goal ${id}`,
      preconditions: [],
      postconditions: [],
      successCriteria: [],
      completionEvidence: [],
      status: "pending" as const,
      priority: 5,
      estimatedComplexity: 3,
    }));
    return g;
  }

  it("合法 DAG 无错误", () => {
    const g = buildGraph([
      { id: "a", deps: [] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["a", "b"] },
    ]);
    const result = validateGoalGraphDAG(g);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("检测循环依赖", () => {
    const g = buildGraph([
      { id: "a", deps: ["c"] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["b"] },
    ]);
    const result = validateGoalGraphDAG(g);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("circular"))).toBe(true);
  });

  it("检测悬空引用", () => {
    const g = buildGraph([
      { id: "a", deps: ["non_existent"] },
    ]);
    const result = validateGoalGraphDAG(g);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("non-existent"))).toBe(true);
  });

  it("空目标图合法", () => {
    const g = createGoalGraph("run-empty", "empty");
    const result = validateGoalGraphDAG(g);
    expect(result.valid).toBe(true);
  });

  it("单节点无依赖合法", () => {
    const g = buildGraph([{ id: "solo", deps: [] }]);
    const result = validateGoalGraphDAG(g);
    expect(result.valid).toBe(true);
  });
});

describe("topologicalSort", () => {
  it("按依赖序返回", () => {
    const g = createGoalGraph("run-1", "test");
    g.subGoals = [
      { goalId: "b", parentGoalId: null, dependsOn: ["a"], description: "B", preconditions: [], postconditions: [], successCriteria: [], completionEvidence: [], status: "pending", priority: 5, estimatedComplexity: 3 },
      { goalId: "a", parentGoalId: null, dependsOn: [], description: "A", preconditions: [], postconditions: [], successCriteria: [], completionEvidence: [], status: "pending", priority: 5, estimatedComplexity: 3 },
      { goalId: "c", parentGoalId: null, dependsOn: ["b"], description: "C", preconditions: [], postconditions: [], successCriteria: [], completionEvidence: [], status: "pending", priority: 5, estimatedComplexity: 3 },
    ];
    const sorted = topologicalSort(g);
    expect(sorted.indexOf("a")).toBeLessThan(sorted.indexOf("b"));
    expect(sorted.indexOf("b")).toBeLessThan(sorted.indexOf("c"));
  });
});

describe("getExecutableSubGoals", () => {
  it("返回无依赖且 pending 的目标", () => {
    const g = createGoalGraph("run-1", "test");
    g.subGoals = [
      { goalId: "a", parentGoalId: null, dependsOn: [], description: "A", preconditions: [], postconditions: [], successCriteria: [], completionEvidence: [], status: "pending", priority: 5, estimatedComplexity: 3 },
      { goalId: "b", parentGoalId: null, dependsOn: ["a"], description: "B", preconditions: [], postconditions: [], successCriteria: [], completionEvidence: [], status: "pending", priority: 5, estimatedComplexity: 3 },
    ];
    const exe = getExecutableSubGoals(g);
    expect(exe.map((e) => e.goalId)).toContain("a");
    expect(exe.map((e) => e.goalId)).not.toContain("b");
  });
});

describe("computeGoalProgress / isGoalGraphComplete", () => {
  it("全部完成时进度为 1 且 isComplete", () => {
    const g = createGoalGraph("run-1", "test");
    g.subGoals = [
      { goalId: "a", parentGoalId: null, dependsOn: [], description: "A", preconditions: [], postconditions: [], successCriteria: [], completionEvidence: [], status: "completed", priority: 5, estimatedComplexity: 3 },
    ];
    expect(computeGoalProgress(g)).toBe(1);
    expect(isGoalGraphComplete(g)).toBe(true);
  });

  it("部分完成时进度介于 0-1", () => {
    const g = createGoalGraph("run-1", "test");
    g.subGoals = [
      { goalId: "a", parentGoalId: null, dependsOn: [], description: "A", preconditions: [], postconditions: [], successCriteria: [], completionEvidence: [], status: "completed", priority: 5, estimatedComplexity: 3 },
      { goalId: "b", parentGoalId: null, dependsOn: [], description: "B", preconditions: [], postconditions: [], successCriteria: [], completionEvidence: [], status: "pending", priority: 5, estimatedComplexity: 3 },
    ];
    const progress = computeGoalProgress(g);
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(1);
    expect(isGoalGraphComplete(g)).toBe(false);
  });
});

/* ================================================================== */
/*  WorldState 工具函数                                                 */
/* ================================================================== */

describe("createWorldState", () => {
  it("创建空世界状态", () => {
    const ws = createWorldState("run-1");
    expect(ws.runId).toBe("run-1");
    expect(Object.keys(ws.entities)).toHaveLength(0);
    expect(ws.relations).toHaveLength(0);
    expect(ws.facts).toHaveLength(0);
    expect(ws.version).toBe(1);
  });
});

describe("upsertEntity", () => {
  it("新增实体", () => {
    const ws = createWorldState("run-1");
    const entity: WorldEntity = {
      entityId: "e1", name: "配置文件", category: "resource",
      properties: { path: "/etc/config" }, state: "created",
      confidence: 0.9, discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const ws2 = upsertEntity(ws, entity);
    expect(ws2.entities["e1"]).toBeDefined();
    expect(ws2.entities["e1"].name).toBe("配置文件");
    expect(ws2.version).toBe(2);
  });

  it("更新已有实体（覆盖）", () => {
    let ws = createWorldState("run-1");
    const entity1: WorldEntity = {
      entityId: "e1", name: "文件v1", category: "resource",
      properties: {}, state: "created",
      confidence: 0.9, discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    ws = upsertEntity(ws, entity1);
    const entity2 = { ...entity1, name: "文件v2", state: "modified" };
    ws = upsertEntity(ws, entity2);
    expect(ws.entities["e1"].name).toBe("文件v2");
    expect(ws.entities["e1"].state).toBe("modified");
  });
});

describe("addRelation", () => {
  it("添加关系", () => {
    const ws = createWorldState("run-1");
    const rel: WorldRelation = {
      relationId: "rel-1", fromEntityId: "e1", toEntityId: "e2",
      type: "depends_on", confidence: 0.8, establishedAt: new Date().toISOString(),
    };
    const ws2 = addRelation(ws, rel);
    expect(ws2.relations).toHaveLength(1);
  });

  it("不重复添加相同关系", () => {
    let ws = createWorldState("run-1");
    const rel: WorldRelation = {
      relationId: "rel-1", fromEntityId: "e1", toEntityId: "e2",
      type: "depends_on", confidence: 0.8, establishedAt: new Date().toISOString(),
    };
    ws = addRelation(ws, rel);
    ws = addRelation(ws, { ...rel, relationId: "rel-2" }); // 同 from/to/type
    expect(ws.relations).toHaveLength(1);
  });
});

describe("upsertFact", () => {
  it("新增事实", () => {
    const ws = createWorldState("run-1");
    const fact: WorldFact = {
      factId: "f1", category: "observation", key: "deploy:status",
      statement: "部署成功", confidence: 1.0, valid: true,
      recordedAt: new Date().toISOString(),
    };
    const ws2 = upsertFact(ws, fact);
    expect(ws2.facts).toHaveLength(1);
  });

  it("同 key 事实覆盖（旧事实标记失效）", () => {
    let ws = createWorldState("run-1");
    const f1: WorldFact = {
      factId: "f1", category: "observation", key: "deploy:status",
      statement: "部署中", confidence: 0.8, valid: true,
      recordedAt: new Date().toISOString(),
    };
    ws = upsertFact(ws, f1);
    const f2: WorldFact = {
      factId: "f2", category: "observation", key: "deploy:status",
      statement: "部署完成", confidence: 1.0, valid: true,
      recordedAt: new Date().toISOString(),
    };
    ws = upsertFact(ws, f2);
    expect(ws.facts).toHaveLength(2);
    expect(ws.facts[0].valid).toBe(false); // 旧的标记失效
    expect(ws.facts[1].valid).toBe(true);  // 新的有效
  });
});

describe("getValidFacts", () => {
  it("只返回有效事实", () => {
    let ws = createWorldState("run-1");
    ws = upsertFact(ws, { factId: "f1", category: "observation", key: "k1", statement: "旧", confidence: 1, valid: true, recordedAt: new Date().toISOString() });
    ws = upsertFact(ws, { factId: "f2", category: "observation", key: "k1", statement: "新", confidence: 1, valid: true, recordedAt: new Date().toISOString() });
    const valid = getValidFacts(ws);
    expect(valid).toHaveLength(1);
    expect(valid[0].statement).toBe("新");
  });
});

describe("getEntityRelations", () => {
  it("返回实体关联的关系", () => {
    let ws = createWorldState("run-1");
    ws = addRelation(ws, { relationId: "r1", fromEntityId: "e1", toEntityId: "e2", type: "depends_on", confidence: 1, establishedAt: "" });
    ws = addRelation(ws, { relationId: "r2", fromEntityId: "e3", toEntityId: "e1", type: "contains", confidence: 1, establishedAt: "" });
    const rels = getEntityRelations(ws, "e1");
    expect(rels).toHaveLength(2);
  });
});

describe("getEntitiesByCategory", () => {
  it("按类别过滤实体", () => {
    let ws = createWorldState("run-1");
    ws = upsertEntity(ws, { entityId: "e1", name: "文件", category: "resource", properties: {}, state: "created", confidence: 1, discoveredAt: "", updatedAt: "" });
    ws = upsertEntity(ws, { entityId: "e2", name: "用户", category: "actor", properties: {}, state: "active", confidence: 1, discoveredAt: "", updatedAt: "" });
    expect(getEntitiesByCategory(ws, "resource")).toHaveLength(1);
    expect(getEntitiesByCategory(ws, "actor")).toHaveLength(1);
    expect(getEntitiesByCategory(ws, "artifact")).toHaveLength(0);
  });
});

describe("worldStateToPromptText", () => {
  it("生成 LLM 可读文本摘要", () => {
    let ws = createWorldState("run-1");
    ws = upsertEntity(ws, { entityId: "e1", name: "config.yaml", category: "resource", properties: { path: "/etc" }, state: "created", confidence: 1, discoveredAt: "", updatedAt: "" });
    ws = upsertFact(ws, { factId: "f1", category: "observation", key: "k1", statement: "系统正常运行", confidence: 1, valid: true, recordedAt: "" });
    const text = worldStateToPromptText(ws);
    expect(text).toContain("config.yaml");
    expect(text).toContain("Known Entities");
    expect(text).toContain("Known Facts");
    expect(text).toContain("系统正常运行");
  });

  it("超长文本截断", () => {
    const ws = createWorldState("run-1");
    const text = worldStateToPromptText(ws, 10);
    expect(text.length).toBeLessThanOrEqual(10);
  });
});

/* ================================================================== */
/*  validatePlanDAG — Plan 层 DAG 验证                                  */
/* ================================================================== */

import { validatePlanDAG } from "./goalDecomposer";

describe("validatePlanDAG", () => {
  it("合法 Plan DAG", () => {
    const steps = [
      { stepId: "s1", toolRef: "tool_a", dependsOn: [] },
      { stepId: "s2", toolRef: "tool_b", dependsOn: ["s1"] },
    ];
    const result = validatePlanDAG(steps as any);
    expect(result.valid).toBe(true);
  });

  it("检测 Plan 循环依赖", () => {
    const steps = [
      { stepId: "s1", toolRef: "tool_a", dependsOn: ["s2"] },
      { stepId: "s2", toolRef: "tool_b", dependsOn: ["s1"] },
    ];
    const result = validatePlanDAG(steps as any);
    expect(result.valid).toBe(false);
    expect(result.cycles).toBeDefined();
  });

  it("检测悬空依赖", () => {
    const steps = [
      { stepId: "s1", toolRef: "tool_a", dependsOn: ["s_missing"] },
    ];
    const result = validatePlanDAG(steps as any);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("non-existent"))).toBe(true);
  });

  it("检测资源冲突（同 toolRef 无依赖关系）", () => {
    const steps = [
      { stepId: "s1", toolRef: "tool_shared", dependsOn: [] },
      { stepId: "s2", toolRef: "tool_shared", dependsOn: [] },
    ];
    const result = validatePlanDAG(steps as any);
    // 两个使用同一 toolRef 且无依赖关系的步骤应被检测为资源冲突
    expect(result.resourceConflicts).toBeDefined();
    if (result.resourceConflicts) {
      expect(result.resourceConflicts.length).toBeGreaterThan(0);
    }
  });
});
