import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock SDK 内部依赖模块（迁移后路径） ──────────────────────────

vi.mock("@mindpal/shared", () => ({
  classifyError: vi.fn((err: any) => ({
    category: "internal",
    code: "INTERNAL",
    httpStatus: 500,
    message: err?.message ?? "unknown",
  })),
  createTraceContext: vi.fn(() => ({})),
  injectTraceHeaders: vi.fn(() => ({})),
}));

// Mock SDK 内核日志模块
vi.mock("../../../../packages/device-agent-sdk/src/kernel/log", () => ({
  safeLog: vi.fn(),
  safeError: vi.fn(),
  sha256_8: vi.fn((s: string) => s.slice(0, 8).padEnd(8, "0")),
  deviceLogger: { info: vi.fn(), error: vi.fn() },
}));

// Mock SDK 内核任务执行器
vi.mock("../../../../packages/device-agent-sdk/src/kernel/taskExecutor", () => ({
  executeDeviceTool: vi.fn(async () => ({ status: "succeeded" as const, outputDigest: { ok: true } })),
}));

// Mock SDK 内核能力注册表
vi.mock("../../../../packages/device-agent-sdk/src/kernel/capabilityRegistry", () => ({
  dispatchMessageToPlugins: vi.fn(async () => {}),
  registerCapability: vi.fn(),
  registerCapabilities: vi.fn(),
  unregisterCapability: vi.fn(),
  unregisterPluginCapabilities: vi.fn(),
  getCapability: vi.fn(),
  findCapabilitiesByPrefix: vi.fn(() => []),
  findCapabilitiesByRiskLevel: vi.fn(() => []),
  findCapabilitiesByTag: vi.fn(() => []),
  listCapabilities: vi.fn(() => []),
  getToolRiskLevel: vi.fn(),
  registerPlugin: vi.fn(),
  unregisterPlugin: vi.fn(),
  findPluginForTool: vi.fn(() => null),
  listPlugins: vi.fn(() => []),
  clearAll: vi.fn(),
  registerToolAlias: vi.fn(),
  registerToolAliases: vi.fn(),
  registerPrefixRule: vi.fn(),
  registerPrefixRules: vi.fn(),
  resolveToolAlias: vi.fn(),
  listToolAliases: vi.fn(() => []),
  listPrefixRules: vi.fn(() => []),
  loadAliasesFromFile: vi.fn(),
  loadAliasesFromEnv: vi.fn(),
  initToolAliases: vi.fn(),
  exportCapabilityManifest: vi.fn(() => []),
  getMultimodalCapabilities: vi.fn(() => []),
}));

// Mock SDK 传输层 HTTP 客户端
vi.mock("../../../../packages/device-agent-sdk/src/transport/httpClient", () => ({
  apiPostJson: vi.fn(async () => ({ status: 200, json: {} })),
}));

// Mock SDK 内核认证模块
vi.mock("../../../../packages/device-agent-sdk/src/kernel/auth", () => ({
  syncPolicyToCache: vi.fn(async () => {}),
  initAccessControl: vi.fn(),
  getAccessPolicy: vi.fn(),
  generateCallerToken: vi.fn(),
  verifyCallerToken: vi.fn(),
  isCallerAllowed: vi.fn(),
  isToolAllowed: vi.fn(),
  extractCallerFromRequest: vi.fn(),
  getOrCreateContext: vi.fn(),
  getContext: vi.fn(),
  destroyContext: vi.fn(),
  cleanupExpiredContexts: vi.fn(),
  getContextState: vi.fn(),
  setContextState: vi.fn(),
  deleteContextState: vi.fn(),
  getAccessStats: vi.fn(),
  initPolicyCache: vi.fn(),
  cachePolicy: vi.fn(),
  getCachedPolicy: vi.fn(),
  hasCachedPolicy: vi.fn(),
  isCachedToolAllowed: vi.fn(),
  getCachedPolicyForExecution: vi.fn(),
  clearPolicyCache: vi.fn(),
  buildOfflineClaim: vi.fn(),
  getPolicyCacheStatus: vi.fn(),
}));

