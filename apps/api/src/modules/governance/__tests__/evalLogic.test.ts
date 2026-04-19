import { describe, it, expect } from "vitest";
import {
  evalPassed,
  computeEvalSummary,
  evalPassedWithCategories,
  isEvalRunStale,
  buildEvalGateReport,
  type EvalThresholds,
  type EvalRunSummary,
} from "../evalLogic";

describe("governance/evalLogic", () => {
  /* ── evalPassed ── */
  describe("evalPassed", () => {
    it("should pass when passRate >= min and denyRate <= max", () => {
      expect(evalPassed({ thresholds: { passRateMin: 0.8, denyRateMax: 0.1 }, summary: { passRate: 0.9, denyRate: 0.05 } })).toBe(true);
    });

    it("should fail when passRate < min", () => {
      expect(evalPassed({ thresholds: { passRateMin: 0.8 }, summary: { passRate: 0.7 } })).toBe(false);
    });

    it("should fail when denyRate > max", () => {
      expect(evalPassed({ thresholds: { denyRateMax: 0.05 }, summary: { passRate: 1, denyRate: 0.1 } })).toBe(false);
    });

    it("should default passRateMin to 1 when not provided", () => {
      expect(evalPassed({ thresholds: {}, summary: { passRate: 0.99 } })).toBe(false);
      expect(evalPassed({ thresholds: {}, summary: { passRate: 1 } })).toBe(true);
    });

    it("should default denyRateMax to 1 when not provided", () => {
      expect(evalPassed({ thresholds: {}, summary: { passRate: 1, denyRate: 0.5 } })).toBe(true);
    });

    it("should handle null thresholds and summary", () => {
      // passRate defaults to 0 < passRateMin default 1 → fail
      expect(evalPassed({ thresholds: null, summary: null })).toBe(false);
    });

    it("should handle exact boundary values", () => {
      expect(evalPassed({ thresholds: { passRateMin: 0.8, denyRateMax: 0.1 }, summary: { passRate: 0.8, denyRate: 0.1 } })).toBe(true);
    });
  });

  /* ── computeEvalSummary ── */
  describe("computeEvalSummary", () => {
    it("should count passed/denied/failed cases", () => {
      const cases = [
        { passed: true },
        { deny: true },
        { fail: true },
        { passed: true },
      ];
      const result = computeEvalSummary({ casesJson: cases, thresholds: { passRateMin: 0.3 }, reportDigest8: "abc12345" });
      expect(result.totalCases).toBe(4);
      expect(result.passedCases).toBe(2);
      expect(result.deniedCases).toBe(1);
      expect(result.failedCases).toBe(1);
      expect(result.passRate).toBe(0.5);
      expect(result.denyRate).toBe(0.25);
      expect(result.reportDigest8).toBe("abc12345");
    });

    it("should mark result as pass when thresholds met", () => {
      const cases = [{ passed: true }, { passed: true }];
      const result = computeEvalSummary({ casesJson: cases, thresholds: { passRateMin: 0.5 }, reportDigest8: "x" });
      expect(result.result).toBe("pass");
    });

    it("should mark result as fail when thresholds not met", () => {
      const cases = [{ deny: true }, { fail: true }];
      const result = computeEvalSummary({ casesJson: cases, thresholds: { passRateMin: 0.5 }, reportDigest8: "x" });
      expect(result.result).toBe("fail");
    });

    it("should handle empty cases", () => {
      const result = computeEvalSummary({ casesJson: [], thresholds: null, reportDigest8: "x" });
      expect(result.totalCases).toBe(0);
      expect(result.passRate).toBe(0);
    });

    it("should detect deny via expectedConstraints.outcome", () => {
      const cases = [{ expectedConstraints: { outcome: "deny" } }];
      const result = computeEvalSummary({ casesJson: cases, thresholds: { passRateMin: 0 }, reportDigest8: "x" });
      expect(result.deniedCases).toBe(1);
    });

    it("should detect fail via expectedConstraints.fail", () => {
      const cases = [{ expectedConstraints: { fail: true } }];
      const result = computeEvalSummary({ casesJson: cases, thresholds: null, reportDigest8: "x" });
      expect(result.failedCases).toBe(1);
    });

    it("should respect sealRequired threshold", () => {
      const cases = [
        { sealStatus: "sealed" },
        { sealStatus: "not_sealed" },
      ];
      const result = computeEvalSummary({ casesJson: cases, thresholds: { sealRequired: true, passRateMin: 0 }, reportDigest8: "x" });
      // "sealed" → not deny, "not_sealed" → deny
      expect(result.deniedCases).toBe(1);
      expect(result.passedCases).toBe(1);
    });

    it("should include thresholds in result", () => {
      const result = computeEvalSummary({ casesJson: [], thresholds: { passRateMin: 0.9, denyRateMax: 0.05 }, reportDigest8: "x" });
      expect(result.thresholds).toEqual({ passRateMin: 0.9, denyRateMax: 0.05 });
    });
  });

  /* ── evalPassedWithCategories ── */
  describe("evalPassedWithCategories", () => {
    it("should pass when global and all categories pass", () => {
      const result = evalPassedWithCategories({
        thresholds: { passRateMin: 0.8, categoryThresholds: { intent: { passRateMin: 0.9 } } },
        summary: { passRate: 0.9, categoryBreakdown: { intent: { total: 10, passed: 9, passRate: 0.9 } } },
      });
      expect(result.passed).toBe(true);
      expect(result.failedCategories).toHaveLength(0);
    });

    it("should fail when a category threshold not met", () => {
      const result = evalPassedWithCategories({
        thresholds: { passRateMin: 0.5, categoryThresholds: { intent: { passRateMin: 0.9 } } },
        summary: { passRate: 0.8, categoryBreakdown: { intent: { total: 10, passed: 7, passRate: 0.7 } } },
      });
      expect(result.passed).toBe(false);
      expect(result.failedCategories).toContain("intent");
    });

    it("should fail when category data is missing", () => {
      const result = evalPassedWithCategories({
        thresholds: { passRateMin: 0.5, categoryThresholds: { missing_cat: { passRateMin: 0.8 } } },
        summary: { passRate: 1, categoryBreakdown: {} },
      });
      expect(result.passed).toBe(false);
      expect(result.failedCategories).toContain("missing_cat");
    });

    it("should include detail messages", () => {
      const result = evalPassedWithCategories({
        thresholds: { passRateMin: 0.9 },
        summary: { passRate: 0.5 },
      });
      expect(result.details.length).toBeGreaterThan(0);
      expect(result.details[0]).toContain("全局通过率不足");
    });
  });

  /* ── isEvalRunStale ── */
  describe("isEvalRunStale", () => {
    it("should return true for null runFinishedAt", () => {
      expect(isEvalRunStale({ runFinishedAt: null, maxStaleHours: 24 })).toBe(true);
    });

    it("should return true for invalid date", () => {
      expect(isEvalRunStale({ runFinishedAt: "not-a-date", maxStaleHours: 24 })).toBe(true);
    });

    it("should return false for recent run", () => {
      const recent = new Date().toISOString();
      expect(isEvalRunStale({ runFinishedAt: recent, maxStaleHours: 24 })).toBe(false);
    });

    it("should return true for stale run", () => {
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      expect(isEvalRunStale({ runFinishedAt: old, maxStaleHours: 24 })).toBe(true);
    });
  });

  /* ── buildEvalGateReport ── */
  describe("buildEvalGateReport", () => {
    it("should build a report with all fields", () => {
      const report = buildEvalGateReport({
        suiteId: "s1",
        suiteName: "Core Suite",
        reason: "failed",
        details: ["error"],
        runId: "r1",
        passRate: 0.7,
        categoryFailures: ["intent"],
      });
      expect(report.suiteId).toBe("s1");
      expect(report.suiteName).toBe("Core Suite");
      expect(report.reason).toBe("failed");
      expect(report.details).toEqual(["error"]);
      expect(report.runId).toBe("r1");
      expect(report.passRate).toBe(0.7);
      expect(report.categoryFailures).toEqual(["intent"]);
    });

    it("should default details to empty array", () => {
      const report = buildEvalGateReport({ suiteId: "s2", reason: "missing" });
      expect(report.details).toEqual([]);
      expect(report.runId).toBeNull();
    });
  });
});
