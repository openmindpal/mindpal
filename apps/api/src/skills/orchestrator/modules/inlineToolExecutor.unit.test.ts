import { describe, expect, it, vi, beforeEach } from "vitest";

// ── mock 准入检查 & 审计模块 ──
vi.mock("../../../kernel/executionKernel", () => ({
  admitInlineExecution: vi.fn().mockResolvedValue({ admitted: true }),
}));

vi.mock("../../../modules/audit/auditRepo", () => ({
  insertAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── mock repo 模块，拦截数据库调用 ──
vi.mock("../../../modules/memory/repo", () => ({
  searchMemory: vi.fn(),
  listMemoryEntries: vi.fn(),
  createMemoryEntry: vi.fn(),
  updateMemoryEntry: vi.fn(),
  getMemoryEntry: vi.fn(),
}));

vi.mock("../../knowledge-rag/modules/repo", () => ({
  searchChunksHybrid: vi.fn(),
}));

vi.mock("@openslin/shared", () => ({
  evaluateMemoryRisk: vi.fn(() => ({ level: "low", reasons: [] })),
  resolveNumber: vi.fn(() => ({ value: 0.6 })),
  shouldRequireApproval: vi.fn(() => false),
  ServiceError: class ServiceError extends Error {
    category; code; httpStatus; details;
    constructor(p: any) { super(p.message); this.category = p.category; this.code = p.code; this.httpStatus = p.httpStatus; this.details = p.details; }
  },
  ServiceErrorCategory: { AUTH_FAILED: "auth_failed", POLICY_VIOLATION: "policy_violation", RESOURCE_EXHAUSTED: "resource_exhausted", INVALID_REQUEST: "invalid_request", NOT_FOUND: "not_found", INTERNAL: "internal", TIMEOUT: "timeout" },
  ErrorCategory: { AUTH_FAILED: "auth_failed", POLICY_VIOLATION: "policy_violation", RESOURCE_EXHAUSTED: "resource_exhausted", INVALID_REQUEST: "invalid_request", NOT_FOUND: "not_found", INTERNAL: "internal", TIMEOUT: "timeout" },
  classifyError: vi.fn((err: any) => ({ category: "internal", code: "INTERNAL", httpStatus: 500, message: err?.message ?? "unknown" })),
  toHttpResponse: vi.fn((err: any) => ({ statusCode: err.httpStatus, body: { errorCode: err.code, message: err.message, category: err.category } })),
  StructuredLogger: class { constructor(_opts?: any) {} info() {} warn() {} error() {} debug() {} },
}));

import { executeInlineTools } from "./inlineToolExecutor";
import {
  updateMemoryEntry,
  getMemoryEntry,
} from "../../../modules/memory/repo";

// ── 工厂函数：构造符合 MemoryEntryRow 结构的 mock 数据 ──

function makeMemoryEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    tenantId: "tenant_dev",
    spaceId: "space_dev",
    ownerSubjectId: "admin",
    scope: "user" as const,
    type: "preference",
    title: "原始标题",
    contentText: "原始内容",
    contentDigest: "sha256-digest",
    expiresAt: null,
    retentionDays: null,
    writePolicy: "policyAllowed",
    sourceRef: null,
    writeProof: null,
    sourceTrust: 1,
    factVersion: 1,
    confidence: 1,
    salience: 1,
    conflictMarker: null,
    resolutionStatus: null,
    memoryClass: "episodic" as const,
    accessCount: 0,
    lastAccessedAt: null,
    decayScore: 1,
    decayUpdatedAt: new Date().toISOString(),
    distilledFrom: null,
    distilledTo: null,
    distillationGeneration: 0,
    arbitrationStrategy: null,
    arbitratedAt: null,
    arbitratedBy: null,
    pinned: false,
    pinnedAt: null,
    pinnedBy: null,
    provenanceType: "unknown",
    evidenceChain: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCtx() {
  return {
    pool: {} as any,
    tenantId: "tenant_dev",
    spaceId: "space_dev",
    subjectId: "admin",
    enabledTools: [],
    traceId: "trace-test-001",
    app: {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as any,
  };
}

function memoryWriteCall(input: Record<string, unknown>) {
  return {
    toolRef: "memory.write@latest",
    inputDraft: input,
  };
}

// ── 测试套件 ──

describe("executeMemoryWriteInline — 更新路径（含数据库回读逻辑）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正常路径：getMemoryEntry 成功返回，使用数据库中的最新值", async () => {
    const updateResult = makeMemoryEntry({ title: "更新后标题", contentText: "更新后内容", updatedAt: "2026-04-19T00:00:00.000Z" });
    const freshEntry = makeMemoryEntry({
      title: "数据库最新标题",
      contentText: "数据库最新内容",
      updatedAt: "2026-04-19T00:00:01.000Z",
    });

    vi.mocked(updateMemoryEntry).mockResolvedValueOnce({
      entry: updateResult,
      dlpSummary: { redacted: false },
      riskEvaluation: { level: "low", reasons: [] } as any,
    });
    vi.mocked(getMemoryEntry).mockResolvedValueOnce(freshEntry);

    const ctx = makeCtx();
    const [result] = await executeInlineTools(
      [memoryWriteCall({ id: updateResult.id, title: "新标题", contentText: "新内容", type: "preference" })],
      ctx,
    );

    expect(result.ok).toBe(true);
    const output = result.output as any;
    // 返回值应来自 getMemoryEntry 回读的最新数据
    expect(output.entry.title).toBe("数据库最新标题");
    expect(output.entry.contentText).toBe("数据库最新内容");
    expect(output.entry.updatedAt).toBe("2026-04-19T00:00:01.000Z");
    expect(output.message).toContain("更新");

    // 验证 getMemoryEntry 被调用
    expect(getMemoryEntry).toHaveBeenCalledOnce();
    expect(getMemoryEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: ctx.pool,
        tenantId: "tenant_dev",
        spaceId: "space_dev",
        subjectId: "admin",
        id: updateResult.id,
      }),
    );
  });

  it("降级路径：getMemoryEntry 抛出异常，使用更新返回值并记录警告", async () => {
    const updateResult = makeMemoryEntry({ title: "更新标题", contentText: "更新内容", updatedAt: "2026-04-19T00:00:00.000Z" });

    vi.mocked(updateMemoryEntry).mockResolvedValueOnce({
      entry: updateResult,
      dlpSummary: { redacted: false },
      riskEvaluation: { level: "low", reasons: [] } as any,
    });
    vi.mocked(getMemoryEntry).mockRejectedValueOnce(new Error("connection reset"));

    const ctx = makeCtx();
    const [result] = await executeInlineTools(
      [memoryWriteCall({ id: updateResult.id, title: "更新标题", contentText: "更新内容", type: "preference" })],
      ctx,
    );

    expect(result.ok).toBe(true);
    const output = result.output as any;
    // 降级：返回值来自 updateMemoryEntry 的结果
    expect(output.entry.title).toBe("更新标题");
    expect(output.entry.contentText).toBe("更新内容");
    expect(output.entry.id).toBe(updateResult.id);

    // 验证警告日志被记录
    expect(ctx.app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: updateResult.id, error: "connection reset" }),
      expect.stringContaining("降级使用更新返回值"),
    );
  });

  it("降级路径：getMemoryEntry 返回 null，使用更新返回值并记录警告", async () => {
    const updateResult = makeMemoryEntry({ title: "标题X", contentText: "内容X", updatedAt: "2026-04-19T02:00:00.000Z" });

    vi.mocked(updateMemoryEntry).mockResolvedValueOnce({
      entry: updateResult,
      dlpSummary: { redacted: false },
      riskEvaluation: { level: "low", reasons: [] } as any,
    });
    vi.mocked(getMemoryEntry).mockResolvedValueOnce(null);

    const ctx = makeCtx();
    const [result] = await executeInlineTools(
      [memoryWriteCall({ id: updateResult.id, title: "标题X", contentText: "内容X", type: "preference" })],
      ctx,
    );

    expect(result.ok).toBe(true);
    const output = result.output as any;
    expect(output.entry.title).toBe("标题X");
    expect(output.entry.contentText).toBe("内容X");

    // 验证警告日志：回读为空
    expect(ctx.app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: updateResult.id }),
      expect.stringContaining("重新加载记忆为空"),
    );
  });

  it("字段完整性：返回对象包含所有必要字段", async () => {
    const updateResult = makeMemoryEntry({
      title: "完整字段测试",
      contentText: "完整内容",
      scope: "space",
      type: "fact",
      updatedAt: "2026-04-19T03:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const freshEntry = makeMemoryEntry({
      ...updateResult,
      title: "回读完整字段",
      updatedAt: "2026-04-19T03:00:01.000Z",
    });

    vi.mocked(updateMemoryEntry).mockResolvedValueOnce({
      entry: updateResult,
      dlpSummary: { redacted: false },
      riskEvaluation: { level: "low", reasons: [] } as any,
    });
    vi.mocked(getMemoryEntry).mockResolvedValueOnce(freshEntry);

    const ctx = makeCtx();
    const [result] = await executeInlineTools(
      [memoryWriteCall({ id: updateResult.id, contentText: "完整内容", type: "fact", scope: "space" })],
      ctx,
    );

    expect(result.ok).toBe(true);
    const entry = (result.output as any).entry;

    // 逐一验证所有必要字段存在且类型正确
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("scope");
    expect(entry).toHaveProperty("type");
    expect(entry).toHaveProperty("title");
    expect(entry).toHaveProperty("contentText");
    expect(entry).toHaveProperty("updatedAt");
    expect(entry).toHaveProperty("createdAt");

    expect(typeof entry.id).toBe("string");
    expect(entry.scope).toBe("space");
    expect(entry.type).toBe("fact");
    expect(entry.title).toBe("回读完整字段");
  });

  it("部分更新：仅更新 title，contentText 保持原值", async () => {
    // 更新时仅传 title，contentText 由 executeMemoryWriteInline 从 input 取（非空）
    const updateResult = makeMemoryEntry({
      title: "新标题",
      contentText: "原始内容保留",
      updatedAt: "2026-04-19T04:00:00.000Z",
    });
    const freshEntry = makeMemoryEntry({
      title: "数据库新标题",
      contentText: "原始内容保留",
      updatedAt: "2026-04-19T04:00:01.000Z",
    });

    vi.mocked(updateMemoryEntry).mockResolvedValueOnce({
      entry: updateResult,
      dlpSummary: { redacted: false },
      riskEvaluation: { level: "low", reasons: [] } as any,
    });
    vi.mocked(getMemoryEntry).mockResolvedValueOnce(freshEntry);

    const ctx = makeCtx();
    const [result] = await executeInlineTools(
      [memoryWriteCall({ id: updateResult.id, title: "新标题", contentText: "原始内容保留", type: "preference" })],
      ctx,
    );

    expect(result.ok).toBe(true);
    const output = result.output as any;
    // title 应为回读的新值
    expect(output.entry.title).toBe("数据库新标题");
    // contentText 应保持不变
    expect(output.entry.contentText).toBe("原始内容保留");
  });

  it("记忆条目不存在时返回错误", async () => {
    vi.mocked(updateMemoryEntry).mockResolvedValueOnce(null);

    const ctx = makeCtx();
    const [result] = await executeInlineTools(
      [memoryWriteCall({ id: "nonexistent-id", title: "test", contentText: "test", type: "preference" })],
      ctx,
    );

    expect(result.ok).toBe(true); // executeInlineTools 层面 ok=true，错误在 output 中
    const output = result.output as any;
    expect(output.ok).toBe(false);
    expect(output.error).toContain("不存在");
  });

  it("返回值包含 dlpSummary 和 riskEvaluation", async () => {
    const updateResult = makeMemoryEntry({ title: "DLP测试", contentText: "敏感内容" });
    const dlpSummary = { redacted: true, fields: ["contentText"] };
    const riskEval = { level: "medium", reasons: ["contains_pii"] };

    vi.mocked(updateMemoryEntry).mockResolvedValueOnce({
      entry: updateResult,
      dlpSummary,
      riskEvaluation: riskEval as any,
    });
    vi.mocked(getMemoryEntry).mockResolvedValueOnce(updateResult);

    const ctx = makeCtx();
    const [result] = await executeInlineTools(
      [memoryWriteCall({ id: updateResult.id, title: "DLP测试", contentText: "敏感内容", type: "preference" })],
      ctx,
    );

    expect(result.ok).toBe(true);
    const output = result.output as any;
    expect(output.dlpSummary).toEqual(dlpSummary);
    expect(output.riskEvaluation).toEqual(riskEval);
  });
});
