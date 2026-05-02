/**
 * rpcProtocol.test.ts — Skill RPC 协议正确性单元测试
 *
 * 功能目标：验证 packages/shared/src/skillRpcProtocol.ts 导出的 RPC 消息
 * 创建、序列化、解析、类型判断等函数的正确性。
 */
import { describe, it, expect } from "vitest";
import {
  SKILL_RPC_JSONRPC,
  SKILL_RPC_ERRORS,
  SKILL_RPC_METHODS,
  createRpcRequest,
  createRpcSuccess,
  createRpcError,
  createRpcNotification,
  serializeRpcMessage,
  parseRpcMessage,
  isRpcRequest,
  isRpcNotification,
  isRpcResponse,
  isRpcError,
  isVersionCompatible,
  negotiateVersion,
  PROTOCOL_VERSIONS,
  type SkillRpcRequest,
  type SkillRpcSuccess,
  type SkillRpcError,
  type SkillRpcNotification,
  type SkillExecuteParams,
} from "@mindpal/shared";

/* ── parseRpcMessage ─────────────────────────────────────── */
describe("parseRpcMessage", () => {
  it("解析有效的 execute 请求", () => {
    const req = createRpcRequest("req-1", SKILL_RPC_METHODS.EXECUTE, {
      requestId: "r1",
      input: { text: "hello" },
      inputDigest: { sha256_8: "abc12345", bytes: 5 },
    } satisfies SkillExecuteParams);

    const line = JSON.stringify(req);
    const parsed = parseRpcMessage(line);

    expect(parsed).not.toBeNull();
    expect((parsed as SkillRpcRequest).jsonrpc).toBe("2.0");
    expect((parsed as SkillRpcRequest).id).toBe("req-1");
    expect((parsed as SkillRpcRequest).method).toBe("skill.execute");
    expect((parsed as SkillRpcRequest).params).toEqual({
      requestId: "r1",
      input: { text: "hello" },
      inputDigest: { sha256_8: "abc12345", bytes: 5 },
    });
  });

  it("解析有效的 result 响应", () => {
    const res = createRpcSuccess("req-1", { output: { data: 42 } });
    const line = JSON.stringify(res);
    const parsed = parseRpcMessage(line);

    expect(parsed).not.toBeNull();
    expect((parsed as SkillRpcSuccess).id).toBe("req-1");
    expect((parsed as SkillRpcSuccess).result).toEqual({ output: { data: 42 } });
  });

  it("对无效 JSON 返回 null", () => {
    expect(parseRpcMessage("not-json")).toBeNull();
    expect(parseRpcMessage("{broken")).toBeNull();
  });

  it("对空行返回 null", () => {
    expect(parseRpcMessage("")).toBeNull();
    expect(parseRpcMessage("  \n  ")).toBeNull();
  });

  it("对缺少 jsonrpc 字段的 JSON 返回 null", () => {
    expect(parseRpcMessage('{"id":1,"method":"test"}')).toBeNull();
  });

  it("对 jsonrpc 不是 2.0 的 JSON 返回 null", () => {
    expect(parseRpcMessage('{"jsonrpc":"1.0","id":1,"method":"test"}')).toBeNull();
  });
});

/* ── 序列化/反序列化往返一致性 ──────────────────────────────── */
describe("serialize / parse roundtrip", () => {
  it("请求消息往返一致", () => {
    const req = createRpcRequest(1, "skill.execute", { input: { x: 1 } });
    const serialized = serializeRpcMessage(req);
    const parsed = parseRpcMessage(serialized);

    expect(parsed).toEqual(req);
  });

  it("成功响应消息往返一致", () => {
    const res = createRpcSuccess("id-2", { output: "done" });
    const serialized = serializeRpcMessage(res);
    const parsed = parseRpcMessage(serialized);

    expect(parsed).toEqual(res);
  });

  it("错误响应消息往返一致", () => {
    const err = createRpcError("id-3", SKILL_RPC_ERRORS.EXECUTION_TIMEOUT, "timeout exceeded");
    const serialized = serializeRpcMessage(err);
    const parsed = parseRpcMessage(serialized);

    expect(parsed).toEqual(err);
  });

  it("通知消息往返一致", () => {
    const notif = createRpcNotification("skill.progress", { progress: 50 });
    const serialized = serializeRpcMessage(notif);
    const parsed = parseRpcMessage(serialized);

    expect(parsed).toEqual(notif);
  });

  it("serializeRpcMessage 输出以换行结尾", () => {
    const msg = createRpcRequest(1, "test", {});
    const serialized = serializeRpcMessage(msg);
    expect(serialized.endsWith("\n")).toBe(true);
  });
});

