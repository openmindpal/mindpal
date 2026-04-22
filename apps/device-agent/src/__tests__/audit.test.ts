import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";

// ── Mock node:fs/promises ─────────────────────────────────────
const mockMkdir = vi.fn<(...args: any[]) => Promise<any>>();
const mockAppendFile = vi.fn<(...args: any[]) => Promise<any>>();
const mockReadFile = vi.fn<(...args: any[]) => Promise<any>>();
const mockReaddir = vi.fn<(...args: any[]) => Promise<any>>();
const mockUnlink = vi.fn<(...args: any[]) => Promise<any>>();
const mockWriteFile = vi.fn<(...args: any[]) => Promise<any>>();

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: (...args: any[]) => mockMkdir(...args),
    appendFile: (...args: any[]) => mockAppendFile(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    readdir: (...args: any[]) => mockReaddir(...args),
    unlink: (...args: any[]) => mockUnlink(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
  },
  mkdir: (...args: any[]) => mockMkdir(...args),
  appendFile: (...args: any[]) => mockAppendFile(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
  unlink: (...args: any[]) => mockUnlink(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
}));

vi.mock("node:crypto", () => ({
  default: {
    randomBytes: vi.fn(() => ({ toString: () => "aabbccdd11223344" })),
    createHash: vi.fn(() => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn(() => "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"),
    })),
  },
  randomBytes: vi.fn(() => ({ toString: () => "aabbccdd11223344" })),
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"),
  })),
}));

import {
  initAudit,
  logAuditEvent,
  auditToolStart,
  auditToolSuccess,
  auditToolFailed,
  auditToolDenied,
  isAuditEnabled,
  getAuditDir,
  readAuditLogs,
  cleanupOldAuditLogs,
} from "../audit";

