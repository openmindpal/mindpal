import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { createRouteTestApp } from "../../testkit/routeTestkit";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async () => ({ decision: "allow" })),
  requireSubject: vi.fn((req: any) => req.ctx.subject),
  setAuditContext: vi.fn((req: any, audit: any) => {
    req.ctx ??= {};
    req.ctx.audit ??= {};
    Object.assign(req.ctx.audit, audit);
  }),
  classifyIntentFast: vi.fn(() => ({
    mode: "answer",
    confidence: 0.99,
    reason: "forced_answer",
    needsTask: false,
    needsApproval: false,
    complexity: "simple",
  })),
  classifyIntentTwoLevel: vi.fn(async () => ({ mode: "answer", confidence: 0.5, reason: "shadow", needsTask: false, needsApproval: false, complexity: "simple" })),
  reviewIntentDecision: vi.fn(),
  intentDecisionToClassification: vi.fn(),
  getPromptInjectionModeFromEnv: vi.fn(() => "off"),
  scanPromptInjection: vi.fn(() => ({ blocked: false })),
  summarizePromptInjection: vi.fn(() => ({ blocked: false })),
  handleStreamAnswerMode: vi.fn(async ({ sse }: any) => {
    sse.sendEvent("delta", { text: "alice@example.com" });
    sse.sendEvent("done", { ok: true });
  }),
  resolveRequestDlpPolicyContext: vi.fn(async () => ({
    configOverride: true,
    policyDigest: null,
    policy: {
      version: "v1",
      mode: "deny",
      denyTargets: new Set(["orchestrator:dispatch.stream"]),
      denyHitTypes: new Set(["email"]),
    },
  })),
}));

vi.mock("../../modules/auth/guard", () => ({
  requirePermission: mocks.requirePermission,
  requireSubject: mocks.requireSubject,
}));

vi.mock("../../modules/audit/context", () => ({
  setAuditContext: mocks.setAuditContext,
}));

vi.mock("./modules/intentClassifier", () => ({
  classifyIntentFast: mocks.classifyIntentFast,
  classifyIntentTwoLevel: mocks.classifyIntentTwoLevel,
  reviewIntentDecision: mocks.reviewIntentDecision,
  intentDecisionToClassification: mocks.intentDecisionToClassification,
  GRAY_ZONE: { LOW: 0.65, HIGH: 0.85, ENABLED: false },
}));

vi.mock("../safety-policy/modules/promptInjectionGuard", () => ({
  getPromptInjectionModeFromEnv: mocks.getPromptInjectionModeFromEnv,
  scanPromptInjection: mocks.scanPromptInjection,
  summarizePromptInjection: mocks.summarizePromptInjection,
}));

vi.mock("./dispatch.streamAnswer", () => ({
  handleStreamAnswerMode: mocks.handleStreamAnswerMode,
}));

vi.mock("../../lib/dlpPolicy", () => ({
  resolveRequestDlpPolicyContext: mocks.resolveRequestDlpPolicyContext,
}));

vi.mock("../../plugins/audit", () => ({
  finalizeAuditForStream: vi.fn(),
}));

vi.mock("../../lib/streamingPipeline", () => ({
  openManagedSse: vi.fn((params: any) => {
    const { req, reply, dlpContext } = params;
    let closed = false;
    const chunks: string[] = [];

    return {
      sendEvent(event: string, data: unknown) {
        if (closed) return false;

        const dataStr = JSON.stringify(data);
        const hasEmail = /[\w.-]+@[\w.-]+\.\w+/.test(dataStr);
        const target = `${req?.ctx?.audit?.resourceType ?? ""}:${req?.ctx?.audit?.action ?? ""}`;
        const denyTargets: Set<string> = dlpContext?.policy?.denyTargets ?? new Set();
        const denyHitTypes: Set<string> = dlpContext?.policy?.denyHitTypes ?? new Set();
        const shouldDeny = dlpContext?.policy?.mode === "deny"
          && denyTargets.has(target)
          && hasEmail
          && denyHitTypes.has("email");

        if (shouldDeny) {
          chunks.push(`event: error\ndata: ${JSON.stringify({
            errorCode: "DLP_DENIED",
            message: "DLP blocked",
            traceId: req?.ctx?.traceId,
            blockedEvent: event,
            safetySummary: { decision: "denied" },
          })}\n\n`);
          closed = true;
          return false;
        }

        chunks.push(`event: ${event}\ndata: ${dataStr}\n\n`);
        return true;
      },
      close() {
        closed = true;
        try {
          reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
          reply.raw.end(chunks.join(""));
        } catch { /* inject mode */ }
      },
      isClosed() { return closed; },
    };
  }),
}));

import { orchestratorDispatchRoutes } from "./routes.dispatch";

function buildTestApp(): FastifyInstance {
  return createRouteTestApp({
    plugin: orchestratorDispatchRoutes,
    decorate: (app) => {
      app.db = { query: vi.fn() };
      app.queue = {};
    },
  });
}

describe("orchestrator dispatch stream DLP", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatch/stream 命中 DLP deny 时返回 error 事件并截断 done", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orchestrator/dispatch/stream",
      headers: {
        accept: "text/event-stream",
      },
      payload: {
        message: "hello",
        mode: "answer",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: error");
    expect(res.body).toContain("\"errorCode\":\"DLP_DENIED\"");
    expect(res.body).toContain("\"blockedEvent\":\"delta\"");
    expect(res.body).not.toContain("event: done");
  });
});
