import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { clearAll } from "@openslin/device-agent-sdk";
import {
  initPlugin,
  disposePlugin,
  disposeAllPlugins,
  getPluginState,
  getPluginError,
  getPluginResourceLimits,
  listPluginStates,
  registerPluginDirect,
  setCurrentDeviceType,
  getCurrentDeviceType,
  upgradePlugin,
  rollbackPlugin,
  healthcheckPlugin,
  healthcheckAllPlugins,
  setOnCapabilityChanged,
} from "@openslin/device-agent-sdk";
import type { DeviceToolPlugin } from "@openslin/device-agent-sdk";

// Mock capabilityProbe to return null (no device probe by default)
vi.mock("../plugins/capabilityProbe", () => ({
  getCachedCapabilityReport: vi.fn(() => null),
  isToolAvailableOnDevice: vi.fn(() => true),
}));

function makePlugin(overrides: Partial<DeviceToolPlugin> & { name: string }): DeviceToolPlugin {
  return {
    toolPrefixes: [`device.${overrides.name}`],
    execute: vi.fn(async () => ({ status: "succeeded" as const })),
    ...overrides,
  };
}

beforeEach(() => {
  clearAll();
  // Reset internal states by clearing the module-level maps indirectly via clearAll
  // pluginStates/pluginErrors/pluginLimits are module-internal, but we can test
  // by verifying through exported getters
});

afterEach(async () => {
  await disposeAllPlugins();
  clearAll();
});

describe("pluginLifecycle — 初始化", () => {
  it("initializes a plugin successfully and sets state to ready", async () => {
    const plugin = makePlugin({ name: "test-init" });
    const result = await initPlugin(plugin);
    expect(result.success).toBe(true);
    expect(getPluginState("test-init")).toBe("ready");
  });

  it("calls plugin.init() during initialization", async () => {
    const initFn = vi.fn(async () => {});
    const plugin = makePlugin({ name: "init-call", init: initFn });
    await initPlugin(plugin);
    expect(initFn).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate plugin initialization", async () => {
    const plugin = makePlugin({ name: "dup-init" });
    await initPlugin(plugin);
    const result = await initPlugin(plugin);
    expect(result.success).toBe(false);
    expect(result.error).toBe("plugin_already_initialized");
  });

  it("handles init failure gracefully", async () => {
    const plugin = makePlugin({
      name: "fail-init",
      init: async () => { throw new Error("init_boom"); },
    });
    const result = await initPlugin(plugin);
    expect(result.success).toBe(false);
    expect(result.error).toBe("init_boom");
    expect(getPluginState("fail-init")).toBe("error");
  });

  it("handles healthcheck failure during init", async () => {
    const plugin = makePlugin({
      name: "hc-fail",
      healthcheck: async () => ({ healthy: false, details: { reason: "bad" } }),
    });
    const result = await initPlugin(plugin);
    expect(result.success).toBe(false);
    expect(result.error).toBe("healthcheck_failed");
    expect(getPluginState("hc-fail")).toBe("error");
  });

  it("passes when healthcheck succeeds", async () => {
    const plugin = makePlugin({
      name: "hc-ok",
      healthcheck: async () => ({ healthy: true }),
    });
    const result = await initPlugin(plugin);
    expect(result.success).toBe(true);
    expect(getPluginState("hc-ok")).toBe("ready");
  });

  it("registers explicit capabilities during init", async () => {
    const { getCapability } = await import("@openslin/device-agent-sdk");
    const plugin = makePlugin({
      name: "cap-plug",
      toolPrefixes: ["device.cap"],
      capabilities: [{ toolRef: "device.cap.do", riskLevel: "medium" }],
    });
    await initPlugin(plugin);
    expect(getCapability("device.cap.do")?.riskLevel).toBe("medium");
  });
});

