import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { clearAll, getCapability } from "@openslin/device-agent-sdk";
import { initPlugin, getPluginState, disposeAllPlugins } from "@openslin/device-agent-sdk";
import { assertKernelManifest, validatePluginBoundary } from "@openslin/device-agent-sdk";
import { getHeartbeatStatus, initSessionManager, sendHeartbeat, shutdownSessionManager } from "@openslin/device-agent-sdk";
import desktopPlugin from "../plugins/desktopPlugin";
import guiAutomationPlugin from "../plugins/guiAutomationPlugin";

afterEach(async () => {
  shutdownSessionManager();
  await disposeAllPlugins();
  clearAll();
});

describe("kernel runtime", () => {
  it("registers inferred device capabilities through plugin lifecycle", async () => {
    const plugin = {
      name: "test-plugin",
      version: "1.0.0",
      toolPrefixes: ["device.sensor"],
      toolNames: ["device.sensor.read", "browser.navigate"],
      execute: vi.fn(async () => ({ status: "succeeded" as const })),
    };

    const result = await initPlugin(plugin);

    expect(result.success).toBe(true);
    expect(getPluginState(plugin.name)).toBe("ready");
    expect(getCapability("device.sensor.read")?.riskLevel).toBe("low");
    expect(getCapability("browser.navigate")).toBeNull();
  });

  it("rejects invalid explicit capability manifests", async () => {
    const result = await initPlugin({
      name: "broken-plugin",
      version: "1.0.0",
      toolPrefixes: ["device.robot"],
      capabilities: [
        {
          toolRef: "device.robot.move",
          riskLevel: "high",
          inputSchema: "invalid" as unknown as Record<string, unknown>,
        },
      ],
      execute: vi.fn(async () => ({ status: "succeeded" as const })),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("capability_invalid_input_schema");
  });

  it("uses the configured heartbeat sender", async () => {
    const sender = vi.fn(async () => ({ status: 200, json: { ok: true } }));

    initSessionManager(
      {
        apiBase: "http://127.0.0.1:3001",
        deviceToken: "tok",
        deviceId: "dev-1",
        os: "windows",
        agentVersion: "1.0.0",
        intervalMs: 60_000,
        enabled: true,
      },
      sender,
    );

    await sendHeartbeat();

    expect(sender).toHaveBeenCalledTimes(2);
    expect(getHeartbeatStatus().healthy).toBe(true);
  });

  it("validates manifest and plugin boundary declarations against the source tree", () => {
    const baseDir = path.resolve(__dirname, "..");

    // kernel modules now live in SDK; use default path (SDK internal)
    expect(() => assertKernelManifest()).not.toThrow();
    // plugin files still live in device-agent src
    expect(validatePluginBoundary(baseDir)).toEqual([]);
  });

  it("ships explicit capability manifests for built-in example plugins", () => {
    expect(desktopPlugin.capabilities?.every((cap) => cap.toolRef.startsWith("device."))).toBe(true);
    expect(desktopPlugin.capabilities?.length).toBe(desktopPlugin.toolNames?.length);
    expect(new Set(desktopPlugin.capabilities?.map((cap) => cap.toolRef))).toEqual(new Set(desktopPlugin.toolNames));
    expect(desktopPlugin.capabilities?.every((cap) => cap.inputSchema && cap.outputSchema && cap.resourceRequirements && typeof cap.version === "string")).toBe(true);
    expect(desktopPlugin.resourceLimits?.maxConcurrency).toBe(2);
    expect(guiAutomationPlugin.capabilities?.map((cap) => cap.toolRef)).toEqual([
      "device.gui.runPlan",
      "device.gui.findAndClick",
      "device.gui.findAndType",
      "device.gui.readScreen",
      "device.gui.screenshot",
    ]);
    expect(guiAutomationPlugin.capabilities?.every((cap) => cap.inputSchema && cap.outputSchema && cap.resourceRequirements && typeof cap.version === "string")).toBe(true);
    expect(guiAutomationPlugin.resourceLimits?.maxConcurrency).toBe(1);
  });
});
