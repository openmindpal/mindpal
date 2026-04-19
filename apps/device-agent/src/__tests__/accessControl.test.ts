import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  initAccessControl,
  getAccessPolicy,
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
  getAccessStats,
  extractCallerFromRequest,
} from "../accessControl";

describe("accessControl", () => {
  beforeEach(() => {
    // 每个测试前重置模块状态
    initAccessControl({ secretKey: "test-secret-key-2024", policy: {} });
    // 清理可能残留的上下文
    destroyContext("caller-a");
    destroyContext("caller-b");
    destroyContext("device:test");
  });

  // ── Token 生成与验证 ────────────────────────────────────────

  describe("Token 生成与验证", () => {
    it("生成的 Token 能被成功验证", () => {
      const token = generateCallerToken({
        callerId: "user-1",
        callerType: "api",
        tenantId: "t1",
        subjectId: "s1",
      });
      expect(token).toBeTruthy();
      expect(token.split(".")).toHaveLength(2);

      const identity = verifyCallerToken(token);
      expect(identity).not.toBeNull();
      expect(identity!.callerId).toBe("user-1");
      expect(identity!.callerType).toBe("api");
      expect(identity!.tenantId).toBe("t1");
      expect(identity!.subjectId).toBe("s1");
      expect(identity!.verifiedAt).toBeTruthy();
      expect(identity!.expiresAt).toBeTruthy();
    });

    it("secretKey 为空时生成 Token 应抛出异常", () => {
      initAccessControl({ secretKey: "", policy: {} });
      expect(() =>
        generateCallerToken({ callerId: "u1", callerType: "api" })
      ).toThrow("device_agent_secret_key_required");
    });

    it("secretKey 为空时验证 Token 返回 null", () => {
      const token = generateCallerToken({ callerId: "u1", callerType: "api" });
      initAccessControl({ secretKey: "", policy: {} });
      expect(verifyCallerToken(token)).toBeNull();
    });

    it("空 Token 返回 null", () => {
      expect(verifyCallerToken("")).toBeNull();
    });

    it("格式错误的 Token 返回 null", () => {
      expect(verifyCallerToken("only-one-part")).toBeNull();
      expect(verifyCallerToken("a.b.c")).toBeNull();
    });

    it("签名被篡改的 Token 返回 null", () => {
      const token = generateCallerToken({ callerId: "u1", callerType: "api" });
      const [payload] = token.split(".");
      const tampered = `${payload}.tampered-signature`;
      expect(verifyCallerToken(tampered)).toBeNull();
    });

    it("过期 Token 返回 null", () => {
      const token = generateCallerToken({
        callerId: "u1",
        callerType: "api",
        expiresInMs: 1, // 1ms 后过期
      });
      // 等待过期
      vi.useFakeTimers();
      vi.advanceTimersByTime(100);
      const result = verifyCallerToken(token);
      vi.useRealTimers();
      expect(result).toBeNull();
    });

    it("callerType 无效时回退为 api", () => {
      // 手动构造一个带无效 callerType 的 payload
      const token = generateCallerToken({ callerId: "u1", callerType: "local" });
      const identity = verifyCallerToken(token);
      expect(identity).not.toBeNull();
      expect(identity!.callerType).toBe("local");
    });

    it("支持 plugin 类型的 callerType", () => {
      const token = generateCallerToken({ callerId: "plugin-1", callerType: "plugin" });
      const identity = verifyCallerToken(token);
      expect(identity!.callerType).toBe("plugin");
    });
  });

  // ── 调用方权限检查 ──────────────────────────────────────────

  describe("isCallerAllowed - 调用方权限", () => {
    it("空策略（无 allowedCallers）允许所有调用方", () => {
      initAccessControl({ secretKey: "k", policy: {} });
      expect(isCallerAllowed("anyone")).toBe(true);
    });

    it("allowedCallers 为空数组时允许所有调用方", () => {
      initAccessControl({ secretKey: "k", policy: { allowedCallers: [] } });
      expect(isCallerAllowed("anyone")).toBe(true);
    });

    it("调用方在 allowedCallers 列表中则允许", () => {
      initAccessControl({
        secretKey: "k",
        policy: { allowedCallers: ["caller-a", "caller-b"] },
      });
      expect(isCallerAllowed("caller-a")).toBe(true);
      expect(isCallerAllowed("caller-b")).toBe(true);
    });

    it("调用方不在 allowedCallers 列表中则拒绝", () => {
      initAccessControl({
        secretKey: "k",
        policy: { allowedCallers: ["caller-a"] },
      });
      expect(isCallerAllowed("caller-b")).toBe(false);
      expect(isCallerAllowed("unknown")).toBe(false);
    });
  });

  // ── 工具级权限检查 ──────────────────────────────────────────

  describe("isToolAllowed - 工具权限", () => {
    it("空策略（无 allowedTools）允许所有工具", () => {
      initAccessControl({ secretKey: "k", policy: {} });
      expect(isToolAllowed("caller-a", "any-tool")).toBe(true);
    });

    it("工具在全局 allowedTools 列表中则允许", () => {
      initAccessControl({
        secretKey: "k",
        policy: { allowedTools: ["tool-a", "tool-b"] },
      });
      expect(isToolAllowed("caller-a", "tool-a")).toBe(true);
    });

    it("工具不在全局 allowedTools 列表中则拒绝", () => {
      initAccessControl({
        secretKey: "k",
        policy: { allowedTools: ["tool-a"] },
      });
      expect(isToolAllowed("caller-a", "tool-b")).toBe(false);
    });

    it("上下文级工具权限：有 toolPermissions 时仅允许列出的工具", () => {
      initAccessControl({ secretKey: "k", policy: {} });
      getOrCreateContext("caller-a", ["tool-x", "tool-y"]);
      expect(isToolAllowed("caller-a", "tool-x")).toBe(true);
      expect(isToolAllowed("caller-a", "tool-y")).toBe(true);
      expect(isToolAllowed("caller-a", "tool-z")).toBe(false);
    });

    it("全局策略拒绝优先于上下文级允许", () => {
      initAccessControl({
        secretKey: "k",
        policy: { allowedTools: ["tool-a"] },
      });
      getOrCreateContext("caller-a", ["tool-b"]); // 上下文允许 tool-b
      // 但全局不允许 tool-b
      expect(isToolAllowed("caller-a", "tool-b")).toBe(false);
    });

    it("无上下文且无全局策略时默认允许", () => {
      initAccessControl({ secretKey: "k", policy: {} });
      expect(isToolAllowed("nonexistent-caller", "any-tool")).toBe(true);
    });
  });

  // ── 执行上下文管理 ──────────────────────────────────────────

  describe("执行上下文管理", () => {
    it("getOrCreateContext 创建新上下文", () => {
      const ctx = getOrCreateContext("caller-a");
      expect(ctx).toBeTruthy();
      expect(ctx.callerId).toBe("caller-a");
      expect(ctx.contextId).toHaveLength(32); // 16 bytes hex
      expect(ctx.state).toBeInstanceOf(Map);
      expect(ctx.toolPermissions).toBeInstanceOf(Set);
    });

    it("getOrCreateContext 复用已存在的上下文", () => {
      const ctx1 = getOrCreateContext("caller-a");
      const ctx2 = getOrCreateContext("caller-a");
      expect(ctx2.contextId).toBe(ctx1.contextId);
    });

    it("getOrCreateContext 更新已有上下文的 toolPermissions", () => {
      getOrCreateContext("caller-a", ["tool-a"]);
      const ctx = getOrCreateContext("caller-a", ["tool-b", "tool-c"]);
      expect(ctx.toolPermissions.has("tool-b")).toBe(true);
      expect(ctx.toolPermissions.has("tool-c")).toBe(true);
      expect(ctx.toolPermissions.has("tool-a")).toBe(false);
    });

    it("getContext 获取已存在的上下文", () => {
      getOrCreateContext("caller-a");
      const ctx = getContext("caller-a");
      expect(ctx).not.toBeNull();
      expect(ctx!.callerId).toBe("caller-a");
    });

    it("getContext 不存在时返回 null", () => {
      expect(getContext("nonexistent")).toBeNull();
    });

    it("destroyContext 销毁上下文", () => {
      getOrCreateContext("caller-a");
      expect(destroyContext("caller-a")).toBe(true);
      expect(getContext("caller-a")).toBeNull();
    });

    it("destroyContext 不存在的上下文返回 false", () => {
      expect(destroyContext("nonexistent")).toBe(false);
    });
  });

  // ── 上下文状态管理 ──────────────────────────────────────────

  describe("上下文状态 (state) 管理", () => {
    it("set/get/delete 状态正常工作", () => {
      getOrCreateContext("caller-a");
      expect(setContextState("caller-a", "key1", "value1")).toBe(true);
      expect(getContextState("caller-a", "key1")).toBe("value1");
      expect(deleteContextState("caller-a", "key1")).toBe(true);
      expect(getContextState("caller-a", "key1")).toBeUndefined();
    });

    it("上下文不存在时 setContextState 返回 false", () => {
      expect(setContextState("nonexistent", "key", "val")).toBe(false);
    });

    it("上下文不存在时 getContextState 返回 undefined", () => {
      expect(getContextState("nonexistent", "key")).toBeUndefined();
    });

    it("上下文不存在时 deleteContextState 返回 false", () => {
      expect(deleteContextState("nonexistent", "key")).toBe(false);
    });
  });

  // ── 过期清理 ────────────────────────────────────────────────

  describe("cleanupExpiredContexts - 过期上下文清理", () => {
    it("清理过期的上下文", () => {
      initAccessControl({ secretKey: "k", policy: { maxContextAge: 1000 } });
      getOrCreateContext("caller-a");

      // 模拟时间流逝
      vi.useFakeTimers();
      vi.advanceTimersByTime(2000);

      const cleaned = cleanupExpiredContexts();
      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(getContext("caller-a")).toBeNull();

      vi.useRealTimers();
    });

    it("未过期的上下文不会被清理", () => {
      initAccessControl({ secretKey: "k", policy: { maxContextAge: 60000 } });
      getOrCreateContext("caller-a");
      const cleaned = cleanupExpiredContexts();
      expect(cleaned).toBe(0);
      expect(getContext("caller-a")).not.toBeNull();
    });
  });

  // ── extractCallerFromRequest ────────────────────────────────

  describe("extractCallerFromRequest - 请求中提取调用方", () => {
    it("从 Bearer Token 提取身份", () => {
      const token = generateCallerToken({ callerId: "user-1", callerType: "api" });
      const identity = extractCallerFromRequest({
        authHeader: `Bearer ${token}`,
      });
      expect(identity).not.toBeNull();
      expect(identity!.callerId).toBe("user-1");
    });

    it("无效 Bearer Token 回退到 deviceToken", () => {
      const identity = extractCallerFromRequest({
        authHeader: "Bearer invalid-token",
        deviceToken: "dev-tok-123",
      });
      expect(identity).not.toBeNull();
      expect(identity!.callerId).toMatch(/^device:/);
      expect(identity!.callerType).toBe("api");
    });

    it("仅提供 deviceToken 时生成 device: 前缀的 callerId", () => {
      const identity = extractCallerFromRequest({
        deviceToken: "my-device-token",
      });
      expect(identity).not.toBeNull();
      expect(identity!.callerId).toMatch(/^device:[a-f0-9]{16}$/);
    });

    it("无任何凭证时返回 null", () => {
      const identity = extractCallerFromRequest({});
      expect(identity).toBeNull();
    });
  });

  // ── getAccessPolicy ─────────────────────────────────────────

  describe("getAccessPolicy - 策略获取", () => {
    it("返回当前策略的副本（浅拷贝）", () => {
      const policy = { allowedCallers: ["a"], allowedTools: ["t"], requireSignature: true, maxContextAge: 5000 };
      initAccessControl({ secretKey: "k", policy });
      const retrieved = getAccessPolicy();
      expect(retrieved).toEqual(policy);
      // 浅拷贝：顶层属性独立，但嵌套数组引用共享
      expect(retrieved).not.toBe(policy);
    });

    it("默认策略为空对象", () => {
      initAccessControl({ secretKey: "k" });
      expect(getAccessPolicy()).toEqual({});
    });
  });

  // ── getAccessStats ──────────────────────────────────────────

  describe("getAccessStats - 统计信息", () => {
    it("返回活跃上下文数量", () => {
      const stats1 = getAccessStats();
      const initialContexts = stats1.activeContexts;

      getOrCreateContext("caller-a");
      getOrCreateContext("caller-b");
      const stats2 = getAccessStats();
      expect(stats2.activeContexts).toBe(initialContexts + 2);
    });
  });
});
