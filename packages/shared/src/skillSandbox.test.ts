/**
 * P1-3: Skill 沙箱模块封禁列表完整性测试
 * 
 * 验证点：
 * 1. 基线封禁模块覆盖所有高危 Node.js 内置模块
 * 2. 严格模式额外封禁文件系统、Worker、VM 等
 * 3. 数据库模块封禁防止直连数据库
 * 4. 模块拦截器正确阻止被封禁模块的加载
 * 5. 动态代码执行锁定有效
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  SANDBOX_FORBIDDEN_MODULES_BASE,
  SANDBOX_FORBIDDEN_MODULES_STRICT,
  SANDBOX_FORBIDDEN_MODULES_DATABASE,
  resolveSandboxMode,
  buildForbiddenModulesSet,
  checkModuleForbidden,
  createModuleLoadInterceptor,
  lockdownDynamicCodeExecution,
  restoreDynamicCodeExecution,
} from "@mindpal/shared";

describe("P1-3: Skill Sandbox Module Blocking", () => {
  
  describe("Baseline Forbidden Modules", () => {
    it("应该封禁所有网络相关模块", () => {
      const networkModules = [
        "node:http", "http",
        "node:https", "https",
        "node:net", "net",
        "node:tls", "tls",
        "node:dns", "dns",
        "node:dgram", "dgram",
      ];

      for (const mod of networkModules) {
        expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain(mod);
      }
    });

    it("应该封禁子进程模块", () => {
      expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain("node:child_process");
      expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain("child_process");
    });

    it("基线封禁列表应该是不可变的", () => {
      expect(Object.isFrozen(SANDBOX_FORBIDDEN_MODULES_BASE)).toBe(true);
    });
  });

  describe("Strict Mode Forbidden Modules", () => {
    it("应该封禁文件系统模块", () => {
      const fsModules = [
        "node:fs", "fs",
        "node:fs/promises", "fs/promises",
      ];

      for (const mod of fsModules) {
        expect(SANDBOX_FORBIDDEN_MODULES_STRICT).toContain(mod);
      }
    });

    it("应该封禁 Worker 线程模块", () => {
      expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain("node:worker_threads");
      expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain("worker_threads");
    });

    it("应该封禁 VM 模块", () => {
      expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain("node:vm");
      expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain("vm");
    });

    it("应该封禁调试和异步钩子模块", () => {
      expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain("node:inspector");
      expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain("inspector");
      expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain("node:async_hooks");
      expect(SANDBOX_FORBIDDEN_MODULES_BASE).toContain("async_hooks");
    });

    it("严格模式封禁列表应该是不可变的", () => {
      expect(Object.isFrozen(SANDBOX_FORBIDDEN_MODULES_STRICT)).toBe(true);
    });
  });

  describe("Database Modules Forbidden", () => {
    it("应该封禁常见数据库驱动", () => {
      const dbModules = [
        "pg", "mysql", "mysql2",
        "sqlite3", "better-sqlite3",
        "mongodb", "oracledb", "mssql",
        "redis", "ioredis",
      ];

      for (const mod of dbModules) {
        expect(SANDBOX_FORBIDDEN_MODULES_DATABASE).toContain(mod);
      }
    });

    it("数据库模块封禁列表应该是不可变的", () => {
      expect(Object.isFrozen(SANDBOX_FORBIDDEN_MODULES_DATABASE)).toBe(true);
    });
  });

  describe("Sandbox Mode Resolution", () => {
    it("应该从环境变量解析 strict 模式", () => {
      const mode = resolveSandboxMode({ SKILL_SANDBOX_MODE: "strict" });
      expect(mode).toBe("strict");
    });

    it("应该从环境变量解析 compat 模式", () => {
      const mode = resolveSandboxMode({ SKILL_SANDBOX_MODE: "compat" });
      expect(mode).toBe("compat");
    });

    it("生产环境默认应该是 strict", () => {
      const mode = resolveSandboxMode({ NODE_ENV: "production" });
      expect(mode).toBe("strict");
    });

    it("开发环境默认应该是 compat", () => {
      const mode = resolveSandboxMode({ NODE_ENV: "development" });
      expect(mode).toBe("compat");
    });

    it("未知值应该回退到默认策略", () => {
      const mode = resolveSandboxMode({ SKILL_SANDBOX_MODE: "unknown" });
      expect(["strict", "compat"]).toContain(mode);
    });
  });

  describe("Forbidden Modules Set Building", () => {
    it("兼容模式应该只包含基线封禁模块", () => {
      const set = buildForbiddenModulesSet("compat");
      
      expect(set.has("child_process")).toBe(true);
      expect(set.has("http")).toBe(true);
      expect(set.has("fs")).toBe(false); // compat 模式不封禁 fs
    });

    it("严格模式应该包含基线 + 严格封禁模块", () => {
      const set = buildForbiddenModulesSet("strict");
      
      expect(set.has("child_process")).toBe(true);
      expect(set.has("http")).toBe(true);
      expect(set.has("fs")).toBe(true); // strict 模式封禁 fs
      expect(set.has("vm")).toBe(true);
    });

    it("应该支持额外封禁模块", () => {
      const extras = ["custom-module", "another-module"];
      const set = buildForbiddenModulesSet("compat", extras);
      
      expect(set.has("custom-module")).toBe(true);
      expect(set.has("another-module")).toBe(true);
    });

    it("数据库模块应该可以作为额外封禁模块添加", () => {
      const set = buildForbiddenModulesSet("compat", SANDBOX_FORBIDDEN_MODULES_DATABASE);
      
      expect(set.has("pg")).toBe(true);
      expect(set.has("mongodb")).toBe(true);
    });
  });

  describe("Module Forbidden Check", () => {
    const forbiddenSet = buildForbiddenModulesSet("strict", SANDBOX_FORBIDDEN_MODULES_DATABASE);

    it("应该检测到被封禁的模块（带 node: 前缀）", () => {
      const result = checkModuleForbidden("node:child_process", forbiddenSet);
      expect(result.forbidden).toBe(true);
      if (result.forbidden) {
        expect(result.baseName).toBe("child_process");
      }
    });

    it("应该检测到被封禁的模块（不带 node: 前缀）", () => {
      const result = checkModuleForbidden("fs", forbiddenSet);
      expect(result.forbidden).toBe(true);
      if (result.forbidden) {
        expect(result.baseName).toBe("fs");
      }
    });

    it("应该允许未被封禁的模块", () => {
      const result = checkModuleForbidden("lodash", forbiddenSet);
      expect(result.forbidden).toBe(false);
    });

    it("应该允许安全的 Node.js 内置模块", () => {
      const result = checkModuleForbidden("node:path", forbiddenSet);
      expect(result.forbidden).toBe(false);
    });

    it("应该允许 crypto 模块", () => {
      const result = checkModuleForbidden("node:crypto", forbiddenSet);
      expect(result.forbidden).toBe(false);
    });

    it("应该允许 util 模块", () => {
      const result = checkModuleForbidden("node:util", forbiddenSet);
      expect(result.forbidden).toBe(false);
    });
  });

  describe("Module Load Interceptor", () => {
    it("应该阻止被封禁模块的加载", () => {
      const origLoad = vi.fn();
      const forbiddenSet = new Set(["child_process"]);
      const interceptor = createModuleLoadInterceptor(origLoad, forbiddenSet);

      expect(() => {
        interceptor("child_process", null, false);
      }).toThrow("policy_violation:skill_forbidden_import:child_process");

      expect(origLoad).not.toHaveBeenCalled();
    });

    it("应该允许未被封禁模块的加载", () => {
      const origLoad = vi.fn().mockReturnValue({});
      const forbiddenSet = new Set(["child_process"]);
      const interceptor = createModuleLoadInterceptor(origLoad, forbiddenSet);

      const result = interceptor("lodash", null, false);
      
      expect(result).toEqual({});
      expect(origLoad).toHaveBeenCalledWith("lodash", null, false);
    });

    it("应该正确处理 node: 前缀", () => {
      const origLoad = vi.fn();
      const forbiddenSet = new Set(["node:fs", "fs"]);
      const interceptor = createModuleLoadInterceptor(origLoad, forbiddenSet);

      expect(() => {
        interceptor("node:fs", null, false);
      }).toThrow("policy_violation:skill_forbidden_import:fs");
    });
  });

  describe("Dynamic Code Execution Lockdown", () => {
    let savedState: any;

    beforeEach(() => {
      savedState = lockdownDynamicCodeExecution();
    });

    afterEach(() => {
      restoreDynamicCodeExecution(savedState);
    });

    it("应该封禁 eval", () => {
      expect(() => {
        eval("1 + 1");
      }).toThrow("policy_violation:skill_dynamic_code_execution_blocked");
    });

    it("应该封禁 Function 构造函数", () => {
      expect(() => {
        new Function("return 1 + 1")();
      }).toThrow("policy_violation:skill_dynamic_code_execution_blocked");
    });

    it("应该封禁 Function.call", () => {
      expect(() => {
        Function.call(null, "return 1 + 1")();
      }).toThrow("policy_violation:skill_dynamic_code_execution_blocked");
    });

    it("恢复后应该能够正常使用 eval", () => {
      restoreDynamicCodeExecution(savedState);
      
      // eslint-disable-next-line no-eval
      const result = eval("2 + 2");
      expect(result).toBe(4);
    });

    it("恢复后应该能够正常使用 Function", () => {
      restoreDynamicCodeExecution(savedState);
      
      const fn = new Function("a", "b", "return a + b");
      expect(fn(2, 3)).toBe(5);
    });
  });

  describe("Security Coverage", () => {
    it("应该封禁所有可能导致远程代码执行的模块", () => {
      const rceModules = [
        "child_process", // 执行系统命令
        "vm",            // 执行任意代码
        "inspector",     // 调试接口
      ];

      const strictSet = buildForbiddenModulesSet("strict");
      
      for (const mod of rceModules) {
        expect(strictSet.has(mod)).toBe(true);
      }
    });

    it("应该封禁所有可能导致数据泄露的模块", () => {
      const leakModules = [
        "fs",           // 读取文件系统
        "net",          // 网络连接
        "http",         // HTTP 请求
        "https",        // HTTPS 请求
      ];

      const strictSet = buildForbiddenModulesSet("strict");
      
      for (const mod of leakModules) {
        expect(strictSet.has(mod)).toBe(true);
      }
    });

    it("应该封禁所有可能绕过沙箱的模块", () => {
      const bypassModules = [
        "worker_threads", // 创建新线程
        "async_hooks",    // 拦截异步操作
      ];

      const strictSet = buildForbiddenModulesSet("strict");
      
      for (const mod of bypassModules) {
        expect(strictSet.has(mod)).toBe(true);
      }
    });
  });

  describe("Edge Cases", () => {
    it("空模块名不应该崩溃", () => {
      const forbiddenSet = buildForbiddenModulesSet("strict");
      const result = checkModuleForbidden("", forbiddenSet);
      expect(result.forbidden).toBe(false);
    });

    it("undefined 模块名不应该崩溃", () => {
      const forbiddenSet = buildForbiddenModulesSet("strict");
      const result = checkModuleForbidden(undefined as any, forbiddenSet);
      expect(result.forbidden).toBe(false);
    });

    it("null 模块名不应该崩溃", () => {
      const forbiddenSet = buildForbiddenModulesSet("strict");
      const result = checkModuleForbidden(null as any, forbiddenSet);
      expect(result.forbidden).toBe(false);
    });

    it("大小写应该敏感", () => {
      const forbiddenSet = buildForbiddenModulesSet("strict");
      
      // "FS" 不等于 "fs"
      const result = checkModuleForbidden("FS", forbiddenSet);
      expect(result.forbidden).toBe(false);
    });
  });

  describe("Performance", () => {
    it("模块检查应该在微秒级完成", () => {
      const forbiddenSet = buildForbiddenModulesSet("strict", SANDBOX_FORBIDDEN_MODULES_DATABASE);
      const iterations = 10000;
      
      const start = Date.now();
      for (let i = 0; i < iterations; i++) {
        checkModuleForbidden("lodash", forbiddenSet);
      }
      const duration = Date.now() - start;
      const avgTime = duration / iterations;

      expect(avgTime).toBeLessThan(0.1); // 平均每次 < 0.1ms
      console.log(`Module check: ${avgTime.toFixed(4)}ms per operation (${iterations} iterations)`);
    });

    it("构建封禁集合应该在毫秒级完成", () => {
      const iterations = 1000;
      
      const start = Date.now();
      for (let i = 0; i < iterations; i++) {
        buildForbiddenModulesSet("strict", SANDBOX_FORBIDDEN_MODULES_DATABASE);
      }
      const duration = Date.now() - start;
      const avgTime = duration / iterations;

      expect(avgTime).toBeLessThan(1); // 平均每次 < 1ms
      console.log(`Build forbidden set: ${avgTime.toFixed(3)}ms per operation (${iterations} iterations)`);
    });
  });
});
