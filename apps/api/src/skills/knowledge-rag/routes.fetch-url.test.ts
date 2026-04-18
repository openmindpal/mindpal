import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { createRouteTestApp } from "../../testkit/routeTestkit";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async () => ({ decision: "allow" })),
  requireSubject: vi.fn(() => ({ tenantId: "tenant-1", spaceId: "space-1", subjectId: "user-1" })),
  setAuditContext: vi.fn((req: any) => {
    req.ctx ??= {};
    req.ctx.audit ??= {};
  }),
  lookup: vi.fn(),
}));

vi.mock("../../modules/auth/guard", () => ({
  requirePermission: mocks.requirePermission,
  requireSubject: mocks.requireSubject,
}));

vi.mock("../../modules/audit/context", () => ({
  setAuditContext: mocks.setAuditContext,
}));

vi.mock("node:dns/promises", () => ({
  lookup: mocks.lookup,
}));

import { knowledgeRoutes } from "./routes";

function buildTestApp(): FastifyInstance {
  return createRouteTestApp({
    plugin: knowledgeRoutes,
    decorate: (app) => {
      app.db = { query: vi.fn() };
      app.queue = { add: vi.fn() };
    },
  });
}

describe("knowledgeRoutes fetch-url", () => {
  let app: FastifyInstance;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchMock);
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
  });

  it("POST /knowledge/fetch-url 会阻止本地地址抓取", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/knowledge/fetch-url",
      payload: { url: "http://127.0.0.1:8080/private" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe("BAD_REQUEST");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POST /knowledge/fetch-url 会阻止重定向到内网地址", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://localhost/admin" },
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/knowledge/fetch-url",
      payload: { url: "https://example.com/start" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe("BAD_REQUEST");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POST /knowledge/fetch-url 会阻止 DNS 解析到私网地址", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "10.0.0.8" }]);

    const res = await app.inject({
      method: "POST",
      url: "/knowledge/fetch-url",
      payload: { url: "https://example.com/internal-hop" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe("BAD_REQUEST");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POST /knowledge/fetch-url 会拒绝超大响应体", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("too big", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": "1000001",
        },
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/knowledge/fetch-url",
      payload: { url: "https://example.com/large.txt" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe("BAD_REQUEST");
  });
});
