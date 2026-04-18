/**
 * 文件操作子插件 — 处理 device.file.list / device.file.read / device.file.write
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CapabilityDescriptor } from "../kernel";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "../pluginRegistry";
import { sha256_8, normalizeRoots, isWithinRoots } from "./pluginUtils";

// ── 工具实现 ──────────────────────────────────────────────────────

async function execFileList(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const fp = String(ctx.input.path ?? "");
  if (!fp) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "path" } };
  const filePolicy = ctx.policy?.filePolicy ?? null;
  const allowRead = Boolean(filePolicy?.allowRead);
  const roots = normalizeRoots(filePolicy?.allowedRoots);
  if (!allowRead || !roots.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "file_read_denied" } };
  if (!isWithinRoots(fp, roots)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "path_not_allowed", pathSha256_8: sha256_8(fp) } };
  const dir = await fs.opendir(fp);
  const items: any[] = [];
  for await (const ent of dir) {
    items.push({ name: ent.name, kind: ent.isDirectory() ? "dir" : ent.isFile() ? "file" : "other" });
    if (items.length >= 200) break;
  }
  await dir.close();
  return { status: "succeeded", outputDigest: { pathSha256_8: sha256_8(fp), count: items.length, items } };
}

async function execFileRead(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const fp = String(ctx.input.path ?? "");
  if (!fp) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "path" } };
  const filePolicy = ctx.policy?.filePolicy ?? null;
  const allowRead = Boolean(filePolicy?.allowRead);
  const roots = normalizeRoots(filePolicy?.allowedRoots);
  const maxBytes = Math.max(1, Number(filePolicy?.maxBytesPerRead ?? 65536) || 65536);
  if (!allowRead || !roots.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "file_read_denied" } };
  if (!isWithinRoots(fp, roots)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "path_not_allowed", pathSha256_8: sha256_8(fp) } };
  const buf = await fs.readFile(fp);
  const clipped = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const digest = crypto.createHash("sha256").update(clipped).digest("hex").slice(0, 8);
  const fullDigest = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
  return { status: "succeeded", outputDigest: { pathSha256_8: sha256_8(fp), byteSize: buf.byteLength, sha256_8: fullDigest, sha256_8_prefix: digest, truncated: buf.byteLength > maxBytes } };
}

async function execFileWrite(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const fp = String(ctx.input.path ?? "");
  const contentBase64 = String(ctx.input.contentBase64 ?? "");
  if (!fp) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "path" } };
  if (!contentBase64) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "contentBase64" } };
  const filePolicy = ctx.policy?.filePolicy ?? null;
  const allowWrite = Boolean(filePolicy?.allowWrite);
  const roots = normalizeRoots(filePolicy?.allowedRoots);
  const maxBytes = Math.max(1, Number(filePolicy?.maxBytesPerWrite ?? 65536) || 65536);
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  if (!allowWrite || !roots.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "file_write_denied" } };
  if (!isWithinRoots(fp, roots)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "path_not_allowed", pathSha256_8: sha256_8(fp) } };
  const buf = Buffer.from(contentBase64, "base64");
  if (buf.byteLength > maxBytes) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "max_bytes_exceeded", byteSize: buf.byteLength, maxBytes } };
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, buf);
  return { status: "succeeded", outputDigest: { pathSha256_8: sha256_8(fp), byteSize: buf.byteLength } };
}

// ── 路由表 ────────────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.file.list": execFileList,
  "device.file.read": execFileRead,
  "device.file.write": execFileWrite,
};

// ── 能力声明 ──────────────────────────────────────────────────────

const successOutputSchema = {
  type: "object",
  properties: { success: { type: "boolean" } },
  additionalProperties: true,
};

const stringArraySchema = { type: "array", items: { type: "string" } };

const FILE_CAPABILITIES: CapabilityDescriptor[] = [
  {
    toolRef: "device.file.list",
    riskLevel: "low",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: true },
    outputSchema: { type: "object", properties: { entries: stringArraySchema }, additionalProperties: true },
    resourceRequirements: { memoryMb: 64, diskMb: 16 },
    concurrencyLimit: 8,
    version: "1.0.0",
    tags: ["desktop", "file"],
    description: "列出允许目录内文件",
  },
  {
    toolRef: "device.file.read",
    riskLevel: "medium",
    inputSchema: { type: "object", properties: { path: { type: "string" }, encoding: { type: "string" } }, additionalProperties: true },
    outputSchema: { type: "object", properties: { content: { type: "string" } }, additionalProperties: true },
    resourceRequirements: { memoryMb: 96, diskMb: 32 },
    concurrencyLimit: 4,
    version: "1.0.0",
    tags: ["desktop", "file"],
    description: "读取允许目录内文件",
  },
  {
    toolRef: "device.file.write",
    riskLevel: "high",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: true },
    outputSchema: successOutputSchema,
    resourceRequirements: { memoryMb: 128, diskMb: 64 },
    concurrencyLimit: 2,
    version: "1.0.0",
    tags: ["desktop", "file"],
    description: "写入允许目录内文件",
  },
];

// ── 导出插件实例 ──────────────────────────────────────────────────

const filePlugin: DeviceToolPlugin = {
  name: "file",
  version: "1.0.0",
  toolPrefixes: ["device.file"],
  capabilities: FILE_CAPABILITIES,
  resourceLimits: {
    maxMemoryMb: 128,
    maxCpuPercent: 30,
    maxConcurrency: 8,
    maxExecutionTimeMs: 30000,
  },
  toolNames: Object.keys(TOOL_HANDLERS),
  async execute(ctx) {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) {
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "file" } };
    }
    return handler(ctx);
  },
};

export default filePlugin;
