import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async (req) => {
    return {
      ok: true,
      traceId: req.ctx.traceId,
      locale: req.ctx.locale,
    };
  });

  app.get("/healthz", async (req, reply) => {
    let dbOk = false;
    let redisOk = false;
    try {
      await app.db.query("SELECT 1");
      dbOk = true;
    } catch {
    }
    try {
      const pong = await app.redis.ping();
      redisOk = String(pong).toUpperCase() === "PONG";
    } catch {
    }
    const ok = dbOk && redisOk;
    if (!ok) reply.status(503);
    return {
      ok,
      deps: { db: dbOk ? "ok" : "down", redis: redisOk ? "ok" : "down" },
      version: process.env.npm_package_version ?? null,
      traceId: req.ctx.traceId,
    };
  });
};
