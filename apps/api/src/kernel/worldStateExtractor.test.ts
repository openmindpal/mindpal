import { describe, it, expect } from "vitest";
import {
  createWorldState, createGoalGraph,
  upsertEntity, addRelation, upsertFact,
  batchUpsertEntities, batchAddRelations,
  findEntityByName, findFactByKey, ensureIndexes,
  detectWorldStateConflicts,
  type WorldEntity, type WorldRelation, type WorldFact,
} from "@openslin/shared";
import { extractFromObservation, evaluateGoalConditions, buildWorldStateFromObservations, extractWorldState } from "./worldStateExtractor";
import type { StepObservation } from "./loopTypes";

/* ── Helpers ──────────────────────────────────────────────────── */

const TEST_RUN_ID = "run-test-ws";

function makeObs(partial: Partial<StepObservation> & { seq: number; toolRef: string }): StepObservation {
  return {
    stepId: `step-${partial.seq}`,
    status: "succeeded",
    output: {},
    outputDigest: {},
    errorCategory: null,
    durationMs: 100,
    ...partial,
  } as StepObservation;
}

/* ================================================================== */
/*  extractFromObservation                                              */
/* ================================================================== */

describe("extractFromObservation", () => {
  it("should record a fact for any observation", () => {
    const state = createWorldState(TEST_RUN_ID);
    const obs = makeObs({ seq: 1, toolRef: "echo@1.0", status: "succeeded" });
    const next = extractFromObservation(obs, state);

    expect(next.facts.length).toBeGreaterThanOrEqual(1);
    const fact = next.facts.find((f) => f.key === "step:1:result");
    expect(fact).toBeDefined();
    expect(fact!.statement).toContain("echo@1.0");
    expect(fact!.statement).toContain("succeeded");
  });

  it("should only record fact (no entity) for failed steps", () => {
    const state = createWorldState(TEST_RUN_ID);
    const obs = makeObs({
      seq: 2,
      toolRef: "entity.create@1.0",
      status: "failed",
      errorCategory: "timeout",
    });
    const next = extractFromObservation(obs, state);

    expect(next.facts.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(next.entities).length).toBe(0);
    const fact = next.facts.find((f) => f.key === "step:2:result");
    expect(fact!.statement).toContain("timeout");
  });

  it("should extract entity from entity.create tool output", () => {
    const state = createWorldState(TEST_RUN_ID);
    const obs = makeObs({
      seq: 3,
      toolRef: "entity.create@1.0",
      status: "succeeded",
      output: { id: "ent-123", name: "Test Entity", type: "project" },
    });
    const next = extractFromObservation(obs, state);

    const entities = Object.values(next.entities);
    expect(entities.length).toBeGreaterThanOrEqual(1);
    const entity = entities.find((e) => e.name === "Test Entity");
    expect(entity).toBeDefined();
    expect(entity!.name).toBe("Test Entity");
  });

  it("should extract memory entry from memory.write output", () => {
    const state = createWorldState(TEST_RUN_ID);
    const obs = makeObs({
      seq: 4,
      toolRef: "memory.write@1.0",
      status: "succeeded",
      output: { memoryId: "mem-001", content: "user preference saved" },
    });
    const next = extractFromObservation(obs, state);

    // Should have created an entity for the memory write
    const entities = Object.values(next.entities);
    const memEntity = entities.find((e) => e.entityId === "memory:mem-001");
    expect(memEntity).toBeDefined();
    // Should also have the step result fact
    expect(next.facts.length).toBeGreaterThanOrEqual(1);
  });

  it("should extract knowledge from knowledge.search output", () => {
    const state = createWorldState(TEST_RUN_ID);
    const obs = makeObs({
      seq: 5,
      toolRef: "knowledge.search@1.0",
      status: "succeeded",
      output: { results: [{ chunkId: "c1", text: "relevant info" }], totalCount: 1 },
    });
    const next = extractFromObservation(obs, state);

    const kFacts = next.facts.filter((f) => f.key.includes("knowledge"));
    expect(kFacts.length).toBeGreaterThanOrEqual(1);
  });

  it("should increment version and afterStepSeq", () => {
    const state = createWorldState(TEST_RUN_ID);
    const obs = makeObs({ seq: 7, toolRef: "echo@1.0" });
    const next = extractFromObservation(obs, state);

    expect(next.version).toBeGreaterThan(state.version);
    expect(next.afterStepSeq).toBe(7);
  });

  it("should handle empty output gracefully", () => {
    const state = createWorldState(TEST_RUN_ID);
    const obs = makeObs({
      seq: 8,
      toolRef: "unknown-tool@1.0",
      status: "succeeded",
      output: undefined as any,
      outputDigest: undefined as any,
    });
    // Should not throw
    const next = extractFromObservation(obs, state);
    expect(next.facts.length).toBeGreaterThanOrEqual(1);
  });
});

