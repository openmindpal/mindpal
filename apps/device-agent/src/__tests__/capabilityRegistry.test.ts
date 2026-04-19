import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  registerCapability,
  registerCapabilities,
  unregisterCapability,
  getCapability,
  findCapabilitiesByPrefix,
  findCapabilitiesByRiskLevel,
  findCapabilitiesByTag,
  listCapabilities,
  getToolRiskLevel,
  registerPlugin,
  unregisterPlugin,
  findPluginForTool,
  listPlugins,
  exportCapabilityManifest,
  registerToolAlias,
  registerToolAliases,
  resolveToolAlias,
  registerPrefixRule,
  registerPrefixRules,
  listToolAliases,
  listPrefixRules,
  loadAliasesFromEnv,
  clearAll,
} from "../kernel/capabilityRegistry";
import type { CapabilityDescriptor, DeviceToolPlugin } from "../kernel/types";

function makeCap(overrides: Partial<CapabilityDescriptor> & { toolRef: string }): CapabilityDescriptor {
  return { riskLevel: "low", ...overrides };
}

function makePlugin(overrides: Partial<DeviceToolPlugin> & { name: string; toolPrefixes: string[] }): DeviceToolPlugin {
  return {
    execute: vi.fn(async () => ({ status: "succeeded" as const })),
    ...overrides,
  };
}

beforeEach(() => {
  clearAll();
});

describe("capabilityRegistry — 能力注册与查询", () => {
  it("registers a capability and retrieves it by toolRef", () => {
    const cap = makeCap({ toolRef: "device.sensor.read", riskLevel: "low", tags: ["sensor"] });
    registerCapability(cap);
    expect(getCapability("device.sensor.read")).toEqual(cap);
  });

  it("throws on duplicate registration", () => {
    registerCapability(makeCap({ toolRef: "device.file.read" }));
    expect(() => registerCapability(makeCap({ toolRef: "device.file.read" }))).toThrow("capability_already_registered");
  });

  it("validates toolRef is required", () => {
    expect(() => registerCapability({ toolRef: "", riskLevel: "low" })).toThrow("capability_invalid_toolRef");
  });

  it("validates riskLevel must be valid", () => {
    expect(() => registerCapability({ toolRef: "device.x", riskLevel: "extreme" as any })).toThrow("capability_invalid_risk_level");
  });

  it("validates inputSchema must be an object", () => {
    expect(() => registerCapability({ toolRef: "device.x", riskLevel: "low", inputSchema: "bad" as any })).toThrow("capability_invalid_input_schema");
  });

  it("batch-registers multiple capabilities", () => {
    const caps = [
      makeCap({ toolRef: "device.a.one" }),
      makeCap({ toolRef: "device.a.two" }),
    ];
    registerCapabilities(caps);
    expect(listCapabilities()).toHaveLength(2);
  });

  it("unregisters a capability", () => {
    registerCapability(makeCap({ toolRef: "device.del.me" }));
    expect(unregisterCapability("device.del.me")).toBe(true);
    expect(getCapability("device.del.me")).toBeNull();
  });

  it("returns null for non-existent capability", () => {
    expect(getCapability("device.nope")).toBeNull();
  });

  it("finds capabilities by prefix", () => {
    registerCapabilities([
      makeCap({ toolRef: "device.browser.open" }),
      makeCap({ toolRef: "device.browser.close" }),
      makeCap({ toolRef: "device.file.read" }),
    ]);
    expect(findCapabilitiesByPrefix("device.browser")).toHaveLength(2);
  });

  it("finds capabilities by risk level", () => {
    registerCapabilities([
      makeCap({ toolRef: "device.a", riskLevel: "high" }),
      makeCap({ toolRef: "device.b", riskLevel: "low" }),
      makeCap({ toolRef: "device.c", riskLevel: "high" }),
    ]);
    expect(findCapabilitiesByRiskLevel("high")).toHaveLength(2);
  });

  it("finds capabilities by tag", () => {
    registerCapabilities([
      makeCap({ toolRef: "device.x", tags: ["io", "fast"] }),
      makeCap({ toolRef: "device.y", tags: ["io"] }),
      makeCap({ toolRef: "device.z", tags: ["slow"] }),
    ]);
    expect(findCapabilitiesByTag("io")).toHaveLength(2);
  });

  it("getToolRiskLevel returns the risk level or undefined", () => {
    registerCapability(makeCap({ toolRef: "device.sensor.read", riskLevel: "medium" }));
    expect(getToolRiskLevel("device.sensor.read")).toBe("medium");
    expect(getToolRiskLevel("device.nope")).toBeUndefined();
  });
});

