import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./stepSealing", () => ({
  validateStepTransition: vi.fn(),
  validateRunTransition: vi.fn(),
  sealRunIfFinished: vi.fn(),
}));

import { processStep } from "./processStep";
import { validateStepTransition } from "./stepSealing";

describe("processStep blocking statuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("run=needs_device 时将 step 同步写为 needs_device 并发布 step done", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM steps")) {
        return { rowCount: 1, rows: [{ step_id: "step-1", status: "pending", input: {} }] };
      }
      if (sql.includes("SELECT job_type FROM jobs")) {
        return { rowCount: 1, rows: [{ job_type: "agent.run" }] };
      }
      if (sql.includes("SELECT * FROM runs")) {
        return { rowCount: 1, rows: [{ run_id: "run-1", tenant_id: "tenant-1", status: "needs_device", trigger: "" }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const redis = { publish: vi.fn().mockResolvedValue(1) } as any;

    await processStep({
      pool: { query } as any,
      jobId: "job-1",
      runId: "run-1",
      stepId: "step-1",
      masterKey: "mk",
      redis,
    });

    expect(validateStepTransition as any).toHaveBeenCalledWith("step-1", "pending", "needs_device");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE steps SET status = 'needs_device'"),
      ["step-1"],
    );
    expect(redis.publish).toHaveBeenCalledWith("step:done:step-1", "1");
  });
});