/* ================================================================== */
/*  buildWorldStateFromObservations                                     */
/* ================================================================== */

describe("buildWorldStateFromObservations", () => {
  it("should accumulate state from multiple observations", () => {
    const observations: StepObservation[] = [
      makeObs({ seq: 1, toolRef: "entity.create@1.0", output: { id: "e1", name: "Obj1" } }),
      makeObs({ seq: 2, toolRef: "entity.update@1.0", output: { id: "e1", name: "Obj1-updated" } }),
      makeObs({ seq: 3, toolRef: "knowledge.search@1.0", output: { results: [] } }),
    ];

    const state = buildWorldStateFromObservations(TEST_RUN_ID, observations);
    expect(state.facts.length).toBeGreaterThanOrEqual(3);
    expect(state.afterStepSeq).toBe(3);
    expect(state.version).toBeGreaterThanOrEqual(3);
  });

  it("should return empty state for no observations", () => {
    const state = buildWorldStateFromObservations(TEST_RUN_ID, []);
    expect(Object.keys(state.entities).length).toBe(0);
    expect(state.facts.length).toBe(0);
  });
});

/* ================================================================== */
/*  evaluateGoalConditions                                              */
/* ================================================================== */

describe("evaluateGoalConditions", () => {
  it("should evaluate goal conditions against world state", () => {
    // Build a state with some facts
    const state = createWorldState(TEST_RUN_ID);
    const obs = makeObs({
      seq: 1,
      toolRef: "entity.create@1.0",
      status: "succeeded",
      output: { id: "e1", name: "Report" },
    });
    const populated = extractFromObservation(obs, state);

    // Create a goal graph with a condition
    const goalGraph = createGoalGraph(TEST_RUN_ID, "Create a report");
    goalGraph.subGoals = [
      {
        goalId: "g1",
        parentGoalId: null,
        description: "Create report entity",
        status: "in_progress" as const,
        dependsOn: [],
        preconditions: [{ description: "Entity created", satisfied: false }],
        postconditions: [{ description: "Report entity exists in world state" }],
        successCriteria: [{ criterionId: "sc1", description: "Report entity exists", weight: 1, required: true }],
        completionEvidence: [],
        priority: 5,
      },
    ];

    const result = evaluateGoalConditions(goalGraph, populated);
    // Should return a goal graph (possibly with updated conditions)
    expect(result).toBeDefined();
    expect(result.subGoals.length).toBe(1);
  });
});

/* ================================================================== */
/*  relation auto-extraction                                            */
/* ================================================================== */

