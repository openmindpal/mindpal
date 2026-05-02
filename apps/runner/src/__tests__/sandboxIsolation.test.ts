/**
 * sandboxIsolation.test.ts — 沙箱安全隔离机制单元测试
 *
 * 功能目标：验证 packages/shared/src/skillSandbox.ts 导出的沙箱安全函数，
 * 包括模块黑名单、动态代码锁定、模块加载拦截和风险等级查询。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  SANDBOX_BLOCKED_MODULES,
  SANDBOX_BLOCKED_HIGH_RISK,
  SANDBOX_BLOCKED_MEDIUM_RISK,
  SANDBOX_BLOCKED_LOW_RISK,
  buildForbiddenModulesSet,
  lockdownDynamicCodeExecution,
  restoreDynamicCodeExecution,
  createModuleLoadInterceptor,
  checkModuleForbidden,
  isModuleBlocked,
  assertModuleAllowed,
  getRiskLevel,
  resolveSandboxMode,
  pickExecute,
  type DynamicCodeLockState,
} from "@mindpal/shared";

/* ── 模块黑名单 ─────────────────────────────────────────────── */
describe("SANDBOX_BLOCKED_MODULES", () => {
  it("应包含预期的高危模块（child_process、vm、cluster 等）", () => {
    for (const mod of ["child_process", "vm", "cluster", "worker_threads", "v8", "process"]) {
      expect(SANDBOX_BLOCKED_MODULES).toContain(mod);
      expect(SANDBOX_BLOCKED_MODULES).toContain(`node:${mod}`);
    }
  });

  it("应包含中危网络模块（dgram、net、tls、dns、http2）", () => {
    for (const mod of ["dgram", "net", "tls", "dns", "http2"]) {
      expect(SANDBOX_BLOCKED_MODULES).toContain(mod);
      expect(SANDBOX_BLOCKED_MODULES).toContain(`node:${mod}`);
    }
  });

  it("应包含低危模块（os、perf_hooks、inspector 等）", () => {
    for (const mod of ["os", "perf_hooks", "inspector", "repl", "async_hooks"]) {
      expect(SANDBOX_BLOCKED_MODULES).toContain(mod);
    }
  });

  it("每个裸名都应有对应的 node: 前缀变体", () => {
    const bare = SANDBOX_BLOCKED_MODULES.filter((m) => !m.startsWith("node:"));
    for (const b of bare) {
      expect(SANDBOX_BLOCKED_MODULES).toContain(`node:${b}`);
    }
  });
});

/* ── 风险等级查询 ───────────────────────────────────────────── */
describe("getRiskLevel", () => {
  it("高危模块返回 high", () => {
    for (const m of SANDBOX_BLOCKED_HIGH_RISK) {
      expect(getRiskLevel(m)).toBe("high");
      expect(getRiskLevel(`node:${m}`)).toBe("high");
    }
  });

  it("中危模块返回 medium", () => {
    for (const m of SANDBOX_BLOCKED_MEDIUM_RISK) {
      expect(getRiskLevel(m)).toBe("medium");
    }
  });

  it("低危模块返回 low", () => {
    for (const m of SANDBOX_BLOCKED_LOW_RISK) {
      expect(getRiskLevel(m)).toBe("low");
    }
  });

  it("非黑名单模块返回 undefined", () => {
    expect(getRiskLevel("path")).toBeUndefined();
    expect(getRiskLevel("crypto")).toBeUndefined();
  });
});

/* ── isModuleBlocked / assertModuleAllowed ──────────────────── */
describe("isModuleBlocked", () => {
  it("黑名单模块返回 true（裸名和 node: 前缀均可）", () => {
    expect(isModuleBlocked("child_process")).toBe(true);
    expect(isModuleBlocked("node:child_process")).toBe(true);
    expect(isModuleBlocked("vm")).toBe(true);
  });

  it("非黑名单模块返回 false", () => {
    expect(isModuleBlocked("path")).toBe(false);
    expect(isModuleBlocked("crypto")).toBe(false);
  });
});

describe("assertModuleAllowed", () => {
  it("黑名单模块应抛出 policy_violation 异常", () => {
    expect(() => assertModuleAllowed("child_process")).toThrow(
      "policy_violation:skill_forbidden_import:child_process",
    );
  });

  it("非黑名单模块不应抛出", () => {
    expect(() => assertModuleAllowed("path")).not.toThrow();
    expect(() => assertModuleAllowed("node:path")).not.toThrow();
  });
});

/* ── buildForbiddenModulesSet ──────────────────────────────── */
describe("buildForbiddenModulesSet", () => {
  it("compat 模式包含 BASE 列表", () => {
    const set = buildForbiddenModulesSet("compat");
    expect(set.has("child_process")).toBe(true);
    expect(set.has("node:child_process")).toBe(true);
    expect(set.has("net")).toBe(true);
  });

  it("strict 模式额外包含 fs 模块", () => {
    const set = buildForbiddenModulesSet("strict");
    expect(set.has("fs")).toBe(true);
    expect(set.has("node:fs")).toBe(true);
    expect(set.has("fs/promises")).toBe(true);
  });

  it("extras 参数可扩展封禁列表", () => {
    const set = buildForbiddenModulesSet("compat", ["pg", "redis"]);
    expect(set.has("pg")).toBe(true);
    expect(set.has("redis")).toBe(true);
  });
});

