/**
 * Device-OS 内核模块 #6：审计、证据与回放
 *
 * 统一审计事件格式，支持：
 * - evidence ref（artifactId、storageRef、hash）
 * - replay trace（parentEventId、traceChain）
 * - 插件禁止自定义审计格式
 * - artifact 上传接口定义
 *
 * @layer kernel
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { AuditEvent, AuditEventType, EvidenceRef } from "./types";

// ── 配置 ─────────────────────────────────────────────────────

let _auditDir: string | null = null;
let _deviceId: string = "unknown";
let _enabled: boolean = true;

export function initAudit(params: { deviceId: string; auditDir?: string; enabled?: boolean }): void {
  _deviceId = params.deviceId;
  _auditDir = params.auditDir ?? path.join(os.homedir(), ".mindpal", "audit");
  _enabled = params.enabled ?? true;
}

export function getAuditDir(): string { return _auditDir ?? path.join(os.homedir(), ".mindpal", "audit"); }
export function isAuditEnabled(): boolean { return _enabled; }

function generateEventId(): string { return crypto.randomBytes(12).toString("hex"); }
function getLogFilePath(): string { const date = new Date().toISOString().slice(0, 10); return path.join(getAuditDir(), `audit-${date}.jsonl`); }

async function writeAuditLog(event: AuditEvent): Promise<void> {
  if (!_enabled) return;
  const dir = getAuditDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(getLogFilePath(), JSON.stringify(event) + "\n", "utf8");
}

export async function logAuditEvent(params: Omit<AuditEvent, "eventId" | "timestamp" | "deviceId">): Promise<string> {
  const eventId = generateEventId();
  const event: AuditEvent = { eventId, timestamp: new Date().toISOString(), deviceId: _deviceId, ...params };
  try { await writeAuditLog(event); } catch (e: any) { process.stderr.write(`[audit] write_failed: ${e?.message ?? "unknown"}\n`); }
  return eventId;
}

// ── 便捷方法 ─────────────────────────────────────────────────

export async function auditToolStart(params: { toolRef: string; toolName: string; executionId: string; callerId?: string; inputDigest?: Record<string, unknown>; policyDigest?: Record<string, unknown> }): Promise<string> {
  return logAuditEvent({ eventType: "tool.execute.start", toolRef: params.toolRef, toolName: params.toolName, executionId: params.executionId, callerId: params.callerId, inputDigest: params.inputDigest, policyDigest: params.policyDigest });
}

export async function auditToolSuccess(params: { toolRef: string; toolName: string; executionId: string; durationMs: number; outputDigest?: Record<string, unknown>; evidenceRefs?: EvidenceRef[] }): Promise<string> {
  return logAuditEvent({ eventType: "tool.execute.success", toolRef: params.toolRef, toolName: params.toolName, executionId: params.executionId, status: "success", durationMs: params.durationMs, outputDigest: params.outputDigest, evidenceRefs: params.evidenceRefs });
}

export async function auditToolFailed(params: { toolRef: string; toolName: string; executionId: string; durationMs: number; errorCategory: string; outputDigest?: Record<string, unknown> }): Promise<string> {
  return logAuditEvent({ eventType: "tool.execute.failed", toolRef: params.toolRef, toolName: params.toolName, executionId: params.executionId, status: "failed", durationMs: params.durationMs, errorCategory: params.errorCategory, outputDigest: params.outputDigest });
}

export async function auditToolDenied(params: { toolRef: string; toolName: string; executionId: string; reason: string }): Promise<string> {
  return logAuditEvent({ eventType: "tool.execute.denied", toolRef: params.toolRef, toolName: params.toolName, executionId: params.executionId, status: "denied", errorCategory: params.reason });
}

// ── 日志清理与查询 ───────────────────────────────────────────

export async function cleanupOldAuditLogs(retentionDays: number = 30): Promise<number> {
  const dir = getAuditDir();
  let cleaned = 0;
  try {
    const files = await fs.readdir(dir);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.startsWith("audit-") || !file.endsWith(".jsonl")) continue;
      const match = file.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      if (new Date(match[1]).getTime() < cutoff) { await fs.unlink(path.join(dir, file)); cleaned++; }
    }
  } catch {}
  return cleaned;
}

export async function readAuditLogs(date: string): Promise<AuditEvent[]> {
  const logPath = path.join(getAuditDir(), `audit-${date}.jsonl`);
  const events: AuditEvent[] = [];
  try {
    const content = await fs.readFile(logPath, "utf8");
    for (const line of content.split("\n")) { if (line.trim()) try { events.push(JSON.parse(line)); } catch {} }
  } catch {}
  return events;
}

// ── Artifact 上传接口定义 ────────────────────────────────────

export interface ArtifactUploadParams {
  executionId: string;
  mimeType: string;
  data: Buffer | string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactUploadResult {
  artifactId: string;
  storageRef: string;
  hash: string;
  sizeBytes: number;
}

/**
 * 上传审计证据（artifact）。
 * 默认实现将文件写入本地审计目录。
 * 生产环境可替换为云存储实现。
 */
export async function uploadArtifact(params: ArtifactUploadParams): Promise<ArtifactUploadResult> {
  const hash = crypto.createHash("sha256").update(params.data).digest("hex");
  const artifactId = `artifact_${hash.slice(0, 16)}_${Date.now()}`;
  const storageRef = `file://${path.join(getAuditDir(), "artifacts", artifactId)}`;
  const data = typeof params.data === "string" ? Buffer.from(params.data) : params.data;

  await fs.mkdir(path.join(getAuditDir(), "artifacts"), { recursive: true });
  await fs.writeFile(path.join(getAuditDir(), "artifacts", artifactId), data);

  await logAuditEvent({
    eventType: "evidence.upload",
    executionId: params.executionId,
    status: "success",
    extra: { artifactId, storageRef, hash, mimeType: params.mimeType, sizeBytes: data.length, metadata: params.metadata },
  });

  return { artifactId, storageRef, hash, sizeBytes: data.length };
}

/** 记录回放 trace 事件 */
export async function recordReplayTrace(params: {
  parentEventId: string;
  executionId: string;
  traceChain: string[];
  toolRef: string;
}): Promise<string> {
  return logAuditEvent({
    eventType: "replay.trace",
    toolRef: params.toolRef,
    executionId: params.executionId,
    parentEventId: params.parentEventId,
    traceChain: params.traceChain,
    status: "success",
  });
}
