import Fastify from "fastify";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { isAppError } from "../lib/errors";

export type RouteTestSubject = {
  tenantId: string;
  spaceId: string;
  subjectId: string;
};

export type RouteTestCtx = {
  locale: string;
  traceId: string;
  requestId: string;
  subject: RouteTestSubject;
  audit: Record<string, unknown>;
  [key: string]: unknown;
};

export async function defaultRouteTestErrorHandler(err: any, _req: FastifyRequest, reply: FastifyReply) {
  if (isAppError(err)) return reply.status(err.httpStatus).send({ errorCode: err.errorCode, message: err.messageI18n });
  return reply.status(500).send({ errorCode: "INTERNAL", message: String(err?.message ?? err) });
}

export function createRouteTestApp(params: {
  plugin: FastifyPluginAsync;
  subject?: RouteTestSubject;
  locale?: string;
  traceId?: string;
  requestId?: string;
  decorate?: (app: any) => void;
  errorHandler?: (err: any, req: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>;
  ctxPatch?: Partial<RouteTestCtx> | ((ctx: RouteTestCtx, req: FastifyRequest) => Partial<RouteTestCtx> | void);
}): FastifyInstance {
  const app = Fastify({ logger: false }) as any;
  app.decorate("db", { query: async () => ({ rowCount: 0, rows: [] }) });
  app.decorate("queue", {});
  app.decorate("cfg", { secrets: { masterKey: "mk" } });
  app.decorate("metrics", {
    observeOrchestratorExecution: () => undefined,
    observeIntentRoute: () => undefined,
    observeGoalDecompose: () => undefined,
    observePlanningPipeline: () => undefined,
    observeAgentDecision: () => undefined,
    observeParallelToolCalls: () => undefined,
    observePlanQualityScore: () => undefined,
  });
  if (params.decorate) params.decorate(app);
  app.addHook("onRequest", async (req: any) => {
    const baseCtx: RouteTestCtx = {
      locale: params.locale ?? "zh-CN",
      traceId: params.traceId ?? "trace-test",
      requestId: params.requestId ?? "req-test",
      subject: params.subject ?? { tenantId: "tenant-1", spaceId: "space-1", subjectId: "user-1" },
      audit: {},
    };
    const patch = typeof params.ctxPatch === "function" ? params.ctxPatch(baseCtx, req) : params.ctxPatch;
    req.ctx = patch ? { ...baseCtx, ...patch } : baseCtx;
  });
  app.setErrorHandler(params.errorHandler ?? defaultRouteTestErrorHandler);
  app.register(params.plugin);
  return app as FastifyInstance;
}
