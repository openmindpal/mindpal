import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket } = vi.hoisted(() => {
  class HoistedFakeWebSocket {
    static OPEN = 1;
    static instances: HoistedFakeWebSocket[] = [];
    readyState = HoistedFakeWebSocket.OPEN;
    private listeners = new Map<string, Array<(...args: any[]) => void>>();

    constructor(public url: string, public options: Record<string, unknown>) {
      HoistedFakeWebSocket.instances.push(this);
    }

    on(event: string, handler: (...args: any[]) => void) {
      const arr = this.listeners.get(event) ?? [];
      arr.push(handler);
      this.listeners.set(event, arr);
    }

    emit(event: string, ...args: any[]) {
      const arr = this.listeners.get(event) ?? [];
      for (const handler of arr) handler(...args);
    }

    send(_data: string | Buffer) {}

    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }

  return { FakeWebSocket: HoistedFakeWebSocket };
});

vi.mock("ws", () => ({
  WebSocket: FakeWebSocket,
}));

vi.mock("./log", () => ({
  safeLog: vi.fn(),
  safeError: vi.fn(),
}));

vi.mock("./wsMessageHandlers", () => ({
  handleTaskPending: vi.fn(),
  handleDeviceMessage: vi.fn(),
  sendTaskResult: vi.fn(),
}));

vi.mock("./wsStreamingHandlers", () => ({
  handleStreamingStart: vi.fn(),
  handleStreamingStep: vi.fn(),
  handleStreamingStop: vi.fn(),
  handleStreamingPause: vi.fn(),
  handleStreamingResume: vi.fn(),
}));

import { WebSocketDeviceAgent } from "./websocketClient";

describe("WebSocketDeviceAgent reconnect lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stop does not schedule reconnect after socket close", async () => {
    const agent = new WebSocketDeviceAgent({
      apiBase: "http://localhost:3000",
      deviceId: "device-1",
      deviceToken: "token-1",
    } as any);

    const connectPromise = agent.connect();
    FakeWebSocket.instances[0]!.emit("open");
    await connectPromise;

    agent.stop();
    await vi.runAllTimersAsync();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("unexpected close still schedules reconnect", async () => {
    const agent = new WebSocketDeviceAgent({
      apiBase: "http://localhost:3000",
      deviceId: "device-1",
      deviceToken: "token-1",
    } as any);

    const connectPromise = agent.connect();
    FakeWebSocket.instances[0]!.emit("open");
    await connectPromise;

    FakeWebSocket.instances[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
