/**
 * Worker Health Check HTTP Server
 *
 * P2-6.3: 为 Worker 添加轻量 HTTP 健康检查端点，支持容器编排探针（K8s liveness/readiness）。
 * 暴露：
 * - /healthz           — 综合健康（DB + Redis + BullMQ 队列状态）
 * - /healthz/live      — 存活探针（进程存活即可）
 * - /healthz/ready     — 就绪探针（DB + Redis 可达）
 *
 * 默认端口: WORKER_HEALTH_PORT 或 3002
 */
import http from "node:http";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:healthServer" });

export interface WorkerHealthParams {
  pool: Pool;
  queue: Queue;
  redis: any; // ioredis instance
  /** 健康检查 HTTP 端口，默认 3002 */
  port?: number;
}

let _server: http.Server | null = null;
const startTime = Date.now();

export function startHealthServer(params: WorkerHealthParams): http.Server {
  if (_server) return _server;

  const { pool, queue, redis } = params;
  const port = params.port ?? (Number(process.env.WORKER_HEALTH_PORT) || 3002);

  _server = http.createServer(async (req, res) => {
    const url = (req.url ?? "").split("?")[0];

    // ── Liveness: 进程存活就行 ─────────────────────────
    if (url === "/healthz/live") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // ── Readiness / Full Health ────────────────────────
    if (url === "/healthz" || url === "/healthz/ready") {
      const checks: Record<string, { status: string; detail?: any }> = {};

      // DB check
      try {
        const t0 = Date.now();
        await pool.query("SELECT 1");
        checks.database = { status: "pass", detail: { latencyMs: Date.now() - t0 } };
      } catch (err: any) {
        checks.database = { status: "fail", detail: { error: err?.message } };
      }

      // Redis check
      try {
        const pong = await redis.ping();
        checks.redis = { status: String(pong).toUpperCase() === "PONG" ? "pass" : "fail" };
      } catch (err: any) {
        checks.redis = { status: "fail", detail: { error: err?.message } };
      }

      // BullMQ queue check
      try {
        const waiting = await queue.getWaitingCount();
        const active = await queue.getActiveCount();
        const delayed = await queue.getDelayedCount();
        const failed = await queue.getFailedCount();
        // P1-02: 积压超过阈值时标记为降级（仍然可服务但有压力）
        const backlogThreshold = Number(process.env.WORKER_BACKLOG_THRESHOLD) || 500;
        const backlogOk = waiting < backlogThreshold;
        checks.queue = {
          status: backlogOk ? "pass" : "warn",
          detail: { waiting, active, delayed, failed, backlogThreshold },
        };
      } catch (err: any) {
        checks.queue = { status: "fail", detail: { error: err?.message } };
      }

      const allPass = Object.values(checks).every((c) => c.status === "pass" || c.status === "warn");
      const statusCode = allPass ? 200 : 503;

      res.writeHead(statusCode, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: allPass,
          status: allPass ? "healthy" : "unhealthy",
          checks,
          uptime: Math.round((Date.now() - startTime) / 1000),
          pid: process.pid,
          version: process.env.npm_package_version ?? null,
        }),
      );
      return;
    }

    // ── 404 ───────────────────────────────────────────
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  _server.listen(port, "127.0.0.1", () => {
    _logger.info("health server listening", { host: "127.0.0.1", port });
  });

  _server.on("error", (err: any) => {
    _logger.error("health server error", { error: err?.message });
  });

  return _server;
}

export function stopHealthServer(): void {
  if (_server) {
    _server.close();
    _server = null;
  }
}