describe("relation auto-extraction", () => {
  /** 构建包含 Agent 实体的初始状态（extractFromObservation 中 addAgentRelation 需要） */
  function stateWithAgent(): ReturnType<typeof createWorldState> {
    const s = createWorldState(TEST_RUN_ID);
    return upsertEntity(s, {
      entityId: "actor:agent",
      name: "Agent",
      category: "actor",
      properties: {},
      state: "active",
      confidence: 1.0,
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  it("entity.create should produce a 'produces' relation from Agent", () => {
    const state = stateWithAgent();
    const obs = makeObs({
      seq: 1,
      toolRef: "entity.create@1.0",
      status: "succeeded",
      output: { id: "ent-1", name: "NewEntity", type: "resource" },
    });
    const next = extractFromObservation(obs, state);

    const rel = next.relations.find(
      (r) => r.fromEntityId === "actor:agent" && r.toEntityId === "ent-1",
    );
    expect(rel).toBeDefined();
    expect(rel!.type).toBe("produces");
  });

  it("entity.update should produce a 'modifies' relation from Agent", () => {
    const state = stateWithAgent();
    const obs = makeObs({
      seq: 2,
      toolRef: "entity.update@1.0",
      status: "succeeded",
      output: { id: "ent-2", name: "UpdatedEntity" },
    });
    const next = extractFromObservation(obs, state);

    const rel = next.relations.find(
      (r) => r.fromEntityId === "actor:agent" && r.toEntityId === "ent-2",
    );
    expect(rel).toBeDefined();
    expect(rel!.type).toBe("modifies");
  });

  it("memory.write should produce a relation from Agent to memory entity", () => {
    const state = stateWithAgent();
    const obs = makeObs({
      seq: 3,
      toolRef: "memory.write@1.0",
      status: "succeeded",
      output: { memoryId: "mem-100", content: "saved" },
    });
    const next = extractFromObservation(obs, state);

    const rel = next.relations.find(
      (r) =>
        r.fromEntityId === "actor:agent" && r.toEntityId === "memory:mem-100",
    );
    expect(rel).toBeDefined();
  });
});

/* ================================================================== */
/*  evaluateCondition - relation_holds                                  */
/* ================================================================== */

describe("evaluateCondition - relation_holds", () => {
  function buildStateWithRelation(): ReturnType<typeof createWorldState> {
    let s = createWorldState(TEST_RUN_ID);
    s = upsertEntity(s, {
      entityId: "e-a", name: "A", category: "resource", properties: {},
      state: "active", confidence: 1, discoveredAt: "", updatedAt: "",
    });
    s = upsertEntity(s, {
      entityId: "e-b", name: "B", category: "resource", properties: {},
      state: "active", confidence: 1, discoveredAt: "", updatedAt: "",
    });
    s = addRelation(s, {
      relationId: "rel-1", fromEntityId: "e-a", toEntityId: "e-b",
      type: "produces", confidence: 1, establishedAt: "",
    });
    return s;
  }

  it("should return true when matching relation exists", () => {
    const state = buildStateWithRelation();
    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g1", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [{
        description: "A produces B",
        assertionType: "relation_holds" as const,
        assertionParams: { fromEntity: "A", toEntity: "B", type: "produces" },
      }],
      postconditions: [],
      successCriteria: [],
      completionEvidence: [],
      priority: 5,
    }];
    const result = evaluateGoalConditions(goal, state);
    expect(result.subGoals[0].preconditions[0].satisfied).toBe(true);
  });

  it("should return false when relation does not exist", () => {
    const state = buildStateWithRelation();
    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g2", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [{
        description: "X produces Y",
        assertionType: "relation_holds" as const,
        assertionParams: { fromEntity: "X", toEntity: "Y", type: "produces" },
      }],
      postconditions: [],
      successCriteria: [],
      completionEvidence: [],
      priority: 5,
    }];
    const result = evaluateGoalConditions(goal, state);
    expect(result.subGoals[0].preconditions[0].satisfied).toBe(false);
  });

  it("should return false when relation type does not match", () => {
    const state = buildStateWithRelation();
    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g3", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [{
        description: "A modifies B",
        assertionType: "relation_holds" as const,
        assertionParams: { fromEntity: "A", toEntity: "B", type: "modifies" },
      }],
      postconditions: [],
      successCriteria: [],
      completionEvidence: [],
      priority: 5,
    }];
    const result = evaluateGoalConditions(goal, state);
    expect(result.subGoals[0].preconditions[0].satisfied).toBe(false);
  });
});

