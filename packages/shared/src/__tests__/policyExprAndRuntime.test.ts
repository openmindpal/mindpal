import { describe, expect, it } from "vitest";
import { validatePolicyExpr, compilePolicyExprWhere } from "../policyExpr";
import {
  isPlainObject, normalizeStringSet, normalizeLimits, normalizeNetworkPolicy,
  isAllowedHost, isAllowedEgress, withConcurrency, withTimeout,
} from "../runtime";

/* ────────────── policyExpr ────────────── */

describe("validatePolicyExpr", () => {
  it("eq 操作符：subject vs record", () => {
    const v = validatePolicyExpr({
      op: "eq",
      left: { kind: "subject", key: "subjectId" },
      right: { kind: "record", key: "ownerSubjectId" },
    });
    expect(v.ok).toBe(true);
  });

  it("eq 操作符：subject vs literal", () => {
    const v = validatePolicyExpr({
      op: "eq",
      left: { kind: "subject", key: "tenantId" },
      right: "t1",
    });
    expect(v.ok).toBe(true);
  });

  it("and 操作符", () => {
    const v = validatePolicyExpr({
      op: "and",
      args: [
        { op: "eq", left: { kind: "subject", key: "subjectId" }, right: "u1" },
        { op: "eq", left: { kind: "subject", key: "tenantId" }, right: "t1" },
      ],
    });
    expect(v.ok).toBe(true);
  });

  it("or 操作符", () => {
    const v = validatePolicyExpr({
      op: "or",
      args: [
        { op: "eq", left: { kind: "subject", key: "subjectId" }, right: "u1" },
        { op: "eq", left: { kind: "subject", key: "subjectId" }, right: "u2" },
      ],
    });
    expect(v.ok).toBe(true);
  });

  it("not 操作符", () => {
    const v = validatePolicyExpr({
      op: "not",
      arg: { op: "eq", left: { kind: "subject", key: "subjectId" }, right: "u1" },
    });
    expect(v.ok).toBe(true);
  });

  it("in 操作符", () => {
    const v = validatePolicyExpr({
      op: "in",
      left: { kind: "subject", key: "subjectId" },
      right: { kind: "list", values: ["u1", "u2", "u3"] },
    });
    expect(v.ok).toBe(true);
  });

  it("exists 操作符", () => {
    const v = validatePolicyExpr({ op: "exists", operand: { kind: "payload", path: "tags" } });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.usedPayloadPaths).toContain("tags");
  });

  it("gte/lte 操作符", () => {
    expect(validatePolicyExpr({ op: "gte", left: { kind: "subject", key: "subjectId" }, right: "x" }).ok).toBe(true);
    expect(validatePolicyExpr({ op: "lte", left: { kind: "subject", key: "subjectId" }, right: "x" }).ok).toBe(true);
  });

  it("between 操作符", () => {
    const v = validatePolicyExpr({ op: "between", operand: { kind: "payload", path: "score" }, low: 0, high: 100 });
    expect(v.ok).toBe(true);
  });

  it("gt/lt/neq 操作符", () => {
    expect(validatePolicyExpr({ op: "gt", left: { kind: "subject", key: "subjectId" }, right: "x" }).ok).toBe(true);
    expect(validatePolicyExpr({ op: "lt", left: { kind: "subject", key: "subjectId" }, right: "x" }).ok).toBe(true);
    expect(validatePolicyExpr({ op: "neq", left: { kind: "subject", key: "subjectId" }, right: "x" }).ok).toBe(true);
  });

  it("regex 操作符", () => {
    const v = validatePolicyExpr({ op: "regex", operand: { kind: "payload", path: "name" }, pattern: "^test" });
    expect(v.ok).toBe(true);
  });

  it("contains 操作符", () => {
    const v = validatePolicyExpr({ op: "contains", operand: { kind: "payload", path: "name" }, value: "test" });
    expect(v.ok).toBe(true);
  });

  it("starts_with/ends_with 操作符", () => {
    expect(validatePolicyExpr({ op: "starts_with", operand: { kind: "payload", path: "name" }, prefix: "pre" }).ok).toBe(true);
    expect(validatePolicyExpr({ op: "ends_with", operand: { kind: "payload", path: "name" }, suffix: "suf" }).ok).toBe(true);
  });

  it("time_window 操作符", () => {
    const v = validatePolicyExpr({ op: "time_window", timeZone: "UTC", days: [1, 2, 3], startHour: "09:00", endHour: "17:00" });
    expect(v.ok).toBe(true);
  });

  it("ip_in_cidr 操作符", () => {
    const v = validatePolicyExpr({ op: "ip_in_cidr", operand: { kind: "env", key: "ip" }, cidrs: ["10.0.0.0/8"] });
    expect(v.ok).toBe(true);
  });

  it("env 操作数", () => {
    const v = validatePolicyExpr({ op: "eq", left: { kind: "env", key: "ip" }, right: "1.2.3.4" });
    expect(v.ok).toBe(true);
  });

  it("time 操作数", () => {
    const v = validatePolicyExpr({ op: "eq", left: { kind: "time", key: "dayOfWeek" }, right: 1 });
    expect(v.ok).toBe(true);
  });

  it("context 操作数：白名单路径允许", () => {
    const v = validatePolicyExpr({ op: "eq", left: { kind: "context", path: "subject.id" }, right: "u1" });
    expect(v.ok).toBe(true);
  });

  it("context 操作数：非白名单路径拒绝", () => {
    const v = validatePolicyExpr({ op: "eq", left: { kind: "context", path: "subject.roleIds" }, right: "x" });
    expect(v.ok).toBe(false);
  });

  it("payload 路径注入拒绝", () => {
    const v = validatePolicyExpr({ op: "exists", operand: { kind: "payload", path: "a);drop table x;--" } });
    expect(v.ok).toBe(false);
  });

  it("非法操作符拒绝", () => {
    const v = validatePolicyExpr({ op: "INVALID", left: "a", right: "b" });
    expect(v.ok).toBe(false);
  });

  it("null 输入拒绝", () => {
    expect(validatePolicyExpr(null).ok).toBe(false);
  });

  it("非法操作数类型拒绝", () => {
    const v = validatePolicyExpr({ op: "eq", left: { kind: "unknown", key: "x" }, right: "a" });
    expect(v.ok).toBe(false);
  });

  it("and 空数组拒绝", () => {
    expect(validatePolicyExpr({ op: "and", args: [] }).ok).toBe(false);
  });

  it("payload 路径收集", () => {
    const v = validatePolicyExpr({
      op: "and",
      args: [
        { op: "eq", left: { kind: "payload", path: "a" }, right: "x" },
        { op: "exists", operand: { kind: "payload", path: "b" } },
      ],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.usedPayloadPaths).toContain("a");
      expect(v.usedPayloadPaths).toContain("b");
    }
  });
});

