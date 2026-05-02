import type { FastifyPluginAsync } from "fastify";
import { getBuiltinSkills, validateSkillDependencies } from "../lib/skillPlugin";
import { getAllBreakerMetrics } from "@mindpal/shared";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  const startTime = Date.now();

  /* ─── Liveness Probe (K8s) ─── */
  app.get("/health/live", async () => {
    return { status: "ok" };
  });

  /* ─── P1-02: /healthz/live 别名 ─── */
  app.get("/healthz/live", async () => {
    return { status: "ok" };
  });

  /* ─── Basic Health ─── */
  app.get("/health", async (req) => {
    return {
      ok: true,
      traceId: req.ctx.traceId,
      locale: req.ctx.locale,
    };
  });

  /* ─── Readiness Probe (K8s) ─── */
  app.get("/health/ready", async (req, reply) => {
    let dbOk = false;
    let dbLatencyMs = 0;
    try {
      const start = Date.now();
      await app.db.query("SELECT 1");
      dbLatencyMs = Date.now() - start;
      dbOk = true;
      app.metrics.setHealthStatus({ component: "database", healthy: true });
    } catch {
      app.metrics.setHealthStatus({ component: "database", healthy: false });
    }

    let redisOk = false;
    try {
      const pong = await app.redis.ping();
      redisOk = String(pong).toUpperCase() === "PONG";
      app.metrics.setHealthStatus({ component: "redis", healthy: redisOk });
    } catch {
      app.metrics.setHealthStatus({ component: "redis", healthy: false });
    }

    const ok = dbOk && redisOk;
    if (!ok) reply.status(503);
    return {
      status: ok ? "healthy" : "unhealthy",
      checks: [
        { name: "database", status: dbOk ? "pass" : "fail", latencyMs: dbLatencyMs },
        { name: "redis", status: redisOk ? "pass" : "fail" },
      ],
    };
  });

  /* ─── Operational Health Check ─── */
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
    // Skill 注册完整性检查
    const skills = getBuiltinSkills();
    const skillCount = skills.size;
    const depErrors = validateSkillDependencies();
    const skillsOk = depErrors.length === 0 && skillCount > 0;

    const status = !dbOk
      ? "unhealthy"
      : redisOk && skillsOk
        ? "healthy"
        : "degraded";
    if (status === "unhealthy") reply.status(503);
    return {
      ok: status !== "unhealthy",
      status,
      deps: {
        db: dbOk ? "ok" : "down",
        redis: redisOk ? "ok" : "down",
        skills: skillsOk ? "ok" : "degraded",
      },
      skillCount,
      skillDepErrors: depErrors.length > 0 ? depErrors : undefined,
      version: process.env.npm_package_version ?? null,
      uptime: Math.round((Date.now() - startTime) / 1000),
      traceId: req.ctx.traceId,
    };
  });

  /* ─── P1-02: /readyz 标准别名 — 深度就绪检查 ─── */
  app.get("/readyz", async (req, reply) => {
    const checks: Array<{ name: string; status: "pass" | "fail"; detail?: any }> = [];

    // 1. Database
    try {
      const t0 = Date.now();
      await app.db.query("SELECT 1");
      const latencyMs = Date.now() - t0;
      checks.push({ name: "database", status: "pass", detail: { latencyMs } });
      app.metrics.setHealthStatus({ component: "database", healthy: true });
    } catch (err: any) {
      checks.push({ name: "database", status: "fail", detail: { error: err?.message } });
      app.metrics.setHealthStatus({ component: "database", healthy: false });
    }

    // 2. Redis
    try {
      const pong = await app.redis.ping();
      const ok = String(pong).toUpperCase() === "PONG";
      checks.push({ name: "redis", status: ok ? "pass" : "fail" });
      app.metrics.setHealthStatus({ component: "redis", healthy: ok });
    } catch (err: any) {
      checks.push({ name: "redis", status: "fail", detail: { error: err?.message } });
      app.metrics.setHealthStatus({ component: "redis", healthy: false });
    }

    // 3. Skills
    const skills = getBuiltinSkills();
    const depErrors = validateSkillDependencies();
    const skillsOk = depErrors.length === 0 && skills.size > 0;
    checks.push({ name: "skills", status: skillsOk ? "pass" : "fail", detail: { count: skills.size, depErrors: depErrors.length > 0 ? depErrors : undefined } });

    // 4. Connection Pool Stats
    const poolStats = {
      idle: (app.db as any).idleCount ?? 0,
      total: (app.db as any).totalCount ?? 0,
      waiting: (app.db as any).waitingCount ?? 0,
    };
    const poolHealthy = poolStats.waiting < 10;
    checks.push({ name: "db_pool", status: poolHealthy ? "pass" : "fail", detail: poolStats });

    // 5. Circuit Breakers (any open = degraded, not failing readiness)
    const breakerMetrics = getAllBreakerMetrics();
    const openBreakers = breakerMetrics.filter(m => m.state === "open");
    if (openBreakers.length > 0) {
      checks.push({ name: "circuit_breakers", status: "pass", detail: { open: openBreakers.map(b => b.name), total: breakerMetrics.length } });
    }

    const allPass = checks.every(c => c.status === "pass");
    if (!allPass) reply.status(503);
    return {
      ok: allPass,
      status: allPass ? "ready" : "not_ready",
      checks,
      uptime: Math.round((Date.now() - startTime) / 1000),
      version: process.env.npm_package_version ?? null,
    };
  });

  /* ─── Database Pool Stats ─── */
  app.get("/health/db-pool", async (req, reply) => {
    const pool = app.db as any;
    const stats = {
      idle: pool.idleCount ?? 0,
      total: pool.totalCount ?? 0,
      waiting: pool.waitingCount ?? 0,
    };
    app.metrics.setDatabasePoolStats(stats);
    return { pool: stats };
  });

  /* ─── P3-1: 全系统健康聚合端点 ─── */
  app.get("/health/system", async (req, reply) => {
    type ComponentStatus = "healthy" | "degraded" | "unhealthy";
    const components: Record<string, { status: ComponentStatus; detail?: any }> = {};

    // 1. API 自身
    components.api = { status: "healthy", detail: { uptime: Math.round((Date.now() - startTime) / 1000) } };

    // 2. PostgreSQL
    try {
      const t0 = Date.now();
      await app.db.query("SELECT 1");
      const latencyMs = Date.now() - t0;
      components.database = { status: latencyMs > 2000 ? "degraded" : "healthy", detail: { latencyMs } };
    } catch (err: any) {
      components.database = { status: "unhealthy", detail: { error: err?.message } };
    }

    // 3. Redis
    try {
      const pong = await app.redis.ping();
      const ok = String(pong).toUpperCase() === "PONG";
      components.redis = { status: ok ? "healthy" : "unhealthy" };
    } catch (err: any) {
      components.redis = { status: "unhealthy", detail: { error: err?.message } };
    }

    // 4. Worker 心跳（查询最后一次 worker 心跳时间）
    try {
      const hb = await app.db.query<{ last_heartbeat: Date }>(
        "SELECT MAX(updated_at) AS last_heartbeat FROM agent_processes WHERE status = 'running'"
      );
      const lastHb = hb.rows[0]?.last_heartbeat;
      if (!lastHb) {
        components.worker = { status: "degraded", detail: { reason: "no_active_workers" } };
      } else {
        const ageMs = Date.now() - new Date(lastHb).getTime();
        components.worker = { status: ageMs > 120_000 ? "degraded" : "healthy", detail: { lastHeartbeatAgoMs: ageMs } };
      }
    } catch {
      components.worker = { status: "degraded", detail: { reason: "heartbeat_query_failed" } };
    }

    // 5. 模型绑定状态
    try {
      const bindings = await app.db.query<{ cnt: string }>(
        "SELECT COUNT(*) AS cnt FROM provider_bindings WHERE status = 'enabled'"
      );
      const cnt = parseInt(bindings.rows[0]?.cnt ?? "0", 10);
      components.model_bindings = { status: cnt > 0 ? "healthy" : "degraded", detail: { activeBindings: cnt } };
    } catch {
      components.model_bindings = { status: "degraded", detail: { reason: "query_failed" } };
    }

    // 聚合状态
    const statuses = Object.values(components).map(c => c.status);
    let systemStatus: ComponentStatus = "healthy";
    if (statuses.includes("unhealthy")) systemStatus = "unhealthy";
    else if (statuses.includes("degraded")) systemStatus = "degraded";

    if (systemStatus === "unhealthy") reply.status(503);
    else if (systemStatus === "degraded") reply.status(200); // 降级仍返回 200，但状态标记 degraded

    return { status: systemStatus, components };
  });
};
