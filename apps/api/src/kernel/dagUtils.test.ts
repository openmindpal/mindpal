/**
 * TEST-02: dagUtils + taskDependencyResolver 单元测试
 *
 * 覆盖：DAG 验证 / 循环检测 / 拓扑排序 / 祖先后代 / 依赖创建 / 级联 / output 映射
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  validateDAG,
  topologicalSortGeneric as topologicalSort,
  wouldCreateCycle,
  getAncestors,
  getDescendants,
  type DagNode,
} from "@openslin/shared";

/* ================================================================== */
/*  dagUtils                                                           */
/* ================================================================== */

describe("dagUtils", () => {
  describe("validateDAG", () => {
    it("valid linear chain", () => {
      const nodes: DagNode[] = [
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["B"] },
      ];
      const result = validateDAG(nodes);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("detects circular dependency", () => {
      const nodes: DagNode[] = [
        { id: "A", dependsOn: ["C"] },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["B"] },
      ];
      const result = validateDAG(nodes);
      expect(result.valid).toBe(false);
      expect(result.cycles).toBeDefined();
      expect(result.cycles!.length).toBeGreaterThan(0);
    });

    it("detects dangling reference", () => {
      const nodes: DagNode[] = [
        { id: "A", dependsOn: ["GHOST"] },
      ];
      const result = validateDAG(nodes);
      expect(result.valid).toBe(false);
      expect(result.danglingRefs).toHaveLength(1);
      expect(result.danglingRefs![0].missingDep).toBe("GHOST");
    });

    it("detects isolated nodes", () => {
      const nodes: DagNode[] = [
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: [] }, // isolated
      ];
      const result = validateDAG(nodes);
      // A is not isolated because B depends on it
      // C is isolated (no in, no out relative to the graph)
      expect(result.isolatedNodes).toBeDefined();
      expect(result.isolatedNodes).toContain("C");
    });

    it("single node is always valid", () => {
      const result = validateDAG([{ id: "X", dependsOn: [] }]);
      expect(result.valid).toBe(true);
    });
  });

  describe("topologicalSort", () => {
    it("sorts a diamond DAG correctly", () => {
      const nodes: DagNode[] = [
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["A"] },
        { id: "D", dependsOn: ["B", "C"] },
      ];
      const sorted = topologicalSort(nodes);
      expect(sorted.indexOf("A")).toBeLessThan(sorted.indexOf("B"));
      expect(sorted.indexOf("A")).toBeLessThan(sorted.indexOf("C"));
      expect(sorted.indexOf("B")).toBeLessThan(sorted.indexOf("D"));
      expect(sorted.indexOf("C")).toBeLessThan(sorted.indexOf("D"));
    });

    it("respects priorityFn", () => {
      const nodes: DagNode[] = [
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: [] },
        { id: "C", dependsOn: [] },
      ];
      const sorted = topologicalSort(nodes, (id) => (id === "C" ? 0 : id === "A" ? 1 : 2));
      expect(sorted[0]).toBe("C");
      expect(sorted[1]).toBe("A");
      expect(sorted[2]).toBe("B");
    });
  });

  describe("wouldCreateCycle", () => {
    it("returns false for safe edge", () => {
      const nodes: DagNode[] = [
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: [] },
      ];
      expect(wouldCreateCycle(nodes, "C", "A")).toBe(false);
    });

    it("returns true for cycle-creating edge", () => {
      const nodes: DagNode[] = [
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["B"] },
      ];
      // Adding A depends on C would create: A → B → C → A
      expect(wouldCreateCycle(nodes, "A", "C")).toBe(true);
    });
  });

  describe("getAncestors", () => {
    it("returns all transitive ancestors", () => {
      const nodes: DagNode[] = [
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["B"] },
        { id: "D", dependsOn: ["C"] },
      ];
      const ancestors = getAncestors(nodes, "D");
      expect(ancestors).toEqual(new Set(["A", "B", "C"]));
    });
  });

  describe("getDescendants", () => {
    it("returns all transitive descendants", () => {
      const nodes: DagNode[] = [
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["A"] },
        { id: "D", dependsOn: ["B", "C"] },
      ];
      const desc = getDescendants(nodes, "A");
      expect(desc).toEqual(new Set(["B", "C", "D"]));
    });
  });
});

/* ================================================================== */
/*  TaskDependencyResolver (output mapping)                            */
/* ================================================================== */

describe("TaskDependencyResolver.applyOutputMapping", () => {
  let resolver: any;

  beforeEach(async () => {
    // Import only to test the applyOutputMapping method
    vi.doMock("./taskQueueRepo", () => ({
      getEntry: vi.fn(),
      insertDependency: vi.fn(),
      listActiveEntries: vi.fn(),
      listSessionDependencies: vi.fn(),
      updateDependencyStatus: vi.fn(),
      deleteDependency: vi.fn(),
      areAllDepsResolved: vi.fn(),
      resolveUpstreamDeps: vi.fn(),
      blockUpstreamDeps: vi.fn(),
      getCascadeCancelTargets: vi.fn(),
    }));
    const { TaskDependencyResolver } = await import("./taskDependencyResolver");
    resolver = new TaskDependencyResolver({} as any);
  });

  it("maps simple field", () => {
    const result = resolver.applyOutputMapping(
      { targetField: "sourceField" },
      { sourceField: "hello" },
    );
    expect(result).toEqual({ targetField: "hello" });
  });

  it("maps nested dot-path", () => {
    const result = resolver.applyOutputMapping(
      { url: "result.data.url" },
      { result: { data: { url: "https://example.com" } } },
    );
    expect(result).toEqual({ url: "https://example.com" });
  });

  it("maps wildcard * to entire output", () => {
    const output = { a: 1, b: 2 };
    const result = resolver.applyOutputMapping(
      { everything: "*" },
      output,
    );
    expect(result).toEqual({ everything: output });
  });

  it("skips missing paths gracefully", () => {
    const result = resolver.applyOutputMapping(
      { missing: "x.y.z" },
      { a: 1 },
    );
    expect(result).toEqual({});
  });
});
