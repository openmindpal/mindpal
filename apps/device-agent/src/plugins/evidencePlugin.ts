/**
 * 证据上传子插件 — 处理 device.evidence.upload
 */
import { apiPostJson } from "../api";
import type { CapabilityDescriptor } from "../kernel";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "../pluginRegistry";

// ── 工具实现 ──────────────────────────────────────────────────────

async function execEvidenceUpload(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const contentBase64 = String(ctx.input.contentBase64 ?? "");
  const contentType = String(ctx.input.contentType ?? "");
  if (!contentBase64 || !contentType) return { status: "failed", errorCategory: "input_invalid", outputDigest: { ok: false } };
  const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
    apiBase: ctx.cfg.apiBase,
    path: "/device-agent/evidence/upload",
    token: ctx.cfg.deviceToken,
    body: { deviceExecutionId: ctx.execution.deviceExecutionId, contentBase64, contentType, format: String(ctx.input.format ?? "base64") },
  });
  if (up.status !== 200) return { status: "failed", errorCategory: "upstream_error", outputDigest: { status: up.status } };
  return { status: "succeeded", outputDigest: { artifactId: up.json?.artifactId ?? null }, evidenceRefs: up.json?.evidenceRef ? [up.json.evidenceRef] : [] };
}

// ── 路由表 ────────────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.evidence.upload": execEvidenceUpload,
};

// ── 能力声明 ──────────────────────────────────────────────────────

const stringArraySchema = { type: "array", items: { type: "string" } };

const EVIDENCE_CAPABILITIES: CapabilityDescriptor[] = [
  {
    toolRef: "device.evidence.upload",
    riskLevel: "high",
    inputSchema: { type: "object", properties: { contentBase64: { type: "string" }, contentType: { type: "string" }, format: { type: "string" } }, required: ["contentBase64", "contentType"], additionalProperties: true },
    outputSchema: { type: "object", properties: { artifactId: { type: "string" }, evidenceRefs: stringArraySchema }, additionalProperties: true },
    resourceRequirements: { memoryMb: 128, networkRequired: true },
    concurrencyLimit: 2,
    version: "1.0.0",
    tags: ["desktop", "evidence"],
    description: "上传端侧证据产物",
  },
];

// ── 导出插件实例 ──────────────────────────────────────────────────

const evidencePlugin: DeviceToolPlugin = {
  name: "evidence",
  version: "1.0.0",
  toolPrefixes: ["device.evidence"],
  capabilities: EVIDENCE_CAPABILITIES,
  resourceLimits: { maxMemoryMb: 128, maxCpuPercent: 20, maxConcurrency: 2, maxExecutionTimeMs: 30000 },
  toolNames: Object.keys(TOOL_HANDLERS),
  async execute(ctx) {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "evidence" } };
    return handler(ctx);
  },
};

export default evidencePlugin;
