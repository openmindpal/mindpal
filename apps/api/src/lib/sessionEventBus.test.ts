/**
 * TEST-03: sessionEventBus 单元测试
 *
 * 覆盖：注册/注销、按 taskId 路由、广播、创建 QueueEventEmitter 适配器、指标
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/* ── mock sse layer ──────────────────────────────────── */
const mockSseHandles = new Map<string, {
  events: Array<{ event: string; data: unknown }>;
  closed: boolean;
  signal: AbortSignal;
  abortController: AbortController;
}>();

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
        handle.events.push({ event, data });
        return true;
      },
      close: () => { handle.closed = true; ac.abort(); },
      isClosed: () => handle.closed,
      signal: ac.signal,
      abortController: ac,
      _id: id,
    };
  },
}));

import {
  registerSessionConnection,
  unregisterSessionConnection,
  getSessionConnection,
  getSessionConnections,
  hasActiveConnection,
  emitToSession,
  broadcastToSession,
  emitTaskEvent,
  onSessionEvent,
  onTaskEvent,
  createQueueEventEmitter,
  shutdownAllSessions,
  getSessionBusMetrics,
} from "./sessionEventBus";

describe("sessionEventBus", () => {
  beforeEach(() => {
    // Clean up all sessions
    shutdownAllSessions();
    mockSseHandles.clear();
  });

  afterEach(() => {
    shutdownAllSessions();
  });

  describe("registerSessionConnection", () => {
    it("should register a new connection", () => {
      const conn = registerSessionConnection({
        req: {},
        reply: {},
        sessionId: "s-1",
        tenantId: "t-1",
      });
      expect(conn.sessionId).toBe("s-1");
      expect(conn.tenantId).toBe("t-1");
      expect(conn.isClosed()).toBe(false);
    });

    it("should keep multiple active connections for the same session", () => {
      const conn1 = registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });
      const conn2 = registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });
      expect(conn1.isClosed()).toBe(false);
      expect(conn2.isClosed()).toBe(false);
      expect(getSessionConnections("s-1", "t-1")).toHaveLength(2);
    });

    it("should keep separate connections for same sessionId across tenants", () => {
      const conn1 = registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-shared", tenantId: "t-1",
      });
      const conn2 = registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-shared", tenantId: "t-2",
      });
      expect(conn1.isClosed()).toBe(false);
      expect(conn2.isClosed()).toBe(false);
    });
  });

  describe("getSessionConnection / hasActiveConnection", () => {
    it("returns connection for active session", () => {
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });
      expect(getSessionConnection("s-1", "t-1")).not.toBeNull();
      expect(hasActiveConnection("s-1", "t-1")).toBe(true);
    });

    it("returns null for unknown session", () => {
      expect(getSessionConnection("unknown", "t-1")).toBeNull();
      expect(hasActiveConnection("unknown", "t-1")).toBe(false);
    });
  });

  describe("emitToSession", () => {
    it("should inject _taskId into event data", () => {
      const conn = registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });

      emitToSession("s-1", "t-1", "delta", { text: "hello" }, "task-1");

      // Find the SSE handle and check the sent event
      const lastHandle = Array.from(mockSseHandles.values()).pop()!;
      expect(lastHandle.events).toHaveLength(1);
      expect(lastHandle.events[0].event).toBe("delta");
      expect((lastHandle.events[0].data as any)._taskId).toBe("task-1");
      expect((lastHandle.events[0].data as any).text).toBe("hello");
    });

    it("should set _taskId to null for non-task events", () => {
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });

      emitToSession("s-1", "t-1", "info", { msg: "system" });

      const lastHandle = Array.from(mockSseHandles.values()).pop()!;
      expect((lastHandle.events[0].data as any)._taskId).toBeNull();
    });

    it("should fan out events to all active connections in the same session", () => {
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });

      emitToSession("s-1", "t-1", "delta", { text: "hello" }, "task-1");

      const handles = Array.from(mockSseHandles.values());
      expect(handles).toHaveLength(2);
      expect(handles.every((handle) => handle.events.some((event) => event.event === "delta"))).toBe(true);
    });
  });

  describe("broadcastToSession", () => {
    it("should emit with taskId=null", () => {
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });

      broadcastToSession("s-1", "t-1", "queueSnapshot", { entries: [] });

      const lastHandle = Array.from(mockSseHandles.values()).pop()!;
      expect((lastHandle.events[0].data as any)._taskId).toBeNull();
    });
  });

  describe("onSessionEvent / onTaskEvent", () => {
    it("session handler receives all events", () => {
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });

      const received: any[] = [];
      onSessionEvent("s-1", "t-1", (event, data, taskId) => {
        received.push({ event, taskId });
      });

      emitToSession("s-1", "t-1", "ev1", {}, "task-1");
      emitToSession("s-1", "t-1", "ev2", {}, null);

      expect(received).toHaveLength(2);
      expect(received[0].taskId).toBe("task-1");
      expect(received[1].taskId).toBeNull();
    });

    it("task handler only receives matching taskId", () => {
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });

      const received: any[] = [];
      onTaskEvent("s-1", "t-1", "task-1", (event, data, taskId) => {
        received.push({ event, taskId });
      });

      emitToSession("s-1", "t-1", "ev1", {}, "task-1");
      emitToSession("s-1", "t-1", "ev2", {}, "task-2");
      emitToSession("s-1", "t-1", "ev3", {}, null);

      expect(received).toHaveLength(1);
      expect(received[0].taskId).toBe("task-1");
    });

    it("cleanup function removes handler", () => {
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });

      const received: any[] = [];
      const cleanup = onSessionEvent("s-1", "t-1", (event) => {
        received.push(event);
      });

      emitToSession("s-1", "t-1", "ev1", {});
      cleanup();
      emitToSession("s-1", "t-1", "ev2", {});

      expect(received).toHaveLength(1);
    });
  });

  describe("createQueueEventEmitter", () => {
    it("bridges QueueEvent to SSE push", () => {
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });

      const emitter = createQueueEventEmitter();
      emitter.emit({
        type: "taskQueued",
        sessionId: "s-1",
        entryId: "e-1",
        taskId: "task-1",
        data: { goal: "test", tenantId: "t-1" },
        timestamp: new Date().toISOString(),
      });

      const lastHandle = Array.from(mockSseHandles.values()).pop()!;
      expect(lastHandle.events.some((e) => e.event === "taskQueued")).toBe(true);
    });
  });

  describe("shutdownAllSessions", () => {
    it("should close all sessions and send shutdown event", () => {
      const conn1 = registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });
      const conn2 = registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-2", tenantId: "t-1",
      });

      shutdownAllSessions();

      expect(conn1.isClosed()).toBe(true);
      expect(conn2.isClosed()).toBe(true);
    });
  });

  describe("unregisterSessionConnection", () => {
    it("should close all connections for the same session", () => {
      const conn1 = registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });
      const conn2 = registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });

      unregisterSessionConnection("s-1", "t-1");

      expect(conn1.isClosed()).toBe(true);
      expect(conn2.isClosed()).toBe(true);
      expect(getSessionConnections("s-1", "t-1")).toHaveLength(0);
    });
  });

  describe("getSessionBusMetrics", () => {
    it("returns correct metrics", () => {
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-2", tenantId: "t-1",
      });

      const metrics = getSessionBusMetrics();
      expect(metrics.totalSessions).toBe(2);
      expect(metrics.totalConnections).toBe(2);
      expect(metrics.sessionIds).toContain("t-1::s-1");
      expect(metrics.sessionIds).toContain("t-1::s-2");
    });

    it("tracks multiple connections under one session", () => {
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });
      registerSessionConnection({
        req: {}, reply: {},
        sessionId: "s-1", tenantId: "t-1",
      });

      const metrics = getSessionBusMetrics();
      expect(metrics.totalSessions).toBe(1);
      expect(metrics.totalConnections).toBe(2);
    });
  });
});