describe("capabilityRegistry — 插件注册", () => {
  it("registers a plugin with explicit capabilities", () => {
    const plugin = makePlugin({
      name: "test-plug",
      toolPrefixes: ["device.test"],
      capabilities: [makeCap({ toolRef: "device.test.run", riskLevel: "medium" })],
    });
    registerPlugin(plugin);
    expect(listPlugins()).toHaveLength(1);
    expect(getCapability("device.test.run")?.riskLevel).toBe("medium");
  });

  it("infers capabilities from toolNames when no explicit capabilities", () => {
    const plugin = makePlugin({
      name: "infer-plug",
      toolPrefixes: ["device.sensor"],
      toolNames: ["device.sensor.read", "device.sensor.delete", "other.tool"],
      version: "2.0.0",
    });
    registerPlugin(plugin);
    // device.sensor.read → low, device.sensor.delete → high (contains "delete")
    expect(getCapability("device.sensor.read")?.riskLevel).toBe("low");
    expect(getCapability("device.sensor.delete")?.riskLevel).toBe("high");
    // "other.tool" doesn't start with "device." so not registered
    expect(getCapability("other.tool")).toBeNull();
  });

  it("throws on duplicate plugin registration", () => {
    registerPlugin(makePlugin({ name: "dup", toolPrefixes: ["device.dup"] }));
    expect(() => registerPlugin(makePlugin({ name: "dup", toolPrefixes: ["device.dup2"] }))).toThrow("plugin_already_registered");
  });

  it("unregisters plugin and its capabilities", () => {
    registerPlugin(makePlugin({
      name: "rm-plug",
      toolPrefixes: ["device.rm"],
      capabilities: [makeCap({ toolRef: "device.rm.action" })],
    }));
    expect(getCapability("device.rm.action")).not.toBeNull();
    unregisterPlugin("rm-plug");
    expect(listPlugins()).toHaveLength(0);
    expect(getCapability("device.rm.action")).toBeNull();
  });

  it("finds the best matching plugin for a tool (longest prefix)", () => {
    registerPlugin(makePlugin({ name: "broad", toolPrefixes: ["device.gui"] }));
    registerPlugin(makePlugin({ name: "specific", toolPrefixes: ["device.gui.automation"] }));
    expect(findPluginForTool("device.gui.automation.click")?.name).toBe("specific");
    expect(findPluginForTool("device.gui.screenshot")?.name).toBe("broad");
    expect(findPluginForTool("device.other.x")).toBeNull();
  });

  it("exports capability manifest with pluginName", () => {
    registerPlugin(makePlugin({
      name: "manifest-plug",
      toolPrefixes: ["device.mfst"],
      capabilities: [makeCap({ toolRef: "device.mfst.a", riskLevel: "high", version: "1.0" })],
    }));
    const manifest = exportCapabilityManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].toolRef).toBe("device.mfst.a");
    expect(manifest[0].pluginName).toBe("manifest-plug");
  });
});

describe("capabilityRegistry — 别名与前缀规则", () => {
  it("registers and resolves a tool alias", () => {
    registerToolAlias("browser.navigate", "device.browser.open");
    expect(resolveToolAlias("browser.navigate")).toBe("device.browser.open");
  });

  it("batch-registers tool aliases", () => {
    registerToolAliases({ "a.b": "device.a.b", "c.d": "device.c.d" });
    expect(resolveToolAlias("a.b")).toBe("device.a.b");
    expect(resolveToolAlias("c.d")).toBe("device.c.d");
  });

  it("resolves prefix rules when no explicit alias matches", () => {
    registerPrefixRule("sensor.", "device.sensor.");
    expect(resolveToolAlias("sensor.read")).toBe("device.sensor.read");
  });

  it("batch-registers prefix rules", () => {
    registerPrefixRules({ "io.": "device.io.", "net.": "device.net." });
    expect(resolveToolAlias("io.write")).toBe("device.io.write");
    expect(resolveToolAlias("net.fetch")).toBe("device.net.fetch");
  });

  it("returns original name when no alias or prefix matches", () => {
    expect(resolveToolAlias("unknown.tool")).toBe("unknown.tool");
  });

  it("lists registered aliases and prefix rules", () => {
    registerToolAlias("x", "y");
    registerPrefixRule("a.", "b.");
    expect(listToolAliases()).toEqual({ x: "y" });
    expect(listPrefixRules()).toEqual({ "a.": "b." });
  });

  it("loads aliases from environment variables", () => {
    process.env["DEVICE_TOOL_ALIAS_MY_CUSTOM_TOOL"] = "device.custom.tool";
    const count = loadAliasesFromEnv();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(resolveToolAlias("my.custom.tool")).toBe("device.custom.tool");
    delete process.env["DEVICE_TOOL_ALIAS_MY_CUSTOM_TOOL"];
  });
});