/* ================================================================== */
/*  batch operations                                                    */
/* ================================================================== */

describe("batch operations", () => {
  const now = new Date().toISOString();
  const makeEntity = (id: string, name: string): WorldEntity => ({
    entityId: id, name, category: "resource", properties: {},
    state: "active", confidence: 1, discoveredAt: now, updatedAt: now,
  });
  const makeRelation = (id: string, from: string, to: string, type: "produces" | "modifies"): WorldRelation => ({
    relationId: id, fromEntityId: from, toEntityId: to, type,
    confidence: 1, establishedAt: now,
  });

  it("batchUpsertEntities should insert multiple entities at once", () => {
    const state = createWorldState(TEST_RUN_ID);
    const entities = [makeEntity("e1", "Ent1"), makeEntity("e2", "Ent2"), makeEntity("e3", "Ent3")];
    const next = batchUpsertEntities(state, entities);

    expect(Object.keys(next.entities).length).toBe(3);
    expect(next.entities["e1"]?.name).toBe("Ent1");
    expect(next.entities["e3"]?.name).toBe("Ent3");
  });

  it("batchAddRelations should deduplicate and add in bulk", () => {
    let state = createWorldState(TEST_RUN_ID);
    state = batchUpsertEntities(state, [makeEntity("a", "A"), makeEntity("b", "B")]);
    // 添加两条相同的关系 + 一条不同的关系
    const rels = [
      makeRelation("r1", "a", "b", "produces"),
      makeRelation("r2", "a", "b", "produces"), // duplicate
      makeRelation("r3", "b", "a", "modifies"),  // unique
    ];
    const next = batchAddRelations(state, rels);

    expect(next.relations.length).toBe(2);
  });

  it("batchUpsertEntities should maintain _entityNameIdx", () => {
    const state = createWorldState(TEST_RUN_ID);
    const entities = [makeEntity("e1", "Alpha"), makeEntity("e2", "Beta")];
    const next = batchUpsertEntities(state, entities);

    expect(next._entityNameIdx).toBeDefined();
    expect(next._entityNameIdx!["Alpha"]).toBe("e1");
    expect(next._entityNameIdx!["Beta"]).toBe("e2");
  });
});

/* ================================================================== */
/*  buildWorldStateFromObservations skip logic                          */
/* ================================================================== */

describe("buildWorldStateFromObservations skip logic", () => {
  it("should only process observations with seq > existingState.afterStepSeq", () => {
    // 构建 existingState，afterStepSeq=5
    let existing = createWorldState(TEST_RUN_ID);
    existing = { ...existing, afterStepSeq: 5 };

    const observations = [
      makeObs({ seq: 3, toolRef: "echo@1.0" }),
      makeObs({ seq: 5, toolRef: "echo@1.0" }),
      makeObs({ seq: 7, toolRef: "echo@1.0" }),
      makeObs({ seq: 9, toolRef: "echo@1.0" }),
    ];

    const state = buildWorldStateFromObservations(TEST_RUN_ID, observations, existing);

    // seq 3 和 5 应被跳过，只处理 7 和 9
    // 每个 obs 至少产生一个 step:N:result 事实
    const processedFacts = state.facts.filter((f) => f.key.startsWith("step:"));
    const processedSeqs = processedFacts.map((f) => {
      const m = f.key.match(/^step:(\d+):result$/);
      return m ? Number(m[1]) : 0;
    }).filter(Boolean);

    expect(processedSeqs).not.toContain(3);
    expect(processedSeqs).not.toContain(5);
    expect(processedSeqs).toContain(7);
    expect(processedSeqs).toContain(9);
  });

  it("should set afterStepSeq to the max seq of processed observations", () => {
    let existing = createWorldState(TEST_RUN_ID);
    existing = { ...existing, afterStepSeq: 5 };

    const observations = [
      makeObs({ seq: 3, toolRef: "echo@1.0" }),
      makeObs({ seq: 7, toolRef: "echo@1.0" }),
      makeObs({ seq: 9, toolRef: "echo@1.0" }),
    ];

    const state = buildWorldStateFromObservations(TEST_RUN_ID, observations, existing);
    expect(state.afterStepSeq).toBe(9);
  });
});