import { sendTaskResult, handleDeviceMessage, handleTaskPending, type WsTaskContext } from "@mindpal/device-agent-sdk";
import { safeError } from "../../../../packages/device-agent-sdk/src/kernel/log";
import { dispatchMessageToPlugins } from "../../../../packages/device-agent-sdk/src/kernel/capabilityRegistry";
import { executeDeviceTool } from "../../../../packages/device-agent-sdk/src/kernel/taskExecutor";
import { apiPostJson } from "../../../../packages/device-agent-sdk/src/transport/httpClient";

function makeCtx(overrides?: Partial<WsTaskContext>): WsTaskContext {
  return {
    config: { apiBase: "http://localhost:3000", deviceToken: "tok-123", deviceId: "dev-1" },
    confirmFn: vi.fn(async () => true),
    ws: { readyState: 1, send: vi.fn() },
    setNeedReEnroll: vi.fn(),
    stop: vi.fn(),
    setCurrentTask: vi.fn(),
    setRunning: vi.fn(),
    ...overrides,
  };
}

describe("wsMessageHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── sendTaskResult ──────────────────────────────────────────

  describe("sendTaskResult", () => {
    it("sends JSON message over WebSocket when connected", () => {
      const ctx = makeCtx();
      sendTaskResult(ctx, "exec-1", "succeeded", { outputDigest: { ok: true } });

      expect(ctx.ws!.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse((ctx.ws!.send as any).mock.calls[0][0]);
      expect(sent.type).toBe("task_result");
      expect(sent.payload.executionId).toBe("exec-1");
      expect(sent.payload.status).toBe("succeeded");
      expect(sent.payload.timestamp).toBeTypeOf("number");
    });

    it("skips sending when WebSocket is not open", () => {
      const ctx = makeCtx({ ws: { readyState: 3, send: vi.fn() } });
      sendTaskResult(ctx, "exec-2", "failed");

      expect(ctx.ws!.send).not.toHaveBeenCalled();
      expect(safeError).toHaveBeenCalled();
    });

    it("skips sending when ws is null", () => {
      const ctx = makeCtx({ ws: null });
      sendTaskResult(ctx, "exec-3", "failed");
      // Should not throw
      expect(safeError).toHaveBeenCalled();
    });

    it("handles send() exception gracefully", () => {
      const ctx = makeCtx({
        ws: { readyState: 1, send: vi.fn(() => { throw new Error("send fail"); }) },
      });
      expect(() => sendTaskResult(ctx, "exec-4", "succeeded")).not.toThrow();
      expect(safeError).toHaveBeenCalled();
    });

    it("includes errorCategory and evidenceRefs in payload", () => {
      const ctx = makeCtx();
      sendTaskResult(ctx, "exec-5", "failed", {
        errorCategory: "timeout",
        evidenceRefs: ["ref-1"],
      });

      const sent = JSON.parse((ctx.ws!.send as any).mock.calls[0][0]);
      expect(sent.payload.errorCategory).toBe("timeout");
      expect(sent.payload.evidenceRefs).toEqual(["ref-1"]);
    });
  });

  // ── handleDeviceMessage ─────────────────────────────────────

  describe("handleDeviceMessage", () => {
    it("dispatches message with valid messageId to plugins", async () => {
      await handleDeviceMessage({ messageId: "msg-1", fromDeviceId: "dev-2", topic: "test", payload: { data: 1 } });

      expect(dispatchMessageToPlugins).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "msg-1", fromDeviceId: "dev-2", topic: "test" }),
      );
    });

    it("rejects message without messageId", async () => {
      await handleDeviceMessage({});
      expect(safeError).toHaveBeenCalledWith(expect.stringContaining("messageId"));
      expect(dispatchMessageToPlugins).not.toHaveBeenCalled();
    });

    it("uses defaults for missing optional fields", async () => {
      await handleDeviceMessage({ messageId: "msg-2" });

      expect(dispatchMessageToPlugins).toHaveBeenCalledWith(
        expect.objectContaining({ fromDeviceId: null, topic: null }),
      );
    });

    it("handles plugin dispatch error gracefully", async () => {
      vi.mocked(dispatchMessageToPlugins).mockRejectedValueOnce(new Error("plugin boom"));
      await expect(handleDeviceMessage({ messageId: "msg-3" })).resolves.toBeUndefined();
      expect(safeError).toHaveBeenCalledWith(expect.stringContaining("分发失败"));
    });
  });

  // ── handleTaskPending ───────────────────────────────────────

  describe("handleTaskPending", () => {
    it("rejects when executionId is missing", async () => {
      const ctx = makeCtx();
      await handleTaskPending(ctx, {});
      expect(safeError).toHaveBeenCalledWith(expect.stringContaining("任务 ID 缺失"));
      expect(ctx.setRunning).not.toHaveBeenCalled();
    });

    it("executes inline claim directly without HTTP", async () => {
      const ctx = makeCtx();
      const claim = { execution: { deviceExecutionId: "e-1", toolRef: "device.test.echo", input: {} } };
      await handleTaskPending(ctx, { executionId: "e-1", claim });

      expect(executeDeviceTool).toHaveBeenCalledWith(
        expect.objectContaining({ claim }),
      );
      expect(ctx.setCurrentTask).toHaveBeenCalledWith("e-1");
      expect(ctx.setRunning).toHaveBeenCalledWith(true);
      // Cleanup
      expect(ctx.setCurrentTask).toHaveBeenCalledWith(undefined);
      expect(ctx.setRunning).toHaveBeenCalledWith(false);
    });

    it("falls back to HTTP claim when no inline claim", async () => {
      const ctx = makeCtx();
      vi.mocked(apiPostJson).mockResolvedValueOnce({
        status: 200,
        json: { execution: { deviceExecutionId: "e-2", toolRef: "device.test.noop" } },
      } as any);

      await handleTaskPending(ctx, { executionId: "e-2" });

      expect(apiPostJson).toHaveBeenCalledWith(
        expect.objectContaining({ path: expect.stringContaining("e-2") }),
      );
      expect(executeDeviceTool).toHaveBeenCalled();
    });

    it("triggers re-enroll on 401 from claim", async () => {
      const ctx = makeCtx();
      vi.mocked(apiPostJson).mockResolvedValueOnce({ status: 401, json: null } as any);

      await handleTaskPending(ctx, { executionId: "e-3" });

      expect(ctx.setNeedReEnroll).toHaveBeenCalled();
      expect(ctx.stop).toHaveBeenCalled();
    });

    it("reports failed when claim returns non-200", async () => {
      const ctx = makeCtx();
      vi.mocked(apiPostJson).mockResolvedValueOnce({ status: 500, json: null } as any);

      await handleTaskPending(ctx, { executionId: "e-4" });

      expect(ctx.ws!.send).toHaveBeenCalled();
      const sent = JSON.parse((ctx.ws!.send as any).mock.calls[0][0]);
      expect(sent.payload.status).toBe("failed");
      expect(sent.payload.errorCategory).toBe("claim_failed");
    });

    it("handles executor exception and reports failure", async () => {
      const ctx = makeCtx();
      vi.mocked(executeDeviceTool).mockRejectedValueOnce(new Error("boom"));
      const claim = { execution: { deviceExecutionId: "e-5", toolRef: "device.test.fail" } };

      await handleTaskPending(ctx, { executionId: "e-5", claim });

      expect(ctx.ws!.send).toHaveBeenCalled();
      const sent = JSON.parse((ctx.ws!.send as any).mock.calls[0][0]);
      expect(sent.payload.status).toBe("failed");
      expect(sent.payload.errorCategory).toBe("executor_exception");
    });
  });
});