describe("compilePolicyExprWhere", () => {
  it("编译 eq 表达式为 SQL", () => {
    const args: any[] = [];
    const result = compilePolicyExprWhere({
      expr: { op: "eq", left: { kind: "subject", key: "subjectId" }, right: { kind: "record", key: "ownerSubjectId" } },
      subject: { subjectId: "u1", tenantId: "t1", spaceId: "s1" },
      args,
      idxStart: 0,
      ownerColumn: "owner_subject_id",
      payloadColumn: "payload",
    });
    expect(result.sql).toBeTruthy();
    expect(typeof result.sql).toBe("string");
  });

  it("SQL 注入 payload 路径抛出异常", () => {
    const args: any[] = [];
    expect(() =>
      compilePolicyExprWhere({
        expr: { op: "exists", operand: { kind: "payload", path: "a);drop table x;--" } },
        subject: { subjectId: "u1", tenantId: "t1", spaceId: "s1" },
        args,
        idxStart: 0,
        ownerColumn: "owner_subject_id",
        payloadColumn: "payload",
      }),
    ).toThrow();
  });
});

/* ────────────── runtime ────────────── */

describe("isPlainObject", () => {
  it("普通对象返回 true", () => expect(isPlainObject({ a: 1 })).toBe(true));
  it("空对象返回 true", () => expect(isPlainObject({})).toBe(true));
  it("数组返回 false", () => expect(isPlainObject([])).toBe(false));
  it("null 返回 false", () => expect(isPlainObject(null)).toBe(false));
  it("字符串返回 false", () => expect(isPlainObject("x")).toBe(false));
});

describe("normalizeStringSet", () => {
  it("逗号字符串拆分", () => {
    const s = normalizeStringSet("a,b,c", "");
    expect(s).toEqual(new Set(["a", "b", "c"]));
  });

  it("null 使用 fallback", () => {
    const s = normalizeStringSet(null, "x,y");
    expect(s).toEqual(new Set(["x", "y"]));
  });

  it("数组输入", () => {
    const s = normalizeStringSet(["a", " b "], "");
    expect(s).toEqual(new Set(["a", "b"]));
  });

  it("Set 输入", () => {
    const s = normalizeStringSet(new Set(["a", "b"]), "");
    expect(s).toEqual(new Set(["a", "b"]));
  });
});

