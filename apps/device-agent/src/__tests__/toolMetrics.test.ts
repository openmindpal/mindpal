import { describe, expect, it, beforeEach } from "vitest";
import {
  recordToolMetric,
  recordFromExecution,
  getToolMetrics,
  getToolMetricsSummary,
  exportMetricsSnapshot,
  resetMetrics,
  setMetricsWindow,
} from "../kernel/toolMetrics";
import type { ToolMetricsSample } from "../kernel/toolMetrics";

beforeEach(() => {
  resetMetrics();
  setMetricsWindow(5 * 60 * 1000); // reset to default 5 min
});

function sample(overrides: Partial<ToolMetricsSample> = {}): ToolMetricsSample {
  return {
    toolName: "device.test.tool",
    timestamp: Date.now(),
    durationMs: 100,
    outcome: "succeeded",
    ...overrides,
  };
}

describe("toolMetrics — 指标记录", () => {
  it("records a metric and retrieves summary", () => {
    recordToolMetric(sample());
    const summary = getToolMetrics("device.test.tool");
    expect(summary).not.toBeNull();
    expect(summary!.totalCount).toBe(1);
    expect(summary!.successCount).toBe(1);
    expect(summary!.successRate).toBe(1);
  });

  it("returns null for unknown tool", () => {
    expect(getToolMetrics("device.nope")).toBeNull();
  });

  it("records multiple outcomes correctly", () => {
    recordToolMetric(sample({ outcome: "succeeded" }));
    recordToolMetric(sample({ outcome: "failed" }));
    recordToolMetric(sample({ outcome: "policy_denied" }));
    recordToolMetric(sample({ outcome: "user_denied" }));
    recordToolMetric(sample({ outcome: "plugin_exception" }));
    recordToolMetric(sample({ outcome: "feature_disabled" }));
    recordToolMetric(sample({ outcome: "unsupported" }));

    const s = getToolMetrics("device.test.tool")!;
    expect(s.totalCount).toBe(7);
    expect(s.successCount).toBe(1);
    expect(s.policyDeniedCount).toBe(1);
    expect(s.userDeniedCount).toBe(1);
    expect(s.pluginExceptionCount).toBe(1);
    expect(s.featureDisabledCount).toBe(1);
    expect(s.unsupportedCount).toBe(1);
  });

  it("recordFromExecution maps error categories correctly", () => {
    recordFromExecution("device.map.tool", 50); // no error → succeeded
    recordFromExecution("device.map.tool", 50, "policy_violation"); // → policy_denied
    recordFromExecution("device.map.tool", 50, "access_denied"); // → policy_denied
    recordFromExecution("device.map.tool", 50, "user_denied"); // → user_denied
    recordFromExecution("device.map.tool", 50, "feature_disabled");
    recordFromExecution("device.map.tool", 50, "plugin_exception");
    recordFromExecution("device.map.tool", 50, "unsupported_tool"); // → unsupported
    recordFromExecution("device.map.tool", 50, "other_error"); // → failed

    const s = getToolMetrics("device.map.tool")!;
    expect(s.totalCount).toBe(8);
    expect(s.successCount).toBe(1);
    expect(s.policyDeniedCount).toBe(2);
    expect(s.userDeniedCount).toBe(1);
    expect(s.featureDisabledCount).toBe(1);
    expect(s.pluginExceptionCount).toBe(1);
    expect(s.unsupportedCount).toBe(1);
  });
});

describe("toolMetrics — 聚合", () => {
  it("computes avg and p99 latency from successful samples", () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const d of latencies) {
      recordToolMetric(sample({ durationMs: d }));
    }
    const s = getToolMetrics("device.test.tool")!;
    expect(s.avgLatencyMs).toBe(55); // (10+...+100)/10 = 55
    expect(s.p99LatencyMs).toBe(100);
  });

  it("excludes failed samples from latency calculation", () => {
    recordToolMetric(sample({ durationMs: 100, outcome: "succeeded" }));
    recordToolMetric(sample({ durationMs: 9999, outcome: "failed" }));
    const s = getToolMetrics("device.test.tool")!;
    expect(s.avgLatencyMs).toBe(100);
    expect(s.totalCount).toBe(2);
    expect(s.successCount).toBe(1);
  });

  it("getToolMetricsSummary aggregates across tools", () => {
    recordToolMetric(sample({ toolName: "device.a" }));
    recordToolMetric(sample({ toolName: "device.b" }));
    const summaries = getToolMetricsSummary();
    expect(summaries).toHaveLength(2);
  });

  it("exportMetricsSnapshot equals getToolMetricsSummary", () => {
    recordToolMetric(sample({ toolName: "device.snap" }));
    const snap = exportMetricsSnapshot();
    const summary = getToolMetricsSummary();
    expect(snap).toEqual(summary);
  });
});

describe("toolMetrics — 重置与窗口", () => {
  it("resetMetrics clears all data", () => {
    recordToolMetric(sample());
    resetMetrics();
    expect(getToolMetrics("device.test.tool")).toBeNull();
    expect(getToolMetricsSummary()).toHaveLength(0);
  });

  it("samples outside window are excluded from summary", () => {
    setMetricsWindow(1000); // 1 second window
    // Record a sample 2 seconds ago
    recordToolMetric(sample({ timestamp: Date.now() - 2000 }));
    // This sample is outside the 1s window
    expect(getToolMetrics("device.test.tool")).toBeNull();
  });

  it("samples inside window are included", () => {
    setMetricsWindow(10000);
    recordToolMetric(sample({ timestamp: Date.now() - 5000 }));
    const s = getToolMetrics("device.test.tool");
    expect(s).not.toBeNull();
    expect(s!.totalCount).toBe(1);
  });
});

describe("toolMetrics — 高频与边界", () => {
  it("handles high-frequency recording without error", () => {
    for (let i = 0; i < 600; i++) {
      recordToolMetric(sample({ timestamp: Date.now() }));
    }
    const s = getToolMetrics("device.test.tool")!;
    // MAX_SAMPLES_PER_TOOL is 500, so older ones are evicted
    expect(s.totalCount).toBeLessThanOrEqual(500);
    expect(s.totalCount).toBeGreaterThan(0);
  });

  it("handles zero-duration sample", () => {
    recordToolMetric(sample({ durationMs: 0 }));
    const s = getToolMetrics("device.test.tool")!;
    expect(s.avgLatencyMs).toBe(0);
  });

  it("summary has correct window timestamps", () => {
    recordToolMetric(sample());
    const s = getToolMetrics("device.test.tool")!;
    expect(s.windowStartMs).toBeLessThan(s.windowEndMs);
    expect(s.windowEndMs).toBeLessThanOrEqual(Date.now() + 10);
  });
});