/* ================================================================== */
/*  conflict fact category                                              */
/* ================================================================== */

describe("conflict fact category", () => {
  it("detectWorldStateConflicts should identify disagreeing sources", () => {
    const entries = [
      { key: "temperature", value: 25, source: "sensor" as const, confidence: 0.8, timestamp: Date.now() },
      { key: "temperature", value: 30, source: "user_input" as const, confidence: 0.9, timestamp: Date.now() },
      { key: "humidity", value: 60, source: "sensor" as const, confidence: 1, timestamp: Date.now() },
    ];
    const conflicts = detectWorldStateConflicts(entries);

    expect(conflicts.length).toBe(1);
    expect(conflicts[0].key).toBe("temperature");
    expect(conflicts[0].resolved).toBe(false);
    expect(conflicts[0].entries.length).toBe(2);
  });

  it("FactCategory 'conflict' should be assignable via upsertFact", () => {
    let state = createWorldState(TEST_RUN_ID);
    state = upsertFact(state, {
      factId: "cf-1",
      category: "conflict",
      key: "conflict:temp",
      statement: "Conflict on temperature",
      confidence: 1,
      valid: true,
      recordedAt: new Date().toISOString(),
    });

    const cf = state.facts.find((f) => f.category === "conflict");
    expect(cf).toBeDefined();
    expect(cf!.category).toBe("conflict");
  });
});

/* ================================================================== */
/*  index functions                                                     */
/* ================================================================== */

describe("index functions", () => {
  const now = new Date().toISOString();

  function buildPopulatedState() {
    let s = createWorldState(TEST_RUN_ID);
    s = upsertEntity(s, {
      entityId: "e-x", name: "Xray", category: "resource", properties: {},
      state: "active", confidence: 1, discoveredAt: now, updatedAt: now,
    });
    s = upsertEntity(s, {
      entityId: "e-y", name: "Yankee", category: "artifact", properties: {},
      state: "active", confidence: 1, discoveredAt: now, updatedAt: now,
    });
    s = upsertFact(s, {
      factId: "f1", category: "observation", key: "temp:high",
      statement: "Temperature is high", confidence: 1, valid: true, recordedAt: now,
    });
    s = upsertFact(s, {
      factId: "f2", category: "observation", key: "status:ok",
      statement: "Status is OK", confidence: 1, valid: true, recordedAt: now,
    });
    return s;
  }

  it("findEntityByName should find entity via index (O(1))", () => {
    const state = buildPopulatedState();
    expect(state._entityNameIdx).toBeDefined();
    const found = findEntityByName(state, "Xray");
    expect(found).toBeDefined();
    expect(found!.entityId).toBe("e-x");
  });

  it("findEntityByName should fallback to linear scan without index", () => {
    const state = buildPopulatedState();
    // 移除索引
    const noIdx = { ...state, _entityNameIdx: undefined };
    const found = findEntityByName(noIdx, "Yankee");
    expect(found).toBeDefined();
    expect(found!.entityId).toBe("e-y");
  });

  it("findFactByKey should return correct fact via index", () => {
    const state = buildPopulatedState();
    const fact = findFactByKey(state, "temp:high");
    expect(fact).toBeDefined();
    expect(fact!.statement).toBe("Temperature is high");
  });

  it("findFactByKey should return undefined for non-existent key", () => {
    const state = buildPopulatedState();
    const fact = findFactByKey(state, "does:not:exist");
    expect(fact).toBeUndefined();
  });

  it("ensureIndexes should build complete indexes", () => {
    const state = buildPopulatedState();
    // 先去掉索引
    const noIdx = { ...state, _entityNameIdx: undefined, _factKeyIdx: undefined };
    const indexed = ensureIndexes(noIdx);

    expect(indexed._entityNameIdx).toBeDefined();
    expect(indexed._entityNameIdx!["Xray"]).toBe("e-x");
    expect(indexed._entityNameIdx!["Yankee"]).toBe("e-y");
    expect(indexed._factKeyIdx).toBeDefined();
    expect(typeof indexed._factKeyIdx!["temp:high"]).toBe("number");
    expect(typeof indexed._factKeyIdx!["status:ok"]).toBe("number");
  });
});

