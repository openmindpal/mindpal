import { describe, expect, it } from "vitest";
import {
  SANDBOX_BLOCKED_MODULES,
  SANDBOX_BLOCKED_HIGH_RISK,
  SANDBOX_BLOCKED_MEDIUM_RISK,
  SANDBOX_BLOCKED_LOW_RISK,
  isModuleBlocked,
  assertModuleAllowed,
  getRiskLevel,
  resolveSandboxMode,
  pickExecute,
  checkModuleForbidden,
  buildForbiddenModulesSet,
  SKILL_RPC_VERSION,
  SKILL_RPC_JSONRPC,
  DEVICE_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  isVersionCompatible,
  negotiateVersion,
  SKILL_RPC_ERRORS,
  SKILL_RPC_METHODS,
  createRpcRequest,
  createRpcSuccess,
  createRpcError,
  parseRpcMessage,
  serializeRpcMessage,
  isRpcRequest,
  isRpcNotification,
  isRpcResponse,
  normalizeLimits,
} from "@mindpal/shared";

describe.sequential("e2e:skillSandbox", { timeout: 60_000 }, () => {

  /* ── Test 1: 模块黑名单内容校验 ── */

  it("模块黑名单生效 — SANDBOX_BLOCKED_MODULES 包含所有分级模块", () => {
    // 确保总黑名单非空
    expect(SANDBOX_BLOCKED_MODULES.length).toBeGreaterThan(0);

    // 确保所有高危模块都在黑名单中
    for (const m of SANDBOX_BLOCKED_HIGH_RISK) {
      expect(SANDBOX_BLOCKED_MODULES).toContain(m);
      expect(SANDBOX_BLOCKED_MODULES).toContain(`node:${m}`);
    }

    // 确保所有中危模块都在黑名单中
    for (const m of SANDBOX_BLOCKED_MEDIUM_RISK) {
      expect(SANDBOX_BLOCKED_MODULES).toContain(m);
      expect(SANDBOX_BLOCKED_MODULES).toContain(`node:${m}`);
    }

    // 确保所有低危模块都在黑名单中
    for (const m of SANDBOX_BLOCKED_LOW_RISK) {
      expect(SANDBOX_BLOCKED_MODULES).toContain(m);
      expect(SANDBOX_BLOCKED_MODULES).toContain(`node:${m}`);
    }

    // isModuleBlocked 函数验证
    expect(isModuleBlocked("child_process")).toBe(true);
    expect(isModuleBlocked("node:child_process")).toBe(true);
    expect(isModuleBlocked("crypto")).toBe(false);

    // assertModuleAllowed 对黑名单模块应抛出异常
    expect(() => assertModuleAllowed("child_process")).toThrow("policy_violation");
    expect(() => assertModuleAllowed("vm")).toThrow("policy_violation");
  });

  /* ── Test 2: 黑名单分级完整性 ── */

  it("黑名单分级 — HIGH_RISK/MEDIUM_RISK/LOW_RISK 分类完整", () => {
    // 高危：进程/系统级
    expect(SANDBOX_BLOCKED_HIGH_RISK).toContain("child_process");
    expect(SANDBOX_BLOCKED_HIGH_RISK).toContain("cluster");
    expect(SANDBOX_BLOCKED_HIGH_RISK).toContain("worker_threads");
    expect(SANDBOX_BLOCKED_HIGH_RISK).toContain("vm");
    expect(SANDBOX_BLOCKED_HIGH_RISK).toContain("v8");
    expect(SANDBOX_BLOCKED_HIGH_RISK).toContain("process");

    // 中危：网络
    expect(SANDBOX_BLOCKED_MEDIUM_RISK).toContain("dgram");
    expect(SANDBOX_BLOCKED_MEDIUM_RISK).toContain("net");
    expect(SANDBOX_BLOCKED_MEDIUM_RISK).toContain("tls");
    expect(SANDBOX_BLOCKED_MEDIUM_RISK).toContain("dns");
    expect(SANDBOX_BLOCKED_MEDIUM_RISK).toContain("http2");

    // 低危：信息泄露
    expect(SANDBOX_BLOCKED_LOW_RISK).toContain("os");
    expect(SANDBOX_BLOCKED_LOW_RISK).toContain("perf_hooks");
    expect(SANDBOX_BLOCKED_LOW_RISK).toContain("inspector");
    expect(SANDBOX_BLOCKED_LOW_RISK).toContain("repl");

    // getRiskLevel 函数验证
    expect(getRiskLevel("child_process")).toBe("high");
    expect(getRiskLevel("node:net")).toBe("medium");
    expect(getRiskLevel("os")).toBe("low");
    expect(getRiskLevel("crypto")).toBeUndefined();
  });

  /* ── Test 3: 协议版本检查 ── */

  it("协议版本检查 — SKILL_RPC_VERSION 和兼容性函数正确", () => {
    // 版本常量
    expect(SKILL_RPC_VERSION).toBe("1.0");
    expect(SKILL_RPC_JSONRPC).toBe("2.0");
    expect(DEVICE_PROTOCOL_VERSION).toBe("1.0");
    expect(MIN_SUPPORTED_PROTOCOL_VERSION).toBe("1.0");
    expect(PROTOCOL_VERSIONS).toContain("1.0");

    // 兼容性函数
    expect(isVersionCompatible("1.0", "1.0")).toBe(true);
    expect(isVersionCompatible("2.0", "1.0")).toBe(true);
    expect(isVersionCompatible("0.9", "1.0")).toBe(false);
    expect(isVersionCompatible("invalid", "1.0")).toBe(false);

    // 版本协商
    expect(negotiateVersion("1.0", PROTOCOL_VERSIONS)).toBe("1.0");
    expect(negotiateVersion("2.0", PROTOCOL_VERSIONS)).toBe("1.0");
    expect(negotiateVersion("0.1", PROTOCOL_VERSIONS)).toBeNull();

    // RPC 辅助函数
    const req = createRpcRequest("1", "skill.execute", { input: {} });
    expect(req.jsonrpc).toBe("2.0");
    expect(isRpcRequest(req)).toBe(true);

    const succ = createRpcSuccess("1", { output: "ok" });
    expect(isRpcResponse(succ)).toBe(true);

    const err = createRpcError("1", SKILL_RPC_ERRORS.EXECUTION_TIMEOUT, "timeout");
    expect(err.error.code).toBe(-32001);

    // 序列化/反序列化
    const serialized = serializeRpcMessage(req);
    expect(serialized.endsWith("\n")).toBe(true);
    const parsed = parseRpcMessage(serialized);
    expect(parsed).not.toBeNull();
    expect((parsed as any).method).toBe("skill.execute");

    // 方法名常量
    expect(SKILL_RPC_METHODS.INITIALIZE).toBe("skill.initialize");
    expect(SKILL_RPC_METHODS.EXECUTE).toBe("skill.execute");
    expect(SKILL_RPC_METHODS.HEARTBEAT).toBe("skill.heartbeat");
    expect(SKILL_RPC_METHODS.SHUTDOWN).toBe("skill.shutdown");
  });

  /* ── Test 4: RuntimeLimits 默认值 ── */

  it("RuntimeLimits 默认值 — 验证默认超时、内存等配置", () => {
    // normalizeLimits 传入空对象应返回合理默认值
    const defaults = normalizeLimits({});
    expect(defaults.timeoutMs).toBe(10_000);
    expect(defaults.maxConcurrency).toBe(10);
    expect(defaults.memoryMb).toBeNull();
    expect(defaults.cpuMs).toBeNull();
    expect(defaults.maxOutputBytes).toBeGreaterThan(0);
    expect(defaults.maxEgressRequests).toBeGreaterThan(0);

    // 自定义值应正确归一化
    const custom = normalizeLimits({
      timeoutMs: 30_000,
      maxConcurrency: 5,
      memoryMb: 512,
      cpuMs: 2000,
    });
    expect(custom.timeoutMs).toBe(30_000);
    expect(custom.maxConcurrency).toBe(5);
    expect(custom.memoryMb).toBe(512);
    expect(custom.cpuMs).toBe(2000);

    // 沙箱模式解析
    expect(resolveSandboxMode({ SKILL_SANDBOX_MODE: "strict" })).toBe("strict");
    expect(resolveSandboxMode({ SKILL_SANDBOX_MODE: "compat" })).toBe("compat");
    expect(resolveSandboxMode({ NODE_ENV: "production" })).toBe("strict");
    expect(resolveSandboxMode({ NODE_ENV: "development" })).toBe("compat");

    // pickExecute 函数
    expect(pickExecute({ execute: async () => "ok" })).not.toBeNull();
    expect(pickExecute({ default: { execute: async () => "ok" } })).not.toBeNull();
    expect(pickExecute({ default: async () => "ok" })).not.toBeNull();
    expect(pickExecute({})).toBeNull();
    expect(pickExecute(null)).toBeNull();

    // checkModuleForbidden 函数
    const forbidden = buildForbiddenModulesSet("strict");
    const result = checkModuleForbidden("child_process", forbidden);
    expect(result.forbidden).toBe(true);
    const safeResult = checkModuleForbidden("crypto", forbidden);
    expect(safeResult.forbidden).toBe(false);
  });
});
