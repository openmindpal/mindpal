import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { createRouteTestApp } from "../../testkit/routeTestkit";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async () => ({ decision: "allow" })),
  setAuditContext: vi.fn((req: any, audit: any) => {
    req.ctx ??= {};
    req.ctx.audit ??= {};
    Object.assign(req.ctx.audit, audit);
  }),
  invokeModelChatUpstreamStream: vi.fn(),
  listRoutingPolicies: vi.fn(async () => []),
  upsertRoutingPolicy: vi.fn(async () => ({})),
  disableRoutingPolicy: vi.fn(async () => undefined),
  deleteRoutingPolicy: vi.fn(async () => undefined),
  resolveRequestDlpPolicyContext: vi.fn(async () => ({
    configOverride: true,
    policyDigest: null,
    policy: {
      version: "v1",
      mode: "deny",
      denyTargets: new Set(["model:invoke.stream"]),
      denyHitTypes: new Set(["email"]),
    },
  })),
}));

vi.mock("../../modules/auth/guard", () => ({
  requirePermission: mocks.requirePermission,
}));

vi.mock("../../modules/audit/context", () => ({
  setAuditContext: mocks.setAuditContext,
}));

vi.mock("./modules/invokeChatUpstreamStream", () => ({
  invokeModelChatUpstreamStream: mocks.invokeModelChatUpstreamStream,
}));

vi.mock("../../lib/dlpPolicy", () => ({
  resolveRequestDlpPolicyContext: mocks.resolveRequestDlpPolicyContext,
}));

vi.mock("../../modules/modelGateway/routingPolicyRepo", () => ({
  listRoutingPolicies: mocks.listRoutingPolicies,
  upsertRoutingPolicy: mocks.upsertRoutingPolicy,
  disableRoutingPolicy: mocks.disableRoutingPolicy,
  deleteRoutingPolicy: mocks.deleteRoutingPolicy,
}));

import { modelChatRoutes } from "./routes.chat";

function buildTestApp(): FastifyInstance {
  return createRouteTestApp({
    plugin: modelChatRoutes,
    decorate: (app) => {
      app.db = { query: vi.fn() };
      app.queue = {};
    },
  });
}

describe("modelChatRoutes stream DLP", () => {
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
    mocks.invokeModelChatUpstreamStream.mockImplementation(async ({ onDelta }: any) => {
      onDelta("contact alice@example.com");
      return {
        scene: "general",
        routingDecision: { provider: "mock" },
        usage: { total_tokens: 10 },
        latencyMs: 5,
        attempts: 1,
        safetySummary: { decision: "allowed" },
      };
    });
  });

  it("models/chat 流式输出命中 DLP deny 时返回 error 事件并终止 done", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/models/chat",
      headers: {
        accept: "text/event-stream",
      },
      payload: {
        purpose: "general",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: status");
    expect(res.body).toContain("event: error");
    expect(res.body).toContain("\"errorCode\":\"DLP_DENIED\"");
    expect(res.body).toContain("\"blockedEvent\":\"delta\"");
    expect(res.body).not.toContain("event: done");
  });
});
