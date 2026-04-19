import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./audit", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./builtinTools", () => ({
  executeBuiltinTool: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("./common", () => ({
  digestObject: vi.fn((value: unknown) => value),
  isPlainObject: vi.fn((value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value)),
  jsonByteLength: vi.fn(() => 64),
  scrubBySchema: vi.fn((_schema: unknown, value: unknown) => value),
  sha256Hex: vi.fn(() => "deadbeef"),
  stableStringify: vi.fn((value: unknown) => JSON.stringify(value)),
  validateBySchema: vi.fn(),
}));

vi.mock("./encryption", () => ({
  decryptStepInputIfNeeded: vi.fn(async ({ metaInput }: { metaInput: unknown }) => metaInput),
  encryptStepOutputAndCompensation: vi.fn().mockResolvedValue({
    outputEncFormat: null,
    outputKeyVersion: null,
    outputEncryptedPayload: null,
    compensationEncFormat: null,
    compensationKeyVersion: null,
    compensationEncryptedPayload: null,
  }),
}));

vi.mock("./runtime", () => ({
  normalizeLimits: vi.fn(() => ({ timeoutMs: 1_000, maxConcurrency: 1, maxOutputBytes: 1024 * 1024 })),
  normalizeNetworkPolicy: vi.fn((value: unknown) => value ?? {}),
  withConcurrency: vi.fn(async (_key: string, _max: number, fn: () => Promise<unknown>) => fn()),
  withTimeout: vi.fn(async (_timeoutMs: number, fn: (signal: AbortSignal) => Promise<unknown>) => fn(new AbortController().signal)),
}));

vi.mock("./sealed", () => ({
  computeEvidenceDigestV1: vi.fn(() => null),
  computeSealedDigestV1: vi.fn(() => ({ digest: "sealed" })),
  deriveIsolation: vi.fn(() => ({ mode: "builtin" })),
}));

vi.mock("./stepSealing", () => ({
  validateStepTransition: vi.fn(),
  validateRunTransition: vi.fn(),
  sealRunIfFinished: vi.fn(),
}));

vi.mock("./stepValidation", () => ({
  checkExecutionInvariants: vi.fn(),
  isSideEffectWriteTool: vi.fn(() => false),
}));

vi.mock("./tooling", () => ({
  buildSafeToolOutput: vi.fn((_name: string, value: unknown) => value),
  computeWriteLeaseResourceRef: vi.fn(() => null),
  isWriteLeaseTool: vi.fn(() => false),
  loadToolVersion: vi.fn().mockResolvedValue({
    artifact_ref: null,
    deps_digest: null,
    output_schema: {},
    trust_summary: null,
    scan_summary: null,
    sbom_digest: null,
  }),
  parseToolRef: vi.fn(() => ({ name: "test.tool" })),
}));

vi.mock("../collabStateSync", () => ({
  applyWorkerCollabState: vi.fn().mockResolvedValue(undefined),
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

  it("其他步骤完成时不会把 needs_approval 的运行错误覆盖回 queued", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM steps WHERE step_id")) {
        return {
          rowCount: 1,
          rows: [{
            step_id: "step-1",
            status: "pending",
            seq: 1,
            tool_ref: "test.tool@1",
            input: {
              traceId: "trace-1",
              tenantId: "tenant-1",
              spaceId: "space-1",
              subjectId: "subject-1",
              idempotencyKey: "idem-1",
              capabilityEnvelope: {
                format: "capabilityEnvelope.v1",
                dataDomain: {
                  tenantId: "tenant-1",
                  spaceId: "space-1",
                  subjectId: "subject-1",
                  toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: null, rowFilters: null },
                },
                secretDomain: { connectorInstanceIds: [] },
                egressDomain: { networkPolicy: {} },
                resourceDomain: { limits: { timeoutMs: 1000, maxConcurrency: 1, maxOutputBytes: 1024 * 1024 } },
              },
              toolContract: { scope: "read", resourceType: "tool", action: "execute", idempotencyRequired: false },
              input: { q: "ok" },
            },
          }],
        };
      }
      if (sql.includes("SELECT job_type FROM jobs")) {
        return { rowCount: 1, rows: [{ job_type: "agent.run" }] };
      }
      if (sql.includes("SELECT * FROM runs WHERE run_id")) {
        return {
          rowCount: 1,
          rows: [{
            run_id: "run-1",
            tenant_id: "tenant-1",
            status: "queued",
            trigger: "",
            policy_snapshot_ref: null,
            idempotency_key: null,
          }],
        };
      }
      if (sql.includes("SELECT status FROM runs WHERE run_id = $1 LIMIT 1")) {
        return { rowCount: 1, rows: [{ status: "needs_approval" }] };
      }
      if (sql.includes("COUNT(*) FILTER (WHERE status IN ('pending','running','streaming'))")) {
        return {
          rowCount: 1,
          rows: [{
            total: 2,
            succeeded: 1,
            active_remaining: 0,
            paused_remaining: 0,
            needs_approval_remaining: 1,
            needs_arbiter_remaining: 0,
            needs_device_remaining: 0,
          }],
        };
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

    expect(query).toHaveBeenCalledWith(
      "UPDATE runs SET status = $2, updated_at = now(), finished_at = NULL WHERE run_id = $1",
      ["run-1", "needs_approval"],
    );
    expect(query).toHaveBeenCalledWith(
      "UPDATE jobs SET status = $2, progress = $3, updated_at = now(), result_summary = $4 WHERE job_id = $1",
      ["job-1", "needs_approval", 50, { ok: true }],
    );
  });
});
