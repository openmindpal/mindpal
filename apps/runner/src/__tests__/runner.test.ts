import { describe, it, expect } from "vitest";
import { stableStringify, sha256Hex, jsonByteLength } from "../common";
import {
  computeRunnerRequestBodyDigestV1,
  computeRunnerResponseBodyDigestV1,
  type RunnerExecuteRequestV1,
  type RunnerExecuteResponseV1,
} from "../runnerProtocol";

/* ── common.ts ── */
describe("runner/common", () => {
  describe("stableStringify", () => {
    it("should sort object keys", () => {
      expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    });

    it("should handle nested objects", () => {
      expect(stableStringify({ z: { b: 1, a: 2 }, a: 0 })).toBe('{"a":0,"z":{"a":2,"b":1}}');
    });

    it("should handle arrays (no key sorting)", () => {
      expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
    });

    it("should handle null", () => {
      expect(stableStringify(null)).toBe("null");
    });

    it("should handle undefined (coerced to null by JSON.stringify)", () => {
      expect(stableStringify(undefined)).toBe("null");
    });

    it("should handle primitives", () => {
      expect(stableStringify("hello")).toBe('"hello"');
      expect(stableStringify(42)).toBe("42");
      expect(stableStringify(true)).toBe("true");
    });

    it("should handle nested arrays with objects", () => {
      const result = stableStringify([{ b: 1, a: 2 }]);
      expect(result).toBe('[{"a":2,"b":1}]');
    });
  });

  describe("sha256Hex", () => {
    it("should produce deterministic 64-char hex", () => {
      const h = sha256Hex("test");
      expect(h).toHaveLength(64);
      expect(h).toMatch(/^[a-f0-9]{64}$/);
      expect(sha256Hex("test")).toBe(h);
    });

    it("should differ for different inputs", () => {
      expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
    });
  });

  describe("jsonByteLength", () => {
    it("should return byte length of JSON string", () => {
      expect(jsonByteLength({ a: 1 })).toBe(Buffer.byteLength('{"a":1}', "utf8"));
    });

    it("should handle Unicode content", () => {
      const len = jsonByteLength({ text: "灵智" });
      expect(len).toBeGreaterThan(0);
    });

    it("should return 0 for circular reference", () => {
      const obj: any = {};
      obj.self = obj;
      expect(jsonByteLength(obj)).toBe(0);
    });
  });
});

/* ── runnerProtocol.ts ── */
describe("runner/runnerProtocol", () => {
  const mockReq: RunnerExecuteRequestV1 = {
    format: "runner.execute.v1",
    requestId: "req-001",
    issuedAt: "2024-01-01T00:00:00Z",
    expiresAt: "2024-01-01T01:00:00Z",
    scope: { tenantId: "t1", spaceId: "s1", subjectId: "u1" },
    jobRef: { jobId: "j1", runId: "r1", stepId: "st1" },
    toolRef: "echo-skill@v1",
    artifactRef: "local:/skills/echo-skill",
    depsDigest: "sha256:abc",
    input: { text: "hello" },
    inputDigest: { sha256: "abc", sha256_8: "abc12345", bytes: 100 },
    capabilityEnvelope: {
      format: "capabilityEnvelope.v1",
      dataDomain: {
        tenantId: "t1",
        spaceId: "s1",
        subjectId: "u1",
        toolContract: { scope: "data", resourceType: "entity", action: "read", fieldRules: null, rowFilters: null },
      },
      secretDomain: { connectorInstanceIds: [] },
      egressDomain: { networkPolicy: { allowedDomains: [], rules: [] } },
      resourceDomain: { limits: { timeoutMs: 30000, maxConcurrency: 1, memoryMb: 256, cpuMs: null, maxOutputBytes: 1048576, maxEgressRequests: 10 } },
    },
    policyDigests: { networkPolicySha256_8: "net12345" },
  };

  describe("computeRunnerRequestBodyDigestV1", () => {
    it("should produce a sha256: prefixed digest", () => {
      const digest = computeRunnerRequestBodyDigestV1(mockReq);
      expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("should be deterministic", () => {
      expect(computeRunnerRequestBodyDigestV1(mockReq)).toBe(computeRunnerRequestBodyDigestV1(mockReq));
    });

    it("should change when request fields change", () => {
      const modified = { ...mockReq, requestId: "req-002" };
      expect(computeRunnerRequestBodyDigestV1(modified)).not.toBe(computeRunnerRequestBodyDigestV1(mockReq));
    });
  });

  describe("computeRunnerResponseBodyDigestV1", () => {
    const mockRes: RunnerExecuteResponseV1 = {
      format: "runner.execute.v1",
      requestId: "req-001",
      status: "succeeded",
      errorCode: null,
      errorCategory: null,
      output: { result: "ok" },
      outputDigest: { sha256: "def", sha256_8: "def12345", bytes: 50 },
      egressSummary: { allowed: 1, denied: 0 },
      resourceUsageSummary: { latencyMs: 100, outputBytes: 50, egressRequests: 1 },
    };

    it("should produce a sha256: prefixed digest", () => {
      const digest = computeRunnerResponseBodyDigestV1(mockRes);
      expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("should be deterministic", () => {
      expect(computeRunnerResponseBodyDigestV1(mockRes)).toBe(computeRunnerResponseBodyDigestV1(mockRes));
    });

    it("should change when response status changes", () => {
      const failed = { ...mockRes, status: "failed" as const, errorCode: "TIMEOUT" as const };
      expect(computeRunnerResponseBodyDigestV1(failed)).not.toBe(computeRunnerResponseBodyDigestV1(mockRes));
    });
  });
});