/* ================================================================== */
/*  evaluateCondition - regex_match                                     */
/* ================================================================== */

describe("evaluateCondition - regex_match", () => {
  const now = new Date().toISOString();

  it("should match entity property value against regex", () => {
    let state = createWorldState(TEST_RUN_ID);
    state = upsertEntity(state, {
      entityId: "e1", name: "Report", category: "artifact",
      properties: { format: "PDF-v2.1" },
      state: "active", confidence: 1, discoveredAt: now, updatedAt: now,
    });
    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g1", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [{
        description: "Format is PDF",
        assertionType: "regex_match" as const,
        assertionParams: { entityName: "Report", property: "format", pattern: "^PDF" },
      }],
      postconditions: [], successCriteria: [], completionEvidence: [], priority: 5, edgeType: "sequential" as const,
    }];
    const result = evaluateGoalConditions(goal, state);
    expect(result.subGoals[0].preconditions[0].satisfied).toBe(true);
  });

  it("should return false when regex does not match", () => {
    let state = createWorldState(TEST_RUN_ID);
    state = upsertEntity(state, {
      entityId: "e1", name: "Report", category: "artifact",
      properties: { format: "DOCX" },
      state: "active", confidence: 1, discoveredAt: now, updatedAt: now,
    });
    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g1", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [{
        description: "Format is PDF",
        assertionType: "regex_match" as const,
        assertionParams: { entityName: "Report", property: "format", pattern: "^PDF" },
      }],
      postconditions: [], successCriteria: [], completionEvidence: [], priority: 5,
    }];
    const result = evaluateGoalConditions(goal, state);
    expect(result.subGoals[0].preconditions[0].satisfied).toBe(false);
  });

  it("should match against fact value by factKey", () => {
    let state = createWorldState(TEST_RUN_ID);
    state = upsertFact(state, {
      factId: "f1", category: "observation", key: "output:format",
      statement: "Output format is JSON", value: "application/json",
      confidence: 1, valid: true, recordedAt: now,
    });
    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g1", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [{
        description: "Output is JSON",
        assertionType: "regex_match" as const,
        assertionParams: { factKey: "output:format", pattern: "json$" },
      }],
      postconditions: [], successCriteria: [], completionEvidence: [], priority: 5, edgeType: "sequential" as const,
    }];
    const result = evaluateGoalConditions(goal, state);
    expect(result.subGoals[0].preconditions[0].satisfied).toBe(true);
  });
});

/* ================================================================== */
/*  evaluateCondition - numeric_range                                   */
/* ================================================================== */

