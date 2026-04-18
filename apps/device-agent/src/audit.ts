/**
 * Device-Agent 审计日志模块
 *
 * 记录所有工具执行的审计日志，支持本地持久化。
 * 日志格式为 JSON Lines，便于后续分析和上报。
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ── 类型定义 ──────────────────────────────────────────────────────

export type AuditEventType =
  | "tool.execute.start"
  | "tool.execute.success"
  | "tool.execute.failed"
  | "tool.execute.denied"
  | "auth.verify"
  | "policy.check"
  | "session.start"
  | "session.end";

export type AuditEvent = {
  eventId: string;
  timestamp: string;
  eventType: AuditEventType;
  deviceId: string;
  toolRef?: string;
  toolName?: string;
  executionId?: string;
  callerId?: string;         // 调用方标识（用于追溯）
  status?: "success" | "failed" | "denied";
  errorCategory?: string;
  durationMs?: number;
  inputDigest?: Record<string, unknown>;  // 输入摘要（不含敏感数据）
  outputDigest?: Record<string, unknown>; // 输出摘要
  policyDigest?: Record<string, unknown>; // 策略摘要
  extra?: Record<string, unknown>;
};

// ── 配置 ──────────────────────────────────────────────────────────

let _auditDir: string | null = null;
let _deviceId: string = "unknown";
let _enabled: boolean = true;

/** 初始化审计日志模块 */
export function initAudit(params: { deviceId: string; auditDir?: string; enabled?: boolean }): void {
  _deviceId = params.deviceId;
  _auditDir = params.auditDir ?? path.join(os.homedir(), ".openslin", "audit");
  _enabled = params.enabled ?? true;
}

/** 获取当前审计日志目录 */
export function getAuditDir(): string {
  return _auditDir ?? path.join(os.homedir(), ".openslin", "audit");
}

/** 检查审计日志是否启用 */
export function isAuditEnabled(): boolean {
  return _enabled;
}

// ── 核心函数 ──────────────────────────────────────────────────────

/** 生成唯一事件 ID */
function generateEventId(): string {
  return crypto.randomBytes(12).toString("hex");
}

/** 获取当前日志文件路径（按日期分片） */
function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(getAuditDir(), `audit-${date}.jsonl`);
}

/** 写入审计日志（追加模式） */
async function writeAuditLog(event: AuditEvent): Promise<void> {
  if (!_enabled) return;

  const dir = getAuditDir();
  await fs.mkdir(dir, { recursive: true });

  const logPath = getLogFilePath();
  const line = JSON.stringify(event) + "\n";
  await fs.appendFile(logPath, line, "utf8");
}

/** 记录审计事件（主入口） */
export async function logAuditEvent(params: Omit<AuditEvent, "eventId" | "timestamp" | "deviceId">): Promise<string> {
  const eventId = generateEventId();
  const event: AuditEvent = {
    eventId,
    timestamp: new Date().toISOString(),
    deviceId: _deviceId,
    ...params,
  };

  try {
    await writeAuditLog(event);
  } catch (e: any) {
    // 审计失败不应阻塞主流程，仅输出警告
    process.stderr.write(`[audit] write_failed: ${e?.message ?? "unknown"}\n`);
  }

  return eventId;
}

// ── 便捷方法 ──────────────────────────────────────────────────────

/** 记录工具执行开始 */
export async function auditToolStart(params: {
  toolRef: string;
  toolName: string;
  executionId: string;
  callerId?: string;
  inputDigest?: Record<string, unknown>;
  policyDigest?: Record<string, unknown>;
}): Promise<string> {
  return logAuditEvent({
    eventType: "tool.execute.start",
    toolRef: params.toolRef,
    toolName: params.toolName,
    executionId: params.executionId,
    callerId: params.callerId,
    inputDigest: params.inputDigest,
    policyDigest: params.policyDigest,
  });
}

/** 记录工具执行成功 */
export async function auditToolSuccess(params: {
  toolRef: string;
  toolName: string;
  executionId: string;
  durationMs: number;
  outputDigest?: Record<string, unknown>;
}): Promise<string> {
  return logAuditEvent({
    eventType: "tool.execute.success",
    toolRef: params.toolRef,
    toolName: params.toolName,
    executionId: params.executionId,
    status: "success",
    durationMs: params.durationMs,
    outputDigest: params.outputDigest,
  });
}

/** 记录工具执行失败 */
export async function auditToolFailed(params: {
  toolRef: string;
  toolName: string;
  executionId: string;
  durationMs: number;
  errorCategory: string;
  outputDigest?: Record<string, unknown>;
}): Promise<string> {
  return logAuditEvent({
    eventType: "tool.execute.failed",
    toolRef: params.toolRef,
    toolName: params.toolName,
    executionId: params.executionId,
    status: "failed",
    durationMs: params.durationMs,
    errorCategory: params.errorCategory,
    outputDigest: params.outputDigest,
  });
}

/** 记录工具执行被拒绝 */
export async function auditToolDenied(params: {
  toolRef: string;
  toolName: string;
  executionId: string;
  reason: string;
}): Promise<string> {
  return logAuditEvent({
    eventType: "tool.execute.denied",
    toolRef: params.toolRef,
    toolName: params.toolName,
    executionId: params.executionId,
    status: "denied",
    errorCategory: params.reason,
  });
}

// ── 日志清理 ──────────────────────────────────────────────────────

/** 清理过期的审计日志（保留指定天数） */
export async function cleanupOldAuditLogs(retentionDays: number = 30): Promise<number> {
  const dir = getAuditDir();
  let cleaned = 0;

  try {
    const files = await fs.readdir(dir);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith("audit-") || !file.endsWith(".jsonl")) continue;

      // 解析文件名中的日期
      const match = file.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;

      const fileDate = new Date(match[1]).getTime();
      if (fileDate < cutoff) {
        await fs.unlink(path.join(dir, file));
        cleaned++;
      }
    }
  } catch {
    // 清理失败不阻塞
  }

  return cleaned;
}

// ── 日志查询（本地） ──────────────────────────────────────────────

/** 读取指定日期的审计日志 */
export async function readAuditLogs(date: string): Promise<AuditEvent[]> {
  const logPath = path.join(getAuditDir(), `audit-${date}.jsonl`);
  const events: AuditEvent[] = [];

  try {
    const content = await fs.readFile(logPath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // 忽略解析失败的行
      }
    }
  } catch {
    // 文件不存在或读取失败
  }

  return events;
}
