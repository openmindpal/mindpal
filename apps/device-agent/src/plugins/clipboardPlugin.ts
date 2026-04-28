/**
 * 剪贴板子插件 — 处理 device.clipboard.read / device.clipboard.write
 */
import childProcess from "node:child_process";
import type { CapabilityDescriptor } from "@openslin/device-agent-sdk";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "@openslin/device-agent-sdk";
import { sha256_8, runPowerShell, runPowerShellJson } from "./pluginUtils";

// ── 工具实现 ──────────────────────────────────────────────────────

async function execClipboardRead(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  const clipPolicy = ctx.policy?.clipboardPolicy ?? null;
  if (!clipPolicy?.allowRead) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "clipboard_read_denied" } };
  let text = "";
  let hasImage = false;
  let formats: string[] = [];
  try {
    if (process.platform === "win32") {
      const result = await runPowerShellJson<{ text?: string; hasImage?: boolean; formats?: string[] }>([
        "Add-Type -AssemblyName System.Windows.Forms",
        "$text = if ([System.Windows.Forms.Clipboard]::ContainsText()) { [System.Windows.Forms.Clipboard]::GetText() } else { '' }",
        "$hasImage = [System.Windows.Forms.Clipboard]::ContainsImage()",
        "$formats = @()",
        "if ([System.Windows.Forms.Clipboard]::ContainsText()) { $formats += 'text/plain' }",
        "if ($hasImage) { $formats += 'image/png' }",
        "@{ text = $text; hasImage = $hasImage; formats = $formats } | ConvertTo-Json -Compress",
      ].join("; "), { sta: true });
      text = String(result?.text ?? "");
      hasImage = Boolean(result?.hasImage);
      formats = Array.isArray(result?.formats) ? result.formats.map(String) : [];
    } else if (process.platform === "darwin") {
      text = await new Promise<string>((resolve, reject) => {
        const p = childProcess.spawn("pbpaste", [], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`clipboard_read_exit_${code}`)));
      });
      formats = text ? ["text/plain"] : [];
    } else {
      text = await new Promise<string>((resolve, reject) => {
        const p = childProcess.spawn("xclip", ["-selection", "clipboard", "-o"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`clipboard_read_exit_${code}`)));
      });
      formats = text ? ["text/plain"] : [];
    }
  } catch {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "clipboard_read_failed" } };
  }
  const maxLen = Math.max(1, Number(clipPolicy?.maxTextLength ?? 4096) || 4096);
  const truncated = text.length > maxLen;
  const content = truncated ? text.slice(0, maxLen) : text;
  return { status: "succeeded", outputDigest: { success: true, text: content, hasImage, formats, textSha256_8: sha256_8(content), length: content.length, truncated } };
}

async function execClipboardWrite(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  const clipPolicy = ctx.policy?.clipboardPolicy ?? null;
  if (!clipPolicy?.allowWrite) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "clipboard_write_denied" } };
  const text = String(ctx.input.text ?? "");
  const imageBase64 = String(ctx.input.imageBase64 ?? "");
  if (!text && !imageBase64) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "text_or_imageBase64" } };
  const maxLen = Math.max(1, Number(clipPolicy?.maxTextLength ?? 4096) || 4096);
  if (text && text.length > maxLen) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "text_too_long", length: text.length, maxLen } };
  try {
    if (process.platform === "win32" && imageBase64) {
      const payload = imageBase64.replace(/'/g, "''");
      await runPowerShell([
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        `$bytes = [Convert]::FromBase64String('${payload}')`,
        "$stream = New-Object System.IO.MemoryStream(,$bytes)",
        "$img = [System.Drawing.Image]::FromStream($stream)",
        "[System.Windows.Forms.Clipboard]::SetImage($img)",
        "$img.Dispose()",
        "$stream.Dispose()",
      ].join("; "), { sta: true });
    } else if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const p = childProcess.spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value \"${text.replace(/"/g, '`"')}\"`], { stdio: "ignore" });
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`clipboard_write_exit_${code}`)));
      });
    } else if (process.platform === "darwin") {
      if (imageBase64) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "clipboard_image_write_not_supported_on_platform" } };
      await new Promise<void>((resolve, reject) => {
        const p = childProcess.spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
        p.stdin!.end(text);
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`clipboard_write_exit_${code}`)));
      });
    } else {
      if (imageBase64) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "clipboard_image_write_not_supported_on_platform" } };
      await new Promise<void>((resolve, reject) => {
        const p = childProcess.spawn("xclip", ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] });
        p.stdin!.end(text);
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`clipboard_write_exit_${code}`)));
      });
    }
  } catch {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "clipboard_write_failed" } };
  }
  return { status: "succeeded", outputDigest: { ok: true, success: true, textSha256_8: text ? sha256_8(text) : null, length: text.length, wroteImage: Boolean(imageBase64) } };
}

// ── 路由表 ────────────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.clipboard.read": execClipboardRead,
  "device.clipboard.write": execClipboardWrite,
};

// ── 能力声明 ──────────────────────────────────────────────────────

const successOutputSchema = { type: "object", properties: { success: { type: "boolean" } }, additionalProperties: true };

const CLIPBOARD_CAPABILITIES: CapabilityDescriptor[] = [
  {
    toolRef: "device.clipboard.read",
    riskLevel: "medium",
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
    resourceRequirements: { memoryMb: 32 },
    concurrencyLimit: 8,
    version: "1.0.0",
    tags: ["desktop", "clipboard"],
    description: "读取本地剪贴板",
  },
  {
    toolRef: "device.clipboard.write",
    riskLevel: "high",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: true },
    outputSchema: successOutputSchema,
    resourceRequirements: { memoryMb: 32 },
    concurrencyLimit: 4,
    version: "1.0.0",
    tags: ["desktop", "clipboard"],
    description: "写入本地剪贴板",
  },
];

// ── 导出插件实例 ──────────────────────────────────────────────────

const clipboardPlugin: DeviceToolPlugin = {
  name: "clipboard",
  version: "1.0.0",
  toolPrefixes: ["device.clipboard"],
  capabilities: CLIPBOARD_CAPABILITIES,
  resourceLimits: { maxMemoryMb: 64, maxCpuPercent: 20, maxConcurrency: 8, maxExecutionTimeMs: 10000 },
  toolNames: Object.keys(TOOL_HANDLERS),
  async execute(ctx) {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "clipboard" } };
    return handler(ctx);
  },
};

export default clipboardPlugin;