/* ── lockdownDynamicCodeExecution ─────────────────────────── */
describe("lockdownDynamicCodeExecution", () => {
  let saved: DynamicCodeLockState | null = null;

  afterEach(() => {
    if (saved) {
      restoreDynamicCodeExecution(saved);
      saved = null;
    }
  });

  it("锁定后 eval 应抛出 policy_violation", () => {
    saved = lockdownDynamicCodeExecution();
    expect(() => (globalThis as any).eval("1+1")).toThrow(
      "policy_violation:skill_dynamic_code_execution_blocked",
    );
  });

  it("锁定后 new Function 应抛出 policy_violation", () => {
    saved = lockdownDynamicCodeExecution();
    expect(() => new (globalThis as any).Function("return 1")).toThrow(
      "policy_violation:skill_dynamic_code_execution_blocked",
    );
  });

  it("restoreDynamicCodeExecution 后 eval 恢复正常", () => {
    saved = lockdownDynamicCodeExecution();
    restoreDynamicCodeExecution(saved);
    // 恢复后应能正常 eval
    expect(globalThis.eval("1+1")).toBe(2);
    saved = null; // 已恢复，不需要 afterEach 再恢复
  });
});

/* ── createModuleLoadInterceptor ─────────────────────────── */
describe("createModuleLoadInterceptor", () => {
  it("拦截黑名单模块并抛出 policy_violation", () => {
    const forbidden = new Set(["child_process", "node:child_process"]);
    const origLoad = () => ({});
    const intercepted = createModuleLoadInterceptor(origLoad, forbidden);

    expect(() => intercepted("child_process", null, false)).toThrow(
      "policy_violation:skill_forbidden_import:child_process",
    );
  });

  it("允许非黑名单模块透传到原始 _load", () => {
    const forbidden = new Set(["child_process", "node:child_process"]);
    const origLoad = (_req: string) => ({ loaded: true });
    const intercepted = createModuleLoadInterceptor(origLoad as any, forbidden);

    const result = intercepted("path", null, false);
    expect(result).toEqual({ loaded: true });
  });

  it("node: 前缀变体同样被拦截", () => {
    const forbidden = new Set(["vm", "node:vm"]);
    const origLoad = () => ({});
    const intercepted = createModuleLoadInterceptor(origLoad, forbidden);

    expect(() => intercepted("node:vm", null, false)).toThrow(
      "policy_violation:skill_forbidden_import:vm",
    );
  });
});

/* ── checkModuleForbidden ────────────────────────────────── */
describe("checkModuleForbidden", () => {
  it("封禁模块返回 forbidden: true 和 baseName", () => {
    const set = new Set(["net", "node:net"]);
    const result = checkModuleForbidden("node:net", set);
    expect(result).toEqual({ forbidden: true, baseName: "net" });
  });

  it("允许模块返回 forbidden: false", () => {
    const set = new Set(["net", "node:net"]);
    const result = checkModuleForbidden("path", set);
    expect(result).toEqual({ forbidden: false });
  });

  it("空字符串返回 forbidden: false", () => {
    const set = new Set(["net"]);
    expect(checkModuleForbidden("", set)).toEqual({ forbidden: false });
  });
});

/* ── resolveSandboxMode ──────────────────────────────────── */
describe("resolveSandboxMode", () => {
  it("明确设置 strict 返回 strict", () => {
    expect(resolveSandboxMode({ SKILL_SANDBOX_MODE: "strict" })).toBe("strict");
  });

  it("明确设置 compat 返回 compat", () => {
    expect(resolveSandboxMode({ SKILL_SANDBOX_MODE: "compat" })).toBe("compat");
  });

  it("生产环境默认 strict", () => {
    expect(resolveSandboxMode({ NODE_ENV: "production" })).toBe("strict");
  });

  it("开发环境默认 compat", () => {
    expect(resolveSandboxMode({ NODE_ENV: "development" })).toBe("compat");
  });
});

/* ── pickExecute ─────────────────────────────────────────── */
describe("pickExecute", () => {
  it("直接导出 execute 函数", () => {
    const fn = async () => ({});
    const mod = { execute: fn };
    expect(pickExecute(mod)).toBe(fn);
  });

  it("default 导出包含 execute", () => {
    const fn = async () => ({});
    expect(pickExecute({ default: { execute: fn } })).toBe(fn);
  });

  it("default 直接是函数", () => {
    const fn = async () => ({});
    expect(pickExecute({ default: fn })).toBe(fn);
  });

  it("无 execute 返回 null", () => {
    expect(pickExecute({})).toBeNull();
    expect(pickExecute(null)).toBeNull();
  });
});