describe("audit module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initAudit({ deviceId: "test-device", auditDir: "/tmp/test-audit", enabled: true });
  });

  // ── initAudit & config ──────────────────────────────────────

  it("initializes with given deviceId and auditDir", () => {
    expect(isAuditEnabled()).toBe(true);
    expect(getAuditDir()).toBe("/tmp/test-audit");
  });

  it("disables audit when enabled=false", () => {
    initAudit({ deviceId: "d1", enabled: false });
    expect(isAuditEnabled()).toBe(false);
  });

  it("uses default auditDir when not specified", () => {
    initAudit({ deviceId: "d2" });
    expect(getAuditDir()).toContain(".openslin");
    expect(getAuditDir()).toContain("audit");
  });

  // ── logAuditEvent ───────────────────────────────────────────

  it("writes a JSON line to the audit log file", async () => {
    const eventId = await logAuditEvent({ eventType: "tool.execute.start", toolRef: "device.test.echo", toolName: "echo" });

    expect(eventId).toBeTypeOf("string");
    expect(eventId.length).toBeGreaterThan(0);
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/test-audit", { recursive: true });
    expect(mockAppendFile).toHaveBeenCalledTimes(1);

    const written = mockAppendFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.eventType).toBe("tool.execute.start");
    expect(parsed.deviceId).toBe("test-device");
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.eventId).toBeDefined();
  });

  it("does not write when audit is disabled", async () => {
    initAudit({ deviceId: "d1", auditDir: "/tmp/test-audit", enabled: false });
    await logAuditEvent({ eventType: "session.start" });
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it("does not throw when write fails", async () => {
    mockAppendFile.mockRejectedValueOnce(new Error("disk full"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(logAuditEvent({ eventType: "session.end" })).resolves.toBeTypeOf("string");

    stderrSpy.mockRestore();
  });

  // ── convenience methods ─────────────────────────────────────

  it("auditToolStart writes tool.execute.start event", async () => {
    await auditToolStart({
      toolRef: "device.test.echo",
      toolName: "echo",
      executionId: "exec-1",
      callerId: "caller-1",
      inputDigest: { keyCount: 2 },
    });

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse((mockAppendFile.mock.calls[0][1] as string).trim());
    expect(parsed.eventType).toBe("tool.execute.start");
    expect(parsed.callerId).toBe("caller-1");
  });

  it("auditToolSuccess writes success event with durationMs", async () => {
    await auditToolSuccess({
      toolRef: "device.test.echo",
      toolName: "echo",
      executionId: "exec-2",
      durationMs: 150,
      outputDigest: { result: "ok" },
    });

    const parsed = JSON.parse((mockAppendFile.mock.calls[0][1] as string).trim());
    expect(parsed.eventType).toBe("tool.execute.success");
    expect(parsed.status).toBe("success");
    expect(parsed.durationMs).toBe(150);
  });

  it("auditToolFailed writes failed event with errorCategory", async () => {
    await auditToolFailed({
      toolRef: "device.test.fail",
      toolName: "fail",
      executionId: "exec-3",
      durationMs: 50,
      errorCategory: "timeout",
    });

    const parsed = JSON.parse((mockAppendFile.mock.calls[0][1] as string).trim());
    expect(parsed.eventType).toBe("tool.execute.failed");
    expect(parsed.errorCategory).toBe("timeout");
  });

  it("auditToolDenied writes denied event with reason", async () => {
    await auditToolDenied({
      toolRef: "device.test.secret",
      toolName: "secret",
      executionId: "exec-4",
      reason: "access_denied",
    });

    const parsed = JSON.parse((mockAppendFile.mock.calls[0][1] as string).trim());
    expect(parsed.eventType).toBe("tool.execute.denied");
    expect(parsed.status).toBe("denied");
    expect(parsed.errorCategory).toBe("access_denied");
  });

  // ── readAuditLogs ───────────────────────────────────────────

  it("reads and parses JSONL audit log for a date", async () => {
    const line1 = JSON.stringify({ eventId: "e1", eventType: "session.start", timestamp: "2026-04-19T00:00:00Z", deviceId: "d1" });
    const line2 = JSON.stringify({ eventId: "e2", eventType: "session.end", timestamp: "2026-04-19T01:00:00Z", deviceId: "d1" });
    mockReadFile.mockResolvedValueOnce(`${line1}\n${line2}\n`);

    const events = await readAuditLogs("2026-04-19");
    expect(events).toHaveLength(2);
    expect(events[0].eventId).toBe("e1");
    expect(events[1].eventType).toBe("session.end");
  });

  it("returns empty array when log file does not exist", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
    const events = await readAuditLogs("2099-01-01");
    expect(events).toEqual([]);
  });

  it("skips malformed JSON lines", async () => {
    mockReadFile.mockResolvedValueOnce(`{"eventId":"e1","eventType":"session.start","timestamp":"t","deviceId":"d"}\n{broken}\n`);
    const events = await readAuditLogs("2026-04-19");
    expect(events).toHaveLength(1);
  });

  // ── cleanupOldAuditLogs ─────────────────────────────────────

  it("deletes audit files older than retention days", async () => {
    mockReaddir.mockResolvedValueOnce(["audit-2020-01-01.jsonl", "audit-2026-04-19.jsonl"]);
    const cleaned = await cleanupOldAuditLogs(30);
    expect(cleaned).toBe(1);
    expect(mockUnlink).toHaveBeenCalledTimes(1);
    expect(mockUnlink.mock.calls[0][0]).toContain("2020-01-01");
  });

  it("returns 0 when no files to clean", async () => {
    mockReaddir.mockResolvedValueOnce([]);
    const cleaned = await cleanupOldAuditLogs(30);
    expect(cleaned).toBe(0);
  });

  it("ignores non-audit files", async () => {
    mockReaddir.mockResolvedValueOnce(["readme.txt", "audit-invalid.jsonl", "audit-2020-01-01.jsonl"]);
    const cleaned = await cleanupOldAuditLogs(30);
    expect(cleaned).toBe(1); // only the valid old audit file
  });
});
