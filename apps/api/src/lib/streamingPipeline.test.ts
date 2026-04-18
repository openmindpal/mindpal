import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { drainAllConnections, getStreamingPipelineMetrics, openManagedSse } from "./streamingPipeline";

class FakeRawStream extends EventEmitter {
  writes: string[] = [];
  headers: Record<string, string> = {};
  ended = false;

  writeHead(_status: number, headers: Record<string, string>) {
    this.headers = headers;
  }

  flushHeaders() {}

  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }

  end() {
    this.ended = true;
    this.emit("close");
  }
}

function createHarness() {
  const reqRaw = new EventEmitter();
  const replyRaw = new FakeRawStream();
  const req = {
    raw: reqRaw,
    headers: {},
    ctx: {
      traceId: "trace-1",
      requestId: "req-1",
      audit: {
        resourceType: "model",
        action: "invoke.stream",
      },
    },
  } as any;
  const reply = {
    raw: replyRaw,
    getHeader: () => undefined,
  } as any;

  return { req, reply, reqRaw, replyRaw };
}

describe("streamingPipeline", () => {
  afterEach(async () => {
    await drainAllConnections("test_cleanup");
  });

  it("openManagedSse 在 DLP deny 时发送 error 事件并关闭连接", () => {
    const { req, reply, replyRaw } = createHarness();
    const conn = openManagedSse({
      req,
      reply,
      tenantId: "tenant-1",
      dlpContext: {
        configOverride: true,
        policyDigest: null,
        policy: {
          version: "v1",
          mode: "deny",
          denyTargets: new Set(["model:invoke.stream"]),
          denyHitTypes: new Set(["email"]),
        },
      },
    });

    const sent = conn.sendEvent("delta", { text: "alice@example.com" });

    expect(sent).toBe(false);
    expect(replyRaw.writes.join("")).toContain("event: error");
    expect(replyRaw.writes.join("")).toContain("\"errorCode\":\"DLP_DENIED\"");
    expect(replyRaw.writes.join("")).toContain("\"blockedEvent\":\"delta\"");
    expect(replyRaw.ended).toBe(true);
    expect(conn.isClosed()).toBe(true);
  });

  it("openManagedSse 在 allow 路径下保留正常事件并计入指标", () => {
    const { req, reply, replyRaw } = createHarness();
    const conn = openManagedSse({
      req,
      reply,
      tenantId: "tenant-1",
      dlpContext: {
        configOverride: true,
        policyDigest: null,
        policy: {
          version: "v1",
          mode: "audit_only",
          denyTargets: new Set(["model:invoke.stream"]),
          denyHitTypes: new Set(["email"]),
        },
      },
    });

    const sent = conn.sendEvent("delta", { text: "hello world" });
    const metrics = getStreamingPipelineMetrics();

    expect(sent).toBe(true);
    expect(replyRaw.writes.join("")).toContain("event: delta");
    expect(metrics.activeConnections).toBeGreaterThanOrEqual(1);
    expect(metrics.totalEventsSent).toBeGreaterThanOrEqual(1);
  });
});
