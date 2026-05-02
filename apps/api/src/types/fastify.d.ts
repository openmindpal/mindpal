import "fastify";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { RedisClient } from "../modules/redis/client";
import type { ApiConfig } from "../config";
import type { MetricsRegistry } from "../modules/metrics/metrics";
import type { AuthContext, AuthProvider } from "@mindpal/shared";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
    queue: Queue;
    redis: RedisClient;
    cfg: ApiConfig;
    metrics: MetricsRegistry;
    authProvider: AuthProvider;
  }

  interface FastifyRequest {
    /** OTel: 当前请求的 Span（distributedTracing 插件设置） */
    _otelSpan?: Span;
    /** OTel: 当前请求的 Context（distributedTracing 插件设置） */
    _otelContext?: OtelContext;
    /** 请求开始时间戳（structuredLogging 插件设置） */
    _startTime?: number;
    ctx: {
      traceId: string;
      requestId: string;
      locale: string;
      subject?: {
        subjectId: string;
        tenantId: string;
        spaceId?: string;
      };
      authContext?: AuthContext;
      audit?: {
        resourceType?: string;
        action?: string;
        toolRef?: string;
        workflowRef?: string;
        idempotencyKey?: string;
        policyDecision?: unknown;
        inputDigest?: unknown;
        outputDigest?: unknown;
        errorCategory?: string;
        startedAtMs?: number;
        lastError?: unknown;
        skipAuditWrite?: boolean;
        requireOutbox?: boolean;
        outboxEnqueued?: boolean;
        auditWritten?: boolean;
        runId?: string;
        stepId?: string;
        policySnapshotRef?: string;
      };
    };
  }
}
