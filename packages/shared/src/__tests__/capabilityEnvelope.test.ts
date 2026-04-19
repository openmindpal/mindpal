import { describe, expect, it } from "vitest";
import { validateCapabilityEnvelopeV1, checkCapabilityEnvelopeNotExceedV1 } from "../capabilityEnvelope";
import type { CapabilityEnvelopeV1 } from "../capabilityEnvelope";

function makeValidEnvelope(overrides?: Partial<Record<string, any>>): any {
  return {
    format: "capabilityEnvelope.v1",
    dataDomain: {
      tenantId: "t1",
      spaceId: "s1",
      subjectId: "u1",
      toolContract: {
        scope: "data",
        resourceType: "notes",
        action: "read",
        fieldRules: null,
        rowFilters: null,
      },
    },
    secretDomain: { connectorInstanceIds: [] },
    egressDomain: { networkPolicy: { allowedDomains: [], rules: [] } },
    resourceDomain: { limits: { timeoutMs: 5000, maxConcurrency: 5, memoryMb: null, cpuMs: null, maxOutputBytes: 500000, maxEgressRequests: 10 } },
    ...overrides,
  };
}

describe("validateCapabilityEnvelopeV1", () => {
  it("合法信封验证通过", () => {
    const result = validateCapabilityEnvelopeV1(makeValidEnvelope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.dataDomain.tenantId).toBe("t1");
      expect(result.envelope.dataDomain.toolContract.scope).toBe("data");
    }
  });

  it("缺少 format 字段拒绝", () => {
    const result = validateCapabilityEnvelopeV1({ ...makeValidEnvelope(), format: "bad" });
    expect(result.ok).toBe(false);
  });

  it("null 输入拒绝", () => {
    const result = validateCapabilityEnvelopeV1(null);
    expect(result.ok).toBe(false);
  });

  it("非对象输入拒绝", () => {
    expect(validateCapabilityEnvelopeV1("string")).toEqual({ ok: false, error: "invalid_envelope" });
    expect(validateCapabilityEnvelopeV1(123)).toEqual({ ok: false, error: "invalid_envelope" });
  });

  it("缺少必要的 toolContract 字段拒绝", () => {
    const env = makeValidEnvelope();
    env.dataDomain.toolContract.scope = "";
    expect(validateCapabilityEnvelopeV1(env).ok).toBe(false);
  });

  it("缺少 tenantId 拒绝", () => {
    const env = makeValidEnvelope();
    env.dataDomain.tenantId = "";
    expect(validateCapabilityEnvelopeV1(env).ok).toBe(false);
  });

  it("spaceId 为 null 允许通过", () => {
    const env = makeValidEnvelope();
    env.dataDomain.spaceId = null;
    const result = validateCapabilityEnvelopeV1(env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.dataDomain.spaceId).toBeNull();
  });

  it("归一化 connectorInstanceIds 去重", () => {
    const env = makeValidEnvelope();
    env.secretDomain.connectorInstanceIds = ["a", "b", "a", " c "];
    const result = validateCapabilityEnvelopeV1(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.secretDomain.connectorInstanceIds).toContain("a");
      expect(result.envelope.secretDomain.connectorInstanceIds).toContain("b");
      expect(result.envelope.secretDomain.connectorInstanceIds).toContain("c");
      // 去重
      const set = new Set(result.envelope.secretDomain.connectorInstanceIds);
      expect(set.size).toBe(result.envelope.secretDomain.connectorInstanceIds.length);
    }
  });

  it("fieldRules 归一化", () => {
    const env = makeValidEnvelope();
    env.dataDomain.toolContract.fieldRules = {
      read: { allow: [" title ", "body"], deny: [] },
      write: { allow: ["*"], deny: ["secret"] },
    };
    const result = validateCapabilityEnvelopeV1(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.dataDomain.toolContract.fieldRules?.read?.allow).toContain("title");
      expect(result.envelope.dataDomain.toolContract.fieldRules?.write?.deny).toContain("secret");
    }
  });
});