describe("pluginLifecycle — 销毁", () => {
  it("disposes a plugin and sets state to disposed", async () => {
    await initPlugin(makePlugin({ name: "disp" }));
    const result = await disposePlugin("disp");
    expect(result.success).toBe(true);
    expect(getPluginState("disp")).toBe("disposed");
  });

  it("calls plugin.dispose() during disposal", async () => {
    const disposeFn = vi.fn(async () => {});
    await initPlugin(makePlugin({ name: "disp-call", dispose: disposeFn }));
    await disposePlugin("disp-call");
    expect(disposeFn).toHaveBeenCalledTimes(1);
  });

  it("returns error for non-existent plugin", async () => {
    const result = await disposePlugin("ghost");
    expect(result.success).toBe(false);
    expect(result.error).toBe("plugin_not_found");
  });

  it("handles dispose error gracefully", async () => {
    await initPlugin(makePlugin({
      name: "disp-err",
      dispose: async () => { throw new Error("dispose_boom"); },
    }));
    const result = await disposePlugin("disp-err");
    expect(result.success).toBe(false);
    expect(result.error).toBe("dispose_boom");
    expect(getPluginState("disp-err")).toBe("error");
  });

  it("disposeAllPlugins disposes multiple plugins", async () => {
    await initPlugin(makePlugin({ name: "multi-a" }));
    await initPlugin(makePlugin({ name: "multi-b" }));
    const result = await disposeAllPlugins();
    expect(result.successCount).toBe(2);
    expect(result.errorCount).toBe(0);
  });
});

describe("pluginLifecycle — 状态查询", () => {
  it("returns undefined for unknown plugin", () => {
    expect(getPluginState("unknown")).toBeUndefined();
  });

  it("listPluginStates returns all plugin states", async () => {
    await initPlugin(makePlugin({ name: "ls-a", toolPrefixes: ["device.lsa"] }));
    await initPlugin(makePlugin({ name: "ls-b", toolPrefixes: ["device.lsb"] }));
    const states = listPluginStates();
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.state === "ready")).toBe(true);
  });

  it("getPluginResourceLimits returns enforced limits", async () => {
    await initPlugin(makePlugin({
      name: "limits",
      resourceLimits: { maxMemoryMb: 100, maxConcurrency: 5 },
    }));
    const limits = getPluginResourceLimits("limits");
    // desktop maxMemoryMb cap is 50, so should be clamped
    expect(limits?.maxMemoryMb).toBeLessThanOrEqual(50);
  });
});

describe("pluginLifecycle — 设备类型", () => {
  it("gets and sets current device type", () => {
    setCurrentDeviceType("mobile");
    expect(getCurrentDeviceType()).toBe("mobile");
    setCurrentDeviceType("desktop");
  });
});

describe("pluginLifecycle — 升级与回滚", () => {
  it("upgrade calls plugin.upgrade on ready plugin", async () => {
    const upgradeFn = vi.fn(async () => {});
    await initPlugin(makePlugin({ name: "up", upgrade: upgradeFn }));
    const result = await upgradePlugin("up", "2.0.0");
    expect(result.success).toBe(true);
    expect(upgradeFn).toHaveBeenCalledWith("2.0.0");
  });

  it("upgrade fails if plugin has no upgrade method", async () => {
    await initPlugin(makePlugin({ name: "no-up" }));
    const result = await upgradePlugin("no-up", "2.0.0");
    expect(result.success).toBe(false);
    expect(result.error).toBe("upgrade_not_supported");
  });

  it("rollback works on ready plugin", async () => {
    const rollbackFn = vi.fn(async () => {});
    await initPlugin(makePlugin({ name: "rb", rollback: rollbackFn }));
    const result = await rollbackPlugin("rb", "0.9.0");
    expect(result.success).toBe(true);
    expect(rollbackFn).toHaveBeenCalledWith("0.9.0");
  });
});

describe("pluginLifecycle — registerPluginDirect", () => {
  it("registers plugin directly without init/healthcheck", () => {
    const plugin = makePlugin({ name: "direct" });
    registerPluginDirect(plugin);
    expect(getPluginState("direct")).toBe("ready");
  });
});

describe("pluginLifecycle — 能力变更回调", () => {
  it("fires onCapabilityChanged callback on init", async () => {
    const cb = vi.fn();
    setOnCapabilityChanged(cb);
    await initPlugin(makePlugin({ name: "cb-test" }));
    expect(cb).toHaveBeenCalled();
    setOnCapabilityChanged(null);
  });
});
