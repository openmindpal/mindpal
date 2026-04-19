import { describe, it, expect } from "vitest";
import { createWorldState, createGoalGraph } from "@openslin/shared";
import { extractFromObservation, evaluateGoalConditions, buildWorldStateFromObservations } from "./worldStateExtractor";
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