describe("checkCapabilityEnvelopeNotExceedV1", () => {
  function makeEnvelopePair(childOverrides?: any, parentOverrides?: any) {
    const parent = validateCapabilityEnvelopeV1(makeValidEnvelope(parentOverrides));
    const child = validateCapabilityEnvelopeV1(makeValidEnvelope(childOverrides));
    if (!parent.ok || !child.ok) throw new Error("envelope validation failed");
    return { envelope: child.envelope, effective: parent.envelope };
  }

  it("相同信封通过", () => {
    const p = makeEnvelopePair();
    expect(checkCapabilityEnvelopeNotExceedV1(p)).toEqual({ ok: true });
  });

  it("tenantId 不匹配拒绝", () => {
    const parent = validateCapabilityEnvelopeV1(makeValidEnvelope());
    const childEnv = makeValidEnvelope();
    childEnv.dataDomain.tenantId = "t2";
    const child = validateCapabilityEnvelopeV1(childEnv);
    if (!parent.ok || !child.ok) throw new Error("validation failed");
    const result = checkCapabilityEnvelopeNotExceedV1({ envelope: child.envelope, effective: parent.envelope });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("tenant_mismatch");
  });

  it("scope 不匹配拒绝", () => {
    const parent = validateCapabilityEnvelopeV1(makeValidEnvelope());
    const childEnv = makeValidEnvelope();
    childEnv.dataDomain.toolContract.scope = "admin";
    const child = validateCapabilityEnvelopeV1(childEnv);
    if (!parent.ok || !child.ok) throw new Error("validation failed");
    const result = checkCapabilityEnvelopeNotExceedV1({ envelope: child.envelope, effective: parent.envelope });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_mismatch");
  });

  it("网络策略超出拒绝", () => {
    const parentEnv = makeValidEnvelope();
    parentEnv.egressDomain.networkPolicy = { allowedDomains: ["example.com"], rules: [] };
    const childEnv = makeValidEnvelope();
    childEnv.egressDomain.networkPolicy = { allowedDomains: ["example.com", "evil.com"], rules: [] };
    const parent = validateCapabilityEnvelopeV1(parentEnv);
    const child = validateCapabilityEnvelopeV1(childEnv);
    if (!parent.ok || !child.ok) throw new Error("validation failed");
    const result = checkCapabilityEnvelopeNotExceedV1({ envelope: child.envelope, effective: parent.envelope });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("egress_not_subset");
  });

  it("网络策略子集通过", () => {
    const parentEnv = makeValidEnvelope();
    parentEnv.egressDomain.networkPolicy = { allowedDomains: ["example.com", "api.com"], rules: [] };
    const childEnv = makeValidEnvelope();
    childEnv.egressDomain.networkPolicy = { allowedDomains: ["example.com"], rules: [] };
    const parent = validateCapabilityEnvelopeV1(parentEnv);
    const child = validateCapabilityEnvelopeV1(childEnv);
    if (!parent.ok || !child.ok) throw new Error("validation failed");
    expect(checkCapabilityEnvelopeNotExceedV1({ envelope: child.envelope, effective: parent.envelope })).toEqual({ ok: true });
  });

  it("limits 超出拒绝", () => {
    const parentEnv = makeValidEnvelope();
    parentEnv.resourceDomain.limits = { timeoutMs: 5000, maxConcurrency: 5, memoryMb: 256, cpuMs: 1000, maxOutputBytes: 500000, maxEgressRequests: 10 };
    const childEnv = makeValidEnvelope();
    childEnv.resourceDomain.limits = { timeoutMs: 10000, maxConcurrency: 5, memoryMb: 256, cpuMs: 1000, maxOutputBytes: 500000, maxEgressRequests: 10 };
    const parent = validateCapabilityEnvelopeV1(parentEnv);
    const child = validateCapabilityEnvelopeV1(childEnv);
    if (!parent.ok || !child.ok) throw new Error("validation failed");
    const result = checkCapabilityEnvelopeNotExceedV1({ envelope: child.envelope, effective: parent.envelope });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("limits_not_subset");
  });

  it("secret 超出拒绝", () => {
    const parentEnv = makeValidEnvelope();
    parentEnv.secretDomain.connectorInstanceIds = ["c1"];
    const childEnv = makeValidEnvelope();
    childEnv.secretDomain.connectorInstanceIds = ["c1", "c2"];
    const parent = validateCapabilityEnvelopeV1(parentEnv);
    const child = validateCapabilityEnvelopeV1(childEnv);
    if (!parent.ok || !child.ok) throw new Error("validation failed");
    const result = checkCapabilityEnvelopeNotExceedV1({ envelope: child.envelope, effective: parent.envelope });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("secret_not_subset");
  });
});
