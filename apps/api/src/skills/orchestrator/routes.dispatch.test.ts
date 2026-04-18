import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createRouteTestApp, defaultRouteTestErrorHandler } from "../../testkit/routeTestkit";

const mockRequirePermission = vi.fn(async (_req?: any) => ({ decision: "allow" }));
const mockRequireSubject = vi.fn((_req?: any) => ({ tenantId: "tenant_test", spaceId: "space_test", subjectId: "user_test" }));
const mockSetAuditContext = vi.fn();
const mockClassifyIntentFast = vi.fn();
const mockClassifyIntentTwoLevel = vi.fn();
const mockReviewIntentDecision = vi.fn();
const mockHandleAnswerMode = vi.fn();
const mockHandleExecuteMode = vi.fn();
const mockHandleCollabMode = vi.fn();
const mockHandleInterveneMode = vi.fn();

vi.mock("../../modules/auth/guard", () => ({
  requirePermission: (arg: any) => mockRequirePermission(arg),
  requireSubject: (arg: any) => mockRequireSubject(arg),
}));

vi.mock("../../modules/audit/context", () => ({
  setAuditContext: (...args: any[]) => mockSetAuditContext(...args),
}));

vi.mock("./modules/intentClassifier", () => ({
  classifyIntentFast: (...args: any[]) => mockClassifyIntentFast(...args),
  classifyIntentTwoLevel: (...args: any[]) => mockClassifyIntentTwoLevel(...args),
  reviewIntentDecision: (...args: any[]) => mockReviewIntentDecision(...args),
  intentDecisionToClassification: (decision: any) => ({
    mode: decision.mode,
    confidence: decision.confidence,
    reason: Array.isArray(decision.featureSummary) ? decision.featureSummary.join("; ") : decision.reason ?? "mock",
    needsTask: decision.needsTask ?? (decision.mode ? decision.mode !== "answer" && decision.mode !== "intervene" : false),
    needsApproval: decision.needsConfirmation ?? decision.needsApproval ?? false,
    complexity: decision.complexity ?? "moderate",
    targetTaskId: decision.targetTaskId,
    targetEntryId: decision.targetEntryId,
    interventionType: decision.interventionType,
  }),
}));

vi.mock("../safety-policy/modules/promptInjectionGuard", () => ({
  getPromptInjectionModeFromEnv: vi.fn(() => "off"),
  scanPromptInjection: vi.fn(() => ({ detected: false, score: 0 })),
  summarizePromptInjection: vi.fn(() => ({ mode: "off", blocked: false })),
}));

vi.mock("./dispatch.handleAnswer", () => ({
  handleAnswerMode: (...args: any[]) => mockHandleAnswerMode(...args),
}));

vi.mock("./dispatch.handleExecute", () => ({
  handleExecuteMode: (...args: any[]) => mockHandleExecuteMode(...args),
}));

vi.mock("./dispatch.handleCollab", () => ({
  handleCollabMode: (...args: any[]) => mockHandleCollabMode(...args),
}));

vi.mock("./dispatch.handleIntervene", () => ({
  handleInterveneMode: (...args: any[]) => mockHandleInterveneMode(...args),
}));

vi.mock("./dispatch.classify", () => ({
  registerClassifyRoute: vi.fn(),
}));

vi.mock("./dispatch.stream", () => ({
  registerStreamRoute: vi.fn(),
}));

import { orchestratorDispatchRoutes } from "./routes.dispatch";

function buildTestApp(options?: { withZodErrorMapping?: boolean }): FastifyInstance {
  return createRouteTestApp({
    plugin: orchestratorDispatchRoutes,
    subject: { tenantId: "tenant_test", spaceId: "space_test", subjectId: "user_test" },
    traceId: "trace_test",
    requestId: "req_test",
    errorHandler: options?.withZodErrorMapping
      ? async (err, req, reply) => {
          if (err?.name === "ZodError" || err?.constructor?.name === "ZodError") {
            return reply.status(400).send({ errorCode: "BAD_REQUEST", message: err.message });
          }
          return defaultRouteTestErrorHandler(err, req, reply);
        }
      : undefined,
    decorate: (app) => {
      app.db = { query: vi.fn() };
    },
  });
}

describe("routes.dispatch", () => {
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
    mockRequirePermission.mockResolvedValue({ decision: "allow" });
    mockRequireSubject.mockReturnValue({ tenantId: "tenant_test", spaceId: "space_test", subjectId: "user_test" });
    mockClassifyIntentTwoLevel.mockResolvedValue({
      mode: "answer",
      confidence: 0.9,
      reason: "two_level",
      needsTask: false,
      needsApproval: false,
      complexity: "simple",
      classifierUsed: "two_level",
    });
    mockReviewIntentDecision.mockImplementation(async (_params: any, classification: any) => ({
      mode: classification.mode,
      confidence: classification.confidence,
      featureSummary: [classification.reason ?? "mock"],
      classifierUsed: classification.classifierUsed ?? "reviewer",
      needsConfirmation: classification.needsApproval ?? false,
      needsTask: classification.needsTask,
      intentType: classification.intentType,
      reason: classification.reason,
      complexity: classification.complexity ?? "moderate",
    }));
    mockHandleAnswerMode.mockResolvedValue({ mode: "answer", conversationId: "conv_answer", classification: { mode: "answer", confidence: 1, reason: "mock" } });
    mockHandleExecuteMode.mockResolvedValue({ mode: "execute", conversationId: "conv_exec", classification: { mode: "execute", confidence: 1, reason: "mock" } });
    mockHandleCollabMode.mockResolvedValue({ mode: "collab", conversationId: "conv_collab", classification: { mode: "collab", confidence: 1, reason: "mock" } });
    mockHandleInterveneMode.mockResolvedValue({ mode: "intervene", conversationId: "conv_intervene", classification: { mode: "intervene", confidence: 1, reason: "mock" } });
  });

  it("auto 模式下低置信或无需任务时回落到 answer", async () => {
    mockClassifyIntentTwoLevel.mockResolvedValue({
      mode: "execute",
      confidence: 0.99,
      reason: "looks like task",
      needsTask: false,
      needsApproval: false,
      complexity: "moderate",
      classifierUsed: "two_level",
    });

    const res = await app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      payload: {
        message: "帮我执行一个动作",
        mode: "auto",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockHandleAnswerMode).toHaveBeenCalledTimes(1);
    expect(mockHandleExecuteMode).not.toHaveBeenCalled();
  });

  it("auto 模式下高置信且需要任务时进入 execute", async () => {
    mockClassifyIntentTwoLevel.mockResolvedValue({
      mode: "execute",
      confidence: 0.95,
      reason: "definitely execute",
      needsTask: true,
      needsApproval: false,
      complexity: "moderate",
      classifierUsed: "two_level",
    });

    const res = await app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      payload: {
        message: "帮我批量整理知识库",
        mode: "auto",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockHandleExecuteMode).toHaveBeenCalledTimes(1);
    expect(mockHandleAnswerMode).not.toHaveBeenCalled();
  });

  it("启用自定义错误映射时可把 ZodError 映射为 400", async () => {
    const appWithZodErrorMapping = buildTestApp({ withZodErrorMapping: true });
    await appWithZodErrorMapping.ready();
    mockClassifyIntentTwoLevel.mockRejectedValueOnce({ name: "ZodError", message: "invalid payload" });

    const res = await appWithZodErrorMapping.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      payload: {
        message: "触发错误",
        mode: "auto",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe("BAD_REQUEST");
    await appWithZodErrorMapping.close();
  });
});