/* ── 错误消息结构验证 ───────────────────────────────────────── */
describe("createRpcError", () => {
  it("error.message 字段正确设置", () => {
    const err = createRpcError("e1", SKILL_RPC_ERRORS.EXECUTION_FAILED, "skill crashed");
    expect(err.error.message).toBe("skill crashed");
    expect(err.error.code).toBe(SKILL_RPC_ERRORS.EXECUTION_FAILED);
  });

  it("支持 data 附加字段", () => {
    const err = createRpcError("e2", SKILL_RPC_ERRORS.POLICY_VIOLATION, "blocked", { module: "vm" });
    expect(err.error.data).toEqual({ module: "vm" });
  });

  it("不传 data 时 error 中不包含 data 字段", () => {
    const err = createRpcError("e3", SKILL_RPC_ERRORS.INTERNAL_ERROR, "oops");
    expect("data" in err.error).toBe(false);
  });

  it("id 可以为 null（解析阶段错误）", () => {
    const err = createRpcError(null, SKILL_RPC_ERRORS.PARSE_ERROR, "invalid json");
    expect(err.id).toBeNull();
    expect(err.jsonrpc).toBe("2.0");
  });
});

/* ── 类型判断辅助函数 ───────────────────────────────────────── */
describe("message type guards", () => {
  it("isRpcRequest 正确识别请求", () => {
    const req = createRpcRequest(1, "skill.execute", {});
    expect(isRpcRequest(req)).toBe(true);
    expect(isRpcResponse(req)).toBe(false);
  });

  it("isRpcNotification 正确识别通知（无 id）", () => {
    const notif = createRpcNotification("skill.progress", { progress: 80 });
    expect(isRpcNotification(notif)).toBe(true);
    expect(isRpcRequest(notif)).toBe(false);
  });

  it("isRpcResponse 正确识别成功响应", () => {
    const res = createRpcSuccess(1, { ok: true });
    expect(isRpcResponse(res)).toBe(true);
    expect(isRpcRequest(res)).toBe(false);
  });

  it("isRpcError 正确识别错误响应", () => {
    const err = createRpcError(1, -32600, "bad request");
    expect(isRpcError(err)).toBe(true);
    expect(isRpcResponse(err)).toBe(true);
  });
});

/* ── 方法名常量 ─────────────────────────────────────────────── */
describe("SKILL_RPC_METHODS", () => {
  it("包含核心方法名", () => {
    expect(SKILL_RPC_METHODS.INITIALIZE).toBe("skill.initialize");
    expect(SKILL_RPC_METHODS.EXECUTE).toBe("skill.execute");
    expect(SKILL_RPC_METHODS.HEARTBEAT).toBe("skill.heartbeat");
    expect(SKILL_RPC_METHODS.SHUTDOWN).toBe("skill.shutdown");
  });

  it("包含通知方法名", () => {
    expect(SKILL_RPC_METHODS.PROGRESS).toBe("skill.progress");
    expect(SKILL_RPC_METHODS.LOG).toBe("skill.log");
  });
});

/* ── 错误码常量 ─────────────────────────────────────────────── */
describe("SKILL_RPC_ERRORS", () => {
  it("标准 JSON-RPC 错误码在负数范围", () => {
    expect(SKILL_RPC_ERRORS.PARSE_ERROR).toBe(-32700);
    expect(SKILL_RPC_ERRORS.INVALID_REQUEST).toBe(-32600);
    expect(SKILL_RPC_ERRORS.METHOD_NOT_FOUND).toBe(-32601);
  });

  it("自定义错误码在 -32000~-32099 范围", () => {
    expect(SKILL_RPC_ERRORS.EXECUTION_TIMEOUT).toBe(-32001);
    expect(SKILL_RPC_ERRORS.POLICY_VIOLATION).toBe(-32004);
    expect(SKILL_RPC_ERRORS.CAPABILITY_DENIED).toBe(-32006);
  });
});

/* ── 版本兼容性 ─────────────────────────────────────────────── */
describe("version compatibility", () => {
  it("isVersionCompatible 同版本兼容", () => {
    expect(isVersionCompatible("1.0", "1.0")).toBe(true);
  });

  it("isVersionCompatible 高版本兼容低版本", () => {
    expect(isVersionCompatible("2.0", "1.0")).toBe(true);
  });

  it("isVersionCompatible 低版本不兼容高版本", () => {
    expect(isVersionCompatible("1.0", "2.0")).toBe(false);
  });

  it("isVersionCompatible 无效版本返回 false", () => {
    expect(isVersionCompatible("abc", "1.0")).toBe(false);
  });

  it("negotiateVersion 选出兼容的最高版本", () => {
    expect(negotiateVersion("1.0", PROTOCOL_VERSIONS)).toBe("1.0");
  });

  it("negotiateVersion 无兼容版本返回 null", () => {
    expect(negotiateVersion("0.5", ["1.0", "2.0"])).toBeNull();
  });
});