describe("normalizeLimits", () => {
  it("默认值", () => {
    const l = normalizeLimits({});
    expect(l.timeoutMs).toBe(10_000);
    expect(l.maxConcurrency).toBe(10);
    expect(l.memoryMb).toBeNull();
    expect(l.maxOutputBytes).toBe(1_000_000);
    expect(l.maxEgressRequests).toBe(50);
  });

  it("自定义值", () => {
    const l = normalizeLimits({ timeoutMs: 3000, maxConcurrency: 2, memoryMb: 512, cpuMs: 500, maxOutputBytes: 2000, maxEgressRequests: 5 });
    expect(l.timeoutMs).toBe(3000);
    expect(l.maxConcurrency).toBe(2);
    expect(l.memoryMb).toBe(512);
    expect(l.cpuMs).toBe(500);
    expect(l.maxEgressRequests).toBe(5);
  });

  it("非对象输入返回默认值", () => {
    const l = normalizeLimits(null);
    expect(l.timeoutMs).toBe(10_000);
  });
});

describe("normalizeNetworkPolicy", () => {
  it("归一化域名", () => {
    const p = normalizeNetworkPolicy({ allowedDomains: ["Example.COM", " ok.com "], rules: [] });
    expect(p.allowedDomains).toEqual(["example.com", "ok.com"]);
  });

  it("过滤含协议/端口的域名", () => {
    const p = normalizeNetworkPolicy({ allowedDomains: ["http://bad", "a.com:443", "good.com"], rules: [] });
    expect(p.allowedDomains).toEqual(["good.com"]);
  });

  it("归一化 rules", () => {
    const p = normalizeNetworkPolicy({
      allowedDomains: [],
      rules: [{ host: "API.Example.com", pathPrefix: "v1", methods: ["post"] }],
    });
    expect(p.rules[0].host).toBe("api.example.com");
    expect(p.rules[0].pathPrefix).toBe("/v1");
    expect(p.rules[0].methods).toEqual(["POST"]);
  });
});

describe("isAllowedHost", () => {
  it("精确匹配", () => {
    expect(isAllowedHost(["example.com"], "example.com")).toBe(true);
    expect(isAllowedHost(["example.com"], "evil.com")).toBe(false);
  });

  it("通配符 *", () => {
    expect(isAllowedHost(["*"], "anything.com")).toBe(true);
  });

  it("前缀通配符 *.example.com", () => {
    expect(isAllowedHost(["*.example.com"], "api.example.com")).toBe(true);
    expect(isAllowedHost(["*.example.com"], "example.com")).toBe(false);
  });
});

describe("isAllowedEgress", () => {
  it("域名白名单放行", () => {
    const p = normalizeNetworkPolicy({ allowedDomains: ["example.com"], rules: [] });
    const r = isAllowedEgress({ policy: p, url: "https://example.com/path", method: "GET" });
    expect(r.allowed).toBe(true);
  });

  it("非 http/https 协议拒绝", () => {
    const p = normalizeNetworkPolicy({ allowedDomains: ["example.com"], rules: [] });
    const r = isAllowedEgress({ policy: p, url: "ftp://example.com/file", method: "GET" });
    expect(r.allowed).toBe(false);
  });

  it("规则匹配放行", () => {
    const p = normalizeNetworkPolicy({ allowedDomains: [], rules: [{ host: "api.com", pathPrefix: "/v1", methods: ["GET"] }] });
    const r = isAllowedEgress({ policy: p, url: "https://api.com/v1/data", method: "GET" });
    expect(r.allowed).toBe(true);
  });

  it("规则不匹配拒绝", () => {
    const p = normalizeNetworkPolicy({ allowedDomains: [], rules: [{ host: "api.com", pathPrefix: "/v1", methods: ["GET"] }] });
    const r = isAllowedEgress({ policy: p, url: "https://api.com/v2/data", method: "GET" });
    expect(r.allowed).toBe(false);
  });

  it("无效 URL 拒绝", () => {
    const p = normalizeNetworkPolicy({ allowedDomains: [], rules: [] });
    const r = isAllowedEgress({ policy: p, url: "not-a-url", method: "GET" });
    expect(r.allowed).toBe(false);
  });
});

describe("withTimeout", () => {
  it("正常完成", async () => {
    const result = await withTimeout(1000, async () => "ok");
    expect(result).toBe("ok");
  });

  it("超时抛出", async () => {
    await expect(
      withTimeout(10, async () => new Promise((r) => setTimeout(r, 500))),
    ).rejects.toThrow("timeout");
  });
});

describe("withConcurrency", () => {
  it("正常执行", async () => {
    const result = await withConcurrency("test-key-" + Date.now(), 5, async () => "ok");
    expect(result).toBe("ok");
  });

  it("超过并发限制抛出", async () => {
    const key = "test-conc-" + Date.now();
    // 占满并发
    const p1 = withConcurrency(key, 1, () => new Promise((r) => setTimeout(() => r("a"), 200)));
    // 等一下让 p1 先占住
    await new Promise((r) => setTimeout(r, 10));
    await expect(withConcurrency(key, 1, async () => "b")).rejects.toThrow("resource_exhausted:max_concurrency");
    await p1;
  });
});
