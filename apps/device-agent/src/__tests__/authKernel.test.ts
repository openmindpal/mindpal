import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import {
  initAccessControl,
  generateCallerToken,
  verifyCallerToken,
  isCallerAllowed,
  isToolAllowed,
  getOrCreateContext,
  getContext,
  destroyContext,
  cleanupExpiredContexts,
  getContextState,
  setContextState,
  deleteContextState,
  extractCallerFromRequest,
  // 策略缓存部分
  initPolicyCache,
  cachePolicy,
  getCachedPolicy,
  hasCachedPolicy,
  isCachedToolAllowed,
  getCachedPolicyForExecution,
  clearPolicyCache,
  syncPolicyToCache,
  buildOfflineClaim,
  getPolicyCacheStatus,
} from "@openslin/device-agent-sdk";
import type { CachedPolicy, PolicyCacheEntry } from "@openslin/device-agent-sdk";

// Mock fs 模块，避免真实磁盘操作
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("kernel/auth - 第一部分：调用方鉴权与执行上下文", () => {
  beforeEach(() => {
    initAccessControl({ secretKey: "kernel-test-secret-key", policy: {} });
    // 清理残留上下文
    destroyContext("caller-a");
    destroyContext("caller-b");
  });

  // ── Token 验证 ──────────────────────────────────────────────

  describe("Token 生成与验证", () => {
    it("生成并验证 Token 完整流程", () => {
      const token = generateCallerToken({
        callerId: "svc-1",
        callerType: "api",
        tenantId: "tenant-a",
        subjectId: "user-42",
      });
      const identity = verifyCallerToken(token);
      expect(identity).not.toBeNull();
      expect(identity!.callerId).toBe("svc-1");
      expect(identity!.callerType).toBe("api");
      expect(identity!.tenantId).toBe("tenant-a");
      expect(identity!.subjectId).toBe("user-42");
    });

    it("无 secretKey 时生成 Token 抛出异常", () => {
      initAccessControl({ secretKey: "" });
      expect(() =>
        generateCallerToken({ callerId: "u1", callerType: "api" })
      ).toThrow("device_agent_secret_key_required");
    });

    it("签名被篡改的 Token 验证失败", () => {
      const token = generateCallerToken({ callerId: "u1", callerType: "local" });
      const [payload] = token.split(".");
      expect(verifyCallerToken(`${payload}.wrong-sig`)).toBeNull();
    });

    it("过期 Token 验证返回 null", () => {
      const token = generateCallerToken({
        callerId: "u1",
        callerType: "api",
        expiresInMs: 1,
      });
      vi.useFakeTimers();
      vi.advanceTimersByTime(50);
      expect(verifyCallerToken(token)).toBeNull();
      vi.useRealTimers();
    });

    it("空字符串和格式错误 Token 返回 null", () => {
      expect(verifyCallerToken("")).toBeNull();
      expect(verifyCallerToken("one-part-only")).toBeNull();
      expect(verifyCallerToken("a.b.c")).toBeNull();
    });

    it("callerType 为 plugin 时正确解析", () => {
      const token = generateCallerToken({ callerId: "p1", callerType: "plugin" });
      const identity = verifyCallerToken(token);
      expect(identity!.callerType).toBe("plugin");
    });
  });

  // ── 调用方与工具权限 ────────────────────────────────────────

  describe("权限检查", () => {
    it("空策略允许所有调用方和工具", () => {
      expect(isCallerAllowed("anyone")).toBe(true);
      expect(isToolAllowed("anyone", "any-tool")).toBe(true);
    });

    it("allowedCallers 限制调用方", () => {
      initAccessControl({ secretKey: "k", policy: { allowedCallers: ["a", "b"] } });
      expect(isCallerAllowed("a")).toBe(true);
      expect(isCallerAllowed("c")).toBe(false);
    });

    it("allowedTools 限制工具", () => {
      initAccessControl({ secretKey: "k", policy: { allowedTools: ["t1"] } });
      expect(isToolAllowed("caller", "t1")).toBe(true);
      expect(isToolAllowed("caller", "t2")).toBe(false);
    });

    it("上下文级 toolPermissions 细粒度控制", () => {
      initAccessControl({ secretKey: "k", policy: {} });
      getOrCreateContext("caller-a", ["permitted-tool"]);
      expect(isToolAllowed("caller-a", "permitted-tool")).toBe(true);
      expect(isToolAllowed("caller-a", "other-tool")).toBe(false);
    });

    it("全局策略拒绝优先于上下文允许", () => {
      initAccessControl({ secretKey: "k", policy: { allowedTools: ["t1"] } });
      getOrCreateContext("caller-a", ["t2"]);
      expect(isToolAllowed("caller-a", "t2")).toBe(false);
    });
  });

  // ── 执行上下文 ──────────────────────────────────────────────

  describe("执行上下文管理", () => {
    it("创建并复用上下文", () => {
      const ctx1 = getOrCreateContext("caller-a");
      const ctx2 = getOrCreateContext("caller-a");
      expect(ctx2.contextId).toBe(ctx1.contextId);
    });

    it("更新 toolPermissions", () => {
      getOrCreateContext("caller-a", ["t1"]);
      const ctx = getOrCreateContext("caller-a", ["t2"]);
      expect(ctx.toolPermissions.has("t2")).toBe(true);
      expect(ctx.toolPermissions.has("t1")).toBe(false);
    });

    it("销毁上下文", () => {
      getOrCreateContext("caller-a");
      expect(destroyContext("caller-a")).toBe(true);
      expect(getContext("caller-a")).toBeNull();
    });

    it("上下文状态 set/get/delete", () => {
      getOrCreateContext("caller-a");
      expect(setContextState("caller-a", "foo", 42)).toBe(true);
      expect(getContextState("caller-a", "foo")).toBe(42);
      expect(deleteContextState("caller-a", "foo")).toBe(true);
      expect(getContextState("caller-a", "foo")).toBeUndefined();
    });

    it("不存在的上下文操作安全返回", () => {
      expect(setContextState("ghost", "k", "v")).toBe(false);
      expect(getContextState("ghost", "k")).toBeUndefined();
      expect(deleteContextState("ghost", "k")).toBe(false);
      expect(getContext("ghost")).toBeNull();
      expect(destroyContext("ghost")).toBe(false);
    });

    it("cleanupExpiredContexts 清理过期上下文", () => {
      initAccessControl({ secretKey: "k", policy: { maxContextAge: 500 } });
      getOrCreateContext("caller-a");
      vi.useFakeTimers();
      vi.advanceTimersByTime(1000);
      const cleaned = cleanupExpiredContexts();
      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(getContext("caller-a")).toBeNull();
      vi.useRealTimers();
    });
  });

  // ── extractCallerFromRequest ────────────────────────────────

  describe("extractCallerFromRequest", () => {
    it("Bearer Token 优先", () => {
      const token = generateCallerToken({ callerId: "u1", callerType: "api" });
      const id = extractCallerFromRequest({ authHeader: `Bearer ${token}` });
      expect(id).not.toBeNull();
      expect(id!.callerId).toBe("u1");
    });

    it("无效 Bearer 时回退到 deviceToken", () => {
      const id = extractCallerFromRequest({
        authHeader: "Bearer bad",
        deviceToken: "dt-123",
      });
      expect(id).not.toBeNull();
      expect(id!.callerId).toMatch(/^device:/);
    });

    it("无凭证时返回 null", () => {
      expect(extractCallerFromRequest({})).toBeNull();
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 第二部分：策略缓存
// ══════════════════════════════════════════════════════════════

describe("kernel/auth - 第二部分：策略缓存", () => {
  beforeEach(async () => {
    await clearPolicyCache();
    await initPolicyCache({
      deviceId: "dev-test-001",
      cacheDir: "/tmp/test-policy-cache",
      maxAgeMs: 60_000,
      enabled: true,
    });
  });

  afterEach(async () => {
    await clearPolicyCache();
  });

  const samplePolicy: CachedPolicy = {
    allowedTools: ["device.file.read", "device.browser.open"],
    filePolicy: { allowRead: true },
    networkPolicy: { allowOutbound: true },
    uiPolicy: null,
    evidencePolicy: null,
    clipboardPolicy: null,
    limits: null,
    toolFeatureFlags: null,
    degradationRules: null,
    circuitBreakerConfig: null,
  };

  // ── 缓存命中与过期 ─────────────────────────────────────────

  describe("策略缓存命中与过期", () => {
    it("缓存策略后能成功获取", async () => {
      const entry = await cachePolicy(samplePolicy);
      expect(entry.deviceId).toBe("dev-test-001");
      expect(entry.version).toBe(1);
      expect(entry.policyDigest).toBeTruthy();

      const cached = getCachedPolicy();
      expect(cached).not.toBeNull();
      expect(cached!.policy.allowedTools).toEqual(["device.file.read", "device.browser.open"]);
    });

    it("hasCachedPolicy 正确反映缓存状态", async () => {
      expect(hasCachedPolicy()).toBe(false);
      await cachePolicy(samplePolicy);
      expect(hasCachedPolicy()).toBe(true);
    });

    it("缓存过期后 getCachedPolicy 返回 null", async () => {
      // 使用极短的 maxAgeMs
      await clearPolicyCache();
      await initPolicyCache({
        deviceId: "dev-test-001",
        cacheDir: "/tmp/test-policy-cache",
        maxAgeMs: 1,
        enabled: true,
      });
      await cachePolicy(samplePolicy);

      vi.useFakeTimers();
      vi.advanceTimersByTime(50);
      expect(getCachedPolicy()).toBeNull();
      expect(hasCachedPolicy()).toBe(false);
      vi.useRealTimers();
    });

    it("clearPolicyCache 清空缓存", async () => {
      await cachePolicy(samplePolicy);
      expect(hasCachedPolicy()).toBe(true);
      await clearPolicyCache();
      expect(hasCachedPolicy()).toBe(false);
    });

    it("缓存版本递增", async () => {
      const e1 = await cachePolicy(samplePolicy);
      expect(e1.version).toBe(1);
      const e2 = await cachePolicy({ ...samplePolicy, allowedTools: ["new-tool"] });
      expect(e2.version).toBe(2);
    });
  });

  // ── 工具级缓存权限 ─────────────────────────────────────────

  describe("isCachedToolAllowed - 缓存工具权限", () => {
    it("允许列表中的工具返回 true", async () => {
      await cachePolicy(samplePolicy);
      expect(isCachedToolAllowed("device.file.read")).toBe(true);
      expect(isCachedToolAllowed("device.browser.open")).toBe(true);
    });

    it("不在允许列表中的工具返回 false", async () => {
      await cachePolicy(samplePolicy);
      expect(isCachedToolAllowed("device.desktop.launch")).toBe(false);
    });

    it("无缓存时返回 false", () => {
      expect(isCachedToolAllowed("any-tool")).toBe(false);
    });

    it("allowedTools 包含通配符 * 时允许所有工具", async () => {
      await cachePolicy({ ...samplePolicy, allowedTools: ["*"] });
      expect(isCachedToolAllowed("any-tool-name")).toBe(true);
    });

    it("allowedTools 为 null 时返回 false", async () => {
      await cachePolicy({ ...samplePolicy, allowedTools: null });
      expect(isCachedToolAllowed("device.file.read")).toBe(false);
    });
  });

  // ── getCachedPolicyForExecution ─────────────────────────────

  describe("getCachedPolicyForExecution", () => {
    it("工具被允许时返回策略", async () => {
      await cachePolicy(samplePolicy);
      const policy = getCachedPolicyForExecution("device.file.read");
      expect(policy).not.toBeNull();
      expect(policy!.allowedTools).toEqual(samplePolicy.allowedTools);
    });

    it("工具不被允许时返回 null", async () => {
      await cachePolicy(samplePolicy);
      expect(getCachedPolicyForExecution("forbidden-tool")).toBeNull();
    });

    it("无缓存时返回 null", () => {
      expect(getCachedPolicyForExecution("any-tool")).toBeNull();
    });
  });

  // ── syncPolicyToCache ───────────────────────────────────────

  describe("syncPolicyToCache", () => {
    it("从任意策略对象同步到缓存", async () => {
      await syncPolicyToCache({
        allowedTools: ["sync-tool"],
        filePolicy: { allowRead: false },
        networkPolicy: null,
      });
      expect(hasCachedPolicy()).toBe(true);
      expect(isCachedToolAllowed("sync-tool")).toBe(true);
    });

    it("空策略对象也能同步", async () => {
      await syncPolicyToCache({});
      expect(hasCachedPolicy()).toBe(true);
    });
  });

  // ── buildOfflineClaim ───────────────────────────────────────

  describe("buildOfflineClaim - 离线执行 claim", () => {
    it("有缓存且工具被允许时构建 claim", async () => {
      await cachePolicy(samplePolicy);
      const claim = buildOfflineClaim({
        deviceExecutionId: "exec-1",
        toolRef: "device.file.read@1",
      });
      expect(claim).not.toBeNull();
      expect(claim!.execution.deviceExecutionId).toBe("exec-1");
      expect(claim!.execution.toolRef).toBe("device.file.read@1");
      expect(claim!.isOffline).toBe(true);
      expect(claim!.requireUserPresence).toBe(false); // 默认 low risk
    });

    it("高风险工具需要用户确认", async () => {
      await cachePolicy(samplePolicy);
      const claim = buildOfflineClaim({
        deviceExecutionId: "exec-2",
        toolRef: "device.file.read@1",
        getRiskLevel: () => "critical",
      });
      expect(claim).not.toBeNull();
      expect(claim!.requireUserPresence).toBe(true);
    });

    it("工具不被允许时返回 null", async () => {
      await cachePolicy(samplePolicy);
      const claim = buildOfflineClaim({
        deviceExecutionId: "exec-3",
        toolRef: "forbidden-tool@1",
      });
      expect(claim).toBeNull();
    });

    it("无缓存时返回 null", async () => {
      await clearPolicyCache();
      const claim = buildOfflineClaim({
        deviceExecutionId: "exec-4",
        toolRef: "device.file.read@1",
      });
      expect(claim).toBeNull();
    });

    it("toolRef 不含 @ 时正确解析工具名", async () => {
      await cachePolicy({ ...samplePolicy, allowedTools: ["my-tool"] });
      const claim = buildOfflineClaim({
        deviceExecutionId: "exec-5",
        toolRef: "my-tool",
      });
      expect(claim).not.toBeNull();
    });
  });

  // ── getPolicyCacheStatus ────────────────────────────────────

  describe("getPolicyCacheStatus", () => {
    it("有缓存时返回完整状态", async () => {
      await cachePolicy(samplePolicy);
      const status = getPolicyCacheStatus();
      expect(status.enabled).toBe(true);
      expect(status.cached).toBe(true);
      expect(status.version).toBe(1);
      expect(status.policyDigest).toBeTruthy();
      expect(status.allowedToolsCount).toBe(2);
    });

    it("无缓存时返回空状态", () => {
      const status = getPolicyCacheStatus();
      expect(status.enabled).toBe(true);
      expect(status.cached).toBe(false);
      expect(status.version).toBeNull();
      expect(status.allowedToolsCount).toBe(0);
    });
  });

  // ── 禁用缓存 ────────────────────────────────────────────────

  describe("缓存禁用场景", () => {
    it("enabled=false 时 cachePolicy 抛出异常", async () => {
      await clearPolicyCache();
      await initPolicyCache({
        deviceId: "dev-test-001",
        cacheDir: "/tmp/test-policy-cache",
        enabled: false,
      });
      await expect(cachePolicy(samplePolicy)).rejects.toThrow(
        "Policy cache not initialized or disabled"
      );
    });

    it("enabled=false 时 syncPolicyToCache 静默跳过", async () => {
      await clearPolicyCache();
      await initPolicyCache({
        deviceId: "dev-test-001",
        cacheDir: "/tmp/test-policy-cache",
        enabled: false,
      });
      // 不应抛异常
      await syncPolicyToCache({ allowedTools: ["t1"] });
      expect(hasCachedPolicy()).toBe(false);
    });
  });
});
