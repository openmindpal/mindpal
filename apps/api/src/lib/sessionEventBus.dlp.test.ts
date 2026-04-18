import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockSseHandles = new Map<
  string,
  {
    events: Array<{ event: string; data: unknown }>;
    closed: boolean;
    signal: AbortSignal;
    abortController: AbortController;
  }
>();

vi.mock("./sse", () => ({
  openSse: (params: any) => {
    const ac = new AbortController();
    const handle = {
      events: [] as Array<{ event: string; data: unknown }>,
      closed: false,
      signal: ac.signal,
      abortController: ac,
    };
    const id = `sse-${Date.now()}-${Math.random()}`;
    mockSseHandles.set(id, handle);
    return {
      sendEvent: (event: string, data: unknown) => {
        if (handle.closed) return false;
        const target =
          params?.req?.ctx?.audit?.resourceType && params?.req?.ctx?.audit?.action
            ? `${params.req.ctx.audit.resourceType}:${params.req.ctx.audit.action}`
            : "";
        const text = typeof data === "object" && data && "text" in (data as any) ? String((data as any).text) : "";
        const denyTargets = params?.dlpContext?.policy?.denyTargets as Set<string> | undefined;
        const denyHitTypes = params?.dlpContext?.policy?.denyHitTypes as Set<string> | undefined;
        const shouldDeny =
          params?.dlpContext?.policy?.mode === "deny" &&
          denyTargets?.has(target) &&
          denyHitTypes?.has("email") &&
          /@/.test(text);

        if (shouldDeny) {
          handle.events.push({
            event: "error",
            data: {
              errorCode: "DLP_DENIED",
              blockedEvent: event,
            },
          });
          handle.closed = true;
          ac.abort();
          return false;
        }

        handle.events.push({ event, data });
        return true;
      },
      close: () => {
        handle.closed = true;
        ac.abort();
      },
      isClosed: () => handle.closed,
      signal: ac.signal,
      abortController: ac,
      _id: id,
    };
  },
}));

import { emitToSession, getSessionConnections, registerSessionConnection, shutdownAllSessions } from "./sessionEventBus";

describe("sessionEventBus DLP", () => {
  beforeEach(() => {
    shutdownAllSessions();
    mockSseHandles.clear();
  });

  afterEach(() => {
    shutdownAllSessions();
  });

  it("会话广播命中 DLP deny 时改为 error 事件并关闭连接", () => {
    const conn = registerSessionConnection({
      req: {
        ctx: {
          audit: {
            resourceType: "session",
            action: "events",
          },
        },
      },
      reply: {},
      sessionId: "s-1",
      tenantId: "t-1",
      dlpContext: {
        configOverride: true,
        policyDigest: null,
        policy: {
          version: "v1",
          mode: "deny",
          denyTargets: new Set(["session:events"]),
          denyHitTypes: new Set(["email"]),
        },
      },
    });

    const sent = emitToSession("s-1", "t-1", "delta", { text: "alice@example.com" }, "task-1");
    const handle = Array.from(mockSseHandles.values())[0]!;

    expect(sent).toBe(false);
    expect(handle.events[0]?.event).toBe("error");
    expect((handle.events[0]?.data as any)?.errorCode).toBe("DLP_DENIED");
    expect((handle.events[0]?.data as any)?.blockedEvent).toBe("delta");
    expect(conn.isClosed()).toBe(true);
    expect(getSessionConnections("s-1", "t-1")).toHaveLength(0);
  });
});