describe("evaluateCondition - numeric_range", () => {
  const now = new Date().toISOString();

  it("should return true when value is within range", () => {
    let state = createWorldState(TEST_RUN_ID);
    state = upsertEntity(state, {
      entityId: "sensor1", name: "Thermometer", category: "external",
      properties: { temperature: 25 },
      state: "active", confidence: 1, discoveredAt: now, updatedAt: now,
    });
    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g1", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [{
        description: "Temperature in range",
        assertionType: "numeric_range" as const,
        assertionParams: { entityName: "Thermometer", property: "temperature", min: 20, max: 30 },
      }],
      postconditions: [], successCriteria: [], completionEvidence: [], priority: 5, edgeType: "sequential" as const,
    }];
    const result = evaluateGoalConditions(goal, state);
    expect(result.subGoals[0].preconditions[0].satisfied).toBe(true);
  });

  it("should return false when value is outside range", () => {
    let state = createWorldState(TEST_RUN_ID);
    state = upsertEntity(state, {
      entityId: "sensor1", name: "Thermometer", category: "external",
      properties: { temperature: 35 },
      state: "active", confidence: 1, discoveredAt: now, updatedAt: now,
    });
    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g1", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [{
        description: "Temperature in range",
        assertionType: "numeric_range" as const,
        assertionParams: { entityName: "Thermometer", property: "temperature", min: 20, max: 30 },
      }],
      postconditions: [], successCriteria: [], completionEvidence: [], priority: 5, edgeType: "sequential" as const,
    }];
    const result = evaluateGoalConditions(goal, state);
    expect(result.subGoals[0].preconditions[0].satisfied).toBe(false);
  });
});

/* ================================================================== */
/*  evaluateSuccessCriterion - threshold strategy                       */
/* ================================================================== */

describe("evaluateSuccessCriterion - threshold strategy", () => {
  it("threshold strategy should pass when ratio meets thresholdValue", () => {
    // 构建含多个成功事实的 state
    let state = createWorldState(TEST_RUN_ID);
    state = upsertFact(state, {
      factId: "f1", category: "observation", key: "s1",
      statement: "Step alpha succeeded with beta output",
      confidence: 1, valid: true, recordedAt: new Date().toISOString(),
    });

    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g1", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [], postconditions: [],
      successCriteria: [{
        criterionId: "sc1",
        description: "alpha beta gamma delta",
        weight: 1, required: true,
        strategy: "threshold" as const,
        thresholdValue: 0.5,
      }],
      completionEvidence: [], priority: 5, edgeType: "sequential" as const,
    }];
    const result = evaluateGoalConditions(goal, state);
    // "alpha" 和 "beta" 匹配 (2/4 = 0.5)，满足 threshold=0.5
    expect(result.subGoals[0].successCriteria[0].met).toBe(true);
  });

  it("threshold strategy should fail when ratio below thresholdValue", () => {
    let state = createWorldState(TEST_RUN_ID);
    state = upsertFact(state, {
      factId: "f1", category: "observation", key: "s1",
      statement: "Step alpha succeeded",
      confidence: 1, valid: true, recordedAt: new Date().toISOString(),
    });

    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g1", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [], postconditions: [],
      successCriteria: [{
        criterionId: "sc2",
        description: "alpha beta gamma delta",
        weight: 1, required: true,
        strategy: "threshold" as const,
        thresholdValue: 0.8,
      }],
      completionEvidence: [], priority: 5, edgeType: "sequential" as const,
    }];
    const result = evaluateGoalConditions(goal, state);
    // "alpha" 匹配 (1/4 = 0.25)，不满足 threshold=0.8
    expect(result.subGoals[0].successCriteria[0].met).toBe(false);
  });

  it("any strategy should pass if any keyword matches", () => {
    let state = createWorldState(TEST_RUN_ID);
    state = upsertFact(state, {
      factId: "f1", category: "observation", key: "s1",
      statement: "Step alpha succeeded",
      confidence: 1, valid: true, recordedAt: new Date().toISOString(),
    });

    const goal = createGoalGraph(TEST_RUN_ID, "test");
    goal.subGoals = [{
      goalId: "g1", parentGoalId: null, description: "test",
      status: "in_progress" as const, dependsOn: [],
      preconditions: [], postconditions: [],
      successCriteria: [{
        criterionId: "sc3",
        description: "alpha beta gamma",
        weight: 1, required: true,
        strategy: "any" as const,
      }],
      completionEvidence: [], priority: 5, edgeType: "sequential" as const,
    }];
    const result = evaluateGoalConditions(goal, state);
    expect(result.subGoals[0].successCriteria[0].met).toBe(true);
  });
});
