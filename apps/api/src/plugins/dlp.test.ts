import { describe, expect, it, vi } from "vitest";

import { handleDlpPreSerialization } from "./dlp";

describe("handleDlpPreSerialization", () => {
  function createApp() {
    return { db: { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) } } as any;
  }

  function createReqReply() {
    const reply = { status: vi.fn().mockReturnThis() } as any;
    const req = {
      ctx: {
        traceId: "trace-1",
        requestId: "req-1",
        subject: { tenantId: "tenant-1", spaceId: "space-1", subjectId: "user-1" },
        audit: { resourceType: "orchestrator", action: "dispatch", inputDigest: { input: "x" } },
      },
    } as any;
    return { req, reply };
  }

  it("preSerialization 会在响应中补齐 safetySummary.dlpSummary", async () => {
    const prevMode = process.env.DLP_MODE;
    const prevTargets = process.env.DLP_DENY_TARGETS;
    const prevHitTypes = process.env.DLP_DENY_HIT_TYPES;
    process.env.DLP_MODE = "monitor";
    delete process.env.DLP_DENY_TARGETS;
    delete process.env.DLP_DENY_HIT_TYPES;
    try {
      const app = createApp();
      const { req, reply } = createReqReply();
      const out = await handleDlpPreSerialization(app, req, reply, { ok: true, content: "alice@example.com" });
      expect(out.ok).toBe(true);
      expect(out.safetySummary).toBeDefined();
      expect(out.safetySummary.dlpSummary).toBeDefined();
      expect(out.safetySummary.decision).toBe("allowed");
    } finally {
      if (prevMode === undefined) delete process.env.DLP_MODE;
      else process.env.DLP_MODE = prevMode;
      if (prevTargets === undefined) delete process.env.DLP_DENY_TARGETS;
      else process.env.DLP_DENY_TARGETS = prevTargets;
      if (prevHitTypes === undefined) delete process.env.DLP_DENY_HIT_TYPES;
      else process.env.DLP_DENY_HIT_TYPES = prevHitTypes;
    }
  });

  it("deny 模式命中规则时返回 403 与 DLP_DENIED", async () => {
    const prevMode = process.env.DLP_MODE;
    const prevTargets = process.env.DLP_DENY_TARGETS;
    const prevHitTypes = process.env.DLP_DENY_HIT_TYPES;
    process.env.DLP_MODE = "deny";
    process.env.DLP_DENY_TARGETS = "orchestrator:dispatch";
    process.env.DLP_DENY_HIT_TYPES = "email";
    try {
      const app = createApp();
      const { req, reply } = createReqReply();
      const out = await handleDlpPreSerialization(app, req, reply, { ok: true, content: "alice@example.com" });
      expect(reply.status).toHaveBeenCalledWith(403);
      expect(out.errorCode).toBe("DLP_DENIED");
      expect(out.safetySummary).toBeDefined();
      expect(out.safetySummary.decision).toBe("denied");
      expect(out.safetySummary.dlpSummary).toBeDefined();
    } finally {
      if (prevMode === undefined) delete process.env.DLP_MODE;
      else process.env.DLP_MODE = prevMode;
      if (prevTargets === undefined) delete process.env.DLP_DENY_TARGETS;
      else process.env.DLP_DENY_TARGETS = prevTargets;
      if (prevHitTypes === undefined) delete process.env.DLP_DENY_HIT_TYPES;
      else process.env.DLP_DENY_HIT_TYPES = prevHitTypes;
    }
  });
});
