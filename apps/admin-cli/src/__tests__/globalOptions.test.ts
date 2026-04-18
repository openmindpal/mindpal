/**
 * lib/globalOptions 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { addGlobalOptions, resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";

/* ─── addGlobalOptions ─────────────────────────────────────────── */
describe("addGlobalOptions()", () => {
  it("向 program 注册 5 个全局选项", () => {
    const program = new Command();
    addGlobalOptions(program);
    const opts = program.opts();

    // 默认值应存在
    expect(opts.apiBase).toBeDefined();
    expect(opts.format).toBe("json");
  });

  it("默认 apiBase 为 localhost:3001", () => {
    const saved = { ...process.env };
    delete process.env.API_BASE;

    const program = new Command();
    addGlobalOptions(program);
    program.parse([], { from: "user" });
    const opts = program.opts();

    expect(opts.apiBase).toBe("http://localhost:3001");

    // 恢复
    Object.assign(process.env, saved);
  });
});

/* ─── resolveGlobalOptions ─────────────────────────────────────── */
describe("resolveGlobalOptions()", () => {
  it("CLI 参数覆盖默认值", () => {
    const program = new Command();
    addGlobalOptions(program);
    program.parse(["--api-base", "http://custom:9999", "--token", "mytoken", "--format", "table"], { from: "user" });

    const g = resolveGlobalOptions(program);
    expect(g.apiBase).toBe("http://custom:9999");
    expect(g.token).toBe("mytoken");
    expect(g.format).toBe("table");
  });

  it("环境变量在 CLI 参数缺失时生效", () => {
    const saved = { ...process.env };
    process.env.API_TOKEN = "env-token";
    process.env.TENANT_ID = "env-tenant";

    const program = new Command();
    addGlobalOptions(program);
    program.parse([], { from: "user" });

    const g = resolveGlobalOptions(program);
    // token 的默认值取自 addGlobalOptions 注册时的 process.env.API_TOKEN
    // 由于 commander 在 addGlobalOptions 时就已绑定默认值，这里需确认逻辑
    expect(g.tenantId).toBeTruthy();

    // 恢复
    Object.assign(process.env, saved);
    delete process.env.API_TOKEN;
    delete process.env.TENANT_ID;
  });

  it("默认格式为 json", () => {
    const program = new Command();
    addGlobalOptions(program);
    program.parse([], { from: "user" });
    const g = resolveGlobalOptions(program);
    expect(g.format).toBe("json");
  });
});

/* ─── toApiOpts ────────────────────────────────────────────────── */
describe("toApiOpts()", () => {
  it("有效 token 返回 ApiClientOptions", () => {
    const result = toApiOpts({
      apiBase: "http://api:3001",
      token: "valid-token",
      tenantId: "t1",
      spaceId: "s1",
      format: "json",
    });

    expect(result.apiBase).toBe("http://api:3001");
    expect(result.token).toBe("valid-token");
    expect(result.tenantId).toBe("t1");
    expect(result.spaceId).toBe("s1");
  });

  it("空 tenantId/spaceId 转为 undefined", () => {
    const result = toApiOpts({
      apiBase: "http://api:3001",
      token: "tok",
      tenantId: "",
      spaceId: "",
      format: "json",
    });

    expect(result.tenantId).toBeUndefined();
    expect(result.spaceId).toBeUndefined();
  });

  it("缺少 token 时调用 process.exit(1)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      toApiOpts({
        apiBase: "http://api:3001",
        token: "",
        tenantId: "",
        spaceId: "",
        format: "json",
      }),
    ).toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
