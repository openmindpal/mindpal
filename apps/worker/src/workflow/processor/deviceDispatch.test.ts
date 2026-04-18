import { describe, expect, it } from "vitest";
import { deviceToolRequiresUserPresence, isDeviceTool, isDeviceExecutionStale } from "./deviceDispatch";

describe("deviceDispatch", () => {
  it("识别 browser.* 和 desktop.* 为设备工具", () => {
    expect(isDeviceTool("browser.screenshot")).toBe(true);
    expect(isDeviceTool("desktop.window.list")).toBe(true);
    expect(isDeviceTool("memory.write")).toBe(false);
  });

  it("为截图与导航别名要求用户在场", () => {
    expect(deviceToolRequiresUserPresence("browser.navigate")).toBe(true);
    expect(deviceToolRequiresUserPresence("browser.screenshot")).toBe(true);
    expect(deviceToolRequiresUserPresence("desktop.screen.capture")).toBe(true);
    expect(deviceToolRequiresUserPresence("desktop.window.list")).toBe(false);
  });

  it("识别长时间未领取或设备离线的执行为陈旧任务", () => {
    expect(isDeviceExecutionStale({
      execution: {
        status: "pending",
        createdAt: "2026-03-30T00:00:00.000Z",
        claimedAt: null,
      },
      nowMs: Date.parse("2026-03-30T00:01:00.000Z"),
      deviceLastSeenAt: "2026-03-30T00:00:59.000Z",
      deviceStatus: "active",
    })).toBe(true);

    expect(isDeviceExecutionStale({
      execution: {
        status: "claimed",
        createdAt: "2026-03-30T00:00:00.000Z",
        claimedAt: "2026-03-30T00:00:10.000Z",
      },
      nowMs: Date.parse("2026-03-30T00:00:20.000Z"),
      deviceLastSeenAt: "2026-03-30T00:00:19.000Z",
      deviceStatus: "active",
    })).toBe(false);

    expect(isDeviceExecutionStale({
      execution: {
        status: "pending",
        createdAt: "2026-03-30T00:00:00.000Z",
        claimedAt: null,
      },
      nowMs: Date.parse("2026-03-30T00:00:20.000Z"),
      deviceLastSeenAt: "2026-03-29T23:58:00.000Z",
      deviceStatus: "active",
    })).toBe(true);
  });
});
