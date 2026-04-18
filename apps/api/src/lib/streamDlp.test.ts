import { describe, expect, it } from "vitest";

import { sanitizeSseEvent } from "./streamDlp";

describe("sanitizeSseEvent", () => {
  const req = {
    ctx: {
      traceId: "trace-1",
      requestId: "req-1",
      audit: { resourceType: "orchestrator", action: "dispatch.stream" },
    },
  } as any;

  it("在 deny 策略命中时将事件转换为 DLP_DENIED error", () => {
    const out = sanitizeSseEvent({
      event: "delta",
      data: { text: "alice@example.com" },
      req,
      dlpContext: {
        configOverride: true,
        policyDigest: null,
        policy: {
          version: "v1",
          mode: "deny",
          denyTargets: new Set(["orchestrator:dispatch.stream"]),
          denyHitTypes: new Set(["email"]),
        },
      },
    });

    expect(out.denied).toBe(true);
    expect(out.event).toBe("error");
    expect((out.data as any).errorCode).toBe("DLP_DENIED");
    expect((out.data as any).blockedEvent).toBe("delta");
  });

  it("在审计模式命中时保留事件名但做脱敏", () => {
    const out = sanitizeSseEvent({
      event: "delta",
      data: { text: "联系 alice@example.com" },
      req,
      dlpContext: {
        configOverride: true,
        policyDigest: null,
        policy: {
          version: "v1",
          mode: "audit_only",
          denyTargets: new Set(["orchestrator:dispatch.stream"]),
          denyHitTypes: new Set(["email"]),
        },
      },
    });

    expect(out.denied).toBe(false);
    expect(out.event).toBe("delta");
    expect((out.data as any).text).toContain("***REDACTED***");
    expect((out.data as any).dlpSummary).toBeDefined();
  });

  it("跳过 ping 事件的 DLP 包装", () => {
    const out = sanitizeSseEvent({
      event: "ping",
      data: { ts: 1 },
      req,
      dlpContext: {
        configOverride: true,
        policyDigest: null,
        policy: {
          version: "v1",
          mode: "deny",
          denyTargets: new Set(["orchestrator:dispatch.stream"]),
          denyHitTypes: new Set(["email"]),
        },
      },
    });

    expect(out.denied).toBe(false);
    expect(out.event).toBe("ping");
    expect(out.data).toEqual({ ts: 1 });
  });
});
