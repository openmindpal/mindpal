import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DeviceIdentity, loadConfigFile, saveConfigFile, defaultConfigPath, defaultLockPath } from "../kernel/identity";
import type { DeviceAgentConfig } from "../kernel/types";

// Mock fs
vi.mock("node:fs/promises", () => {
  const store = new Map<string, string>();
  return {
    default: {
      readFile: vi.fn(async (p: string) => {
        const content = store.get(p);
        if (content === undefined) throw new Error("ENOENT");
        return content;
      }),
      writeFile: vi.fn(async (p: string, data: string) => {
        store.set(p, data);
      }),
      mkdir: vi.fn(async () => {}),
      unlink: vi.fn(async (p: string) => {
        store.delete(p);
      }),
    },
    __store: store,
  };
});

async function getStore(): Promise<Map<string, string>> {
  const mod = await import("node:fs/promises") as any;
  return mod.__store;
}

beforeEach(async () => {
  const store = await getStore();
  store.clear();
});

describe("identity — 配置路径", () => {
  it("defaultConfigPath returns a path ending with device-agent.json", () => {
    expect(defaultConfigPath()).toMatch(/device-agent\.json$/);
  });

  it("defaultLockPath returns a path ending with device-agent.lock", () => {
    expect(defaultLockPath()).toMatch(/device-agent\.lock$/);
  });
});

describe("identity — 配置读写", () => {
  it("loadConfigFile returns null for missing file", async () => {
    const result = await loadConfigFile("/nonexistent/path.json");
    expect(result).toBeNull();
  });

  it("saveConfigFile + loadConfigFile round-trip", async () => {
    const cfg: DeviceAgentConfig = {
      apiBase: "http://localhost:3001",
      deviceId: "dev-123",
      deviceToken: "tok-abc",
      enrolledAt: "2025-01-01T00:00:00Z",
      deviceType: "desktop",
      os: "windows",
      agentVersion: "1.0.0",
    };
    const p = "/tmp/test-config.json";
    await saveConfigFile(p, cfg);
    const loaded = await loadConfigFile(p);
    expect(loaded).toEqual(cfg);
  });

  it("loadConfigFile returns null for invalid JSON", async () => {
    const store = await getStore();
    store.set("/tmp/bad.json", "not-json!!!");
    const result = await loadConfigFile("/tmp/bad.json");
    expect(result).toBeNull();
  });
});

describe("identity — DeviceIdentity 生命周期", () => {
  const configPath = "/tmp/identity-test.json";

  it("initializes in unenrolled state", () => {
    const id = new DeviceIdentity(configPath);
    expect(id.state).toBe("unenrolled");
    expect(id.config).toBeNull();
    expect(id.deviceId).toBeNull();
    expect(id.deviceToken).toBeNull();
  });

  it("load returns false for non-existent config", async () => {
    const id = new DeviceIdentity(configPath);
    const loaded = await id.load();
    expect(loaded).toBe(false);
    expect(id.state).toBe("unenrolled");
  });

  it("load returns true and sets state to paired when config exists", async () => {
    const cfg: DeviceAgentConfig = {
      apiBase: "http://localhost:3001",
      deviceId: "dev-1",
      deviceToken: "tok-1",
      enrolledAt: "2025-01-01",
      deviceType: "desktop",
      os: "linux",
      agentVersion: "1.0.0",
    };
    await saveConfigFile(configPath, cfg);
    const id = new DeviceIdentity(configPath);
    const loaded = await id.load();
    expect(loaded).toBe(true);
    expect(id.state).toBe("paired");
    expect(id.deviceId).toBe("dev-1");
    expect(id.deviceToken).toBe("tok-1");
  });

  it("pair succeeds with valid API response", async () => {
    const id = new DeviceIdentity(configPath);
    const mockApi = vi.fn(async () => ({
      status: 200,
      json: { deviceId: "dev-new", deviceToken: "tok-new" },
    }));

    const result = await id.pair({
      pairingCode: "CODE123",
      apiBase: "http://localhost:3001",
      deviceType: "desktop",
      os: "windows",
      agentVersion: "1.0.0",
      apiPostFn: mockApi,
    });

    expect(result.success).toBe(true);
    expect(id.state).toBe("paired");
    expect(id.deviceId).toBe("dev-new");
    expect(id.deviceToken).toBe("tok-new");
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it("pair fails with non-200 status", async () => {
    const id = new DeviceIdentity(configPath);
    const result = await id.pair({
      pairingCode: "BADCODE",
      apiBase: "http://localhost:3001",
      deviceType: "desktop",
      os: "windows",
      agentVersion: "1.0.0",
      apiPostFn: async () => ({ status: 401, json: {} }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("pair_failed_401");
    expect(id.state).toBe("unenrolled");
  });

  it("pair fails with missing deviceId/Token in response", async () => {
    const id = new DeviceIdentity(configPath);
    const result = await id.pair({
      pairingCode: "CODE",
      apiBase: "http://localhost:3001",
      deviceType: "desktop",
      os: "windows",
      agentVersion: "1.0.0",
      apiPostFn: async () => ({ status: 200, json: {} }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("pair_invalid_response");
  });

  it("revoke sets state to revoked and clears config", async () => {
    const id = new DeviceIdentity(configPath);
    // pair first
    await id.pair({
      pairingCode: "C",
      apiBase: "http://localhost:3001",
      deviceType: "desktop",
      os: "win",
      agentVersion: "1.0.0",
      apiPostFn: async () => ({ status: 200, json: { deviceId: "d", deviceToken: "t" } }),
    });
    expect(id.state).toBe("paired");

    await id.revoke();
    expect(id.state).toBe("revoked");
    expect(id.config).toBeNull();
  });

  it("rotateToken updates the token on success", async () => {
    const id = new DeviceIdentity(configPath);
    await id.pair({
      pairingCode: "C",
      apiBase: "http://localhost:3001",
      deviceType: "desktop",
      os: "win",
      agentVersion: "1.0.0",
      apiPostFn: async () => ({ status: 200, json: { deviceId: "d1", deviceToken: "old-tok" } }),
    });

    const rotateResult = await id.rotateToken({
      apiPostFn: async () => ({ status: 200, json: { deviceToken: "new-tok" } }),
    });

    expect(rotateResult.success).toBe(true);
    expect(id.deviceToken).toBe("new-tok");
  });

  it("rotateToken fails when not paired", async () => {
    const id = new DeviceIdentity(configPath);
    const result = await id.rotateToken({
      apiPostFn: async () => ({ status: 200, json: { deviceToken: "t" } }),
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("not_paired");
  });

  it("reEnroll revokes then re-pairs", async () => {
    const id = new DeviceIdentity(configPath);
    await id.pair({
      pairingCode: "C",
      apiBase: "http://localhost:3001",
      deviceType: "desktop",
      os: "win",
      agentVersion: "1.0.0",
      apiPostFn: async () => ({ status: 200, json: { deviceId: "d1", deviceToken: "t1" } }),
    });

    const result = await id.reEnroll({
      pairingCode: "NEW",
      apiBase: "http://localhost:3001",
      deviceType: "mobile",
      os: "android",
      agentVersion: "2.0.0",
      apiPostFn: async () => ({ status: 200, json: { deviceId: "d2", deviceToken: "t2" } }),
    });

    expect(result.success).toBe(true);
    expect(id.state).toBe("paired");
    expect(id.deviceId).toBe("d2");
  });
});
