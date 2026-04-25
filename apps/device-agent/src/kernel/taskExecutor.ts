/**
 * Device-OS 内核模块 #4：任务执行引擎
 *
 * 统一任务状态机：pending → claimed → running → succeeded → failed → canceled → timed_out
 * 统一主链路：registerCapability → policyCheck → claim → execute → result → audit/evidence → replay
 *
 * 任务队列逻辑已统一到 ExecutionSession（session.ts），
 * 本文件仅保留 executeDeviceTool 业务逻辑。
 *
 * @layer kernel
 */
import type { ToolExecutionContext, ToolExecutionResult, DeviceClaimEnvelope } from "./types";
import { toolName } from "./types";
import { findPluginForTool, getToolRiskLevel, registerPlugin } from "./capabilityRegistry";
import { isCallerAllowed, isToolAllowed, getOrCreateContext, extractCallerFromRequest } from "./auth";
import { resolveToolAlias } from "./capabilityRegistry";
import { isToolFeatureEnabled, getDegradationRule, recordToolSuccess, recordToolFailure } from "./toolFeatureFlags";
import { auditToolStart, auditToolSuccess, auditToolFailed, auditToolDenied } from "./audit";
import { sha256_8, safeError, safeLog } from "../log";
import builtinToolPlugin from "../plugins/builtinToolPlugin";
import { getDefaultExecutionSession } from "./session";

// ══════════════════════════════════════════════════════════════
// 第二部分：设备工具执行（纯调度器 — 业务逻辑保留在此）
// ══════════════════════════════════════════════════════════════

function isPlainObject(v: any): boolean { return v && typeof v === "object" && !Array.isArray(v); }

function ensureBuiltinToolPlugin(toolName: string): void {
  if (toolName !== "noop" && toolName !== "echo") return;
  if (findPluginForTool(toolName)) return;
  try {
    registerPlugin(builtinToolPlugin);
  } catch (err: any) {
    if (!String(err?.message ?? "").startsWith("plugin_already_registered:")) throw err;
  }
}

export async function executeDeviceTool(params: { cfg: { apiBase: string; deviceToken: string }; claim: DeviceClaimEnvelope; confirmFn: (q: string) => Promise<boolean> }): Promise<ToolExecutionResult> {
  const exec = params.claim.execution;
  const name = resolveToolAlias(toolName(exec.toolRef));
  const input = isPlainObject(exec.input) ? exec.input : {};
  const policy = params.claim.policy ?? null;
  const executionId = exec.deviceExecutionId;
  const startTime = Date.now();

  const inputDigest = { keyCount: Object.keys(input).length, keys: Object.keys(input).slice(0, 20) };
  const policyDigest = policy ? { allowedToolsCount: Array.isArray(policy.allowedTools) ? policy.allowedTools.length : 0 } : null;

  const caller = extractCallerFromRequest({ deviceToken: params.cfg.deviceToken });
  const isClaimedByTrustedDevice = Boolean(params.cfg.deviceToken);
  if (!caller && !isClaimedByTrustedDevice) {
    await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "caller_unverified" });
    return { status: "failed", errorCategory: "access_denied", outputDigest: { reason: "caller_unverified" } };
  }
  const callerId = caller?.callerId ?? `device:${sha256_8(params.cfg.deviceToken).padEnd(8, "0")}`;

  if (!isClaimedByTrustedDevice) {
    if (!isCallerAllowed(callerId)) { await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "caller_not_allowed" }); return { status: "failed", errorCategory: "access_denied" }; }
    if (!isToolAllowed(callerId, name)) { await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "tool_not_allowed_for_caller" }); return { status: "failed", errorCategory: "access_denied" }; }
  }

  getOrCreateContext(callerId, policy?.allowedTools);
  const allowedTools = Array.isArray(policy?.allowedTools) ? policy.allowedTools.map((x: any) => resolveToolAlias(String(x))) : [];
  if (allowedTools.length > 0 && !allowedTools.includes(name)) {
    await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "tool_not_allowed" });
    return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "tool_not_allowed", tool: name } };
  }

  // 灰度开关 + 熔断器检查
  const featureCheck = isToolFeatureEnabled(name);
  if (!featureCheck.enabled) {
    const degradation = getDegradationRule(name);
    await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: featureCheck.reason ?? "feature_disabled" });
    return { status: "failed", errorCategory: degradation?.errorCategory ?? "feature_disabled", outputDigest: { reason: featureCheck.reason, tool: name } };
  }

  const requireUserPresence = Boolean(params.claim.requireUserPresence);
  if (requireUserPresence) {
    const ok = await params.confirmFn(`执行 ${name}？`);
    if (!ok) { await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "user_denied" }); return { status: "failed", errorCategory: "user_denied" }; }
    const confirmMode = String(policy?.uiPolicy?.confirmationMode ?? "").trim().toLowerCase();
    if (confirmMode === "double") {
      const code = sha256_8(String(exec.deviceExecutionId ?? ""));
      const ok2 = await params.confirmFn(`确认码 ${code}：再次确认执行 ${name}？`);
      if (!ok2) { await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "user_denied_double_confirm" }); return { status: "failed", errorCategory: "user_denied" }; }
    }
  }

  // noop/echo 等内置工具统一通过 builtinToolPlugin 注册，由插件注册表分发
  ensureBuiltinToolPlugin(name);
  const plugin = findPluginForTool(name);
  if (plugin) {
    await auditToolStart({ toolRef: exec.toolRef, toolName: name, executionId, inputDigest, policyDigest: policyDigest ?? undefined });
    const ctx: ToolExecutionContext = { cfg: params.cfg, execution: exec, toolName: name, input, policy, requireUserPresence, confirmFn: params.confirmFn };
    try {
      const result = await plugin.execute(ctx);
      const durationMs = Date.now() - startTime;
      if (result.status === "succeeded") { recordToolSuccess(name); await auditToolSuccess({ toolRef: exec.toolRef, toolName: name, executionId, durationMs, outputDigest: result.outputDigest }); }
      else { recordToolFailure(name); await auditToolFailed({ toolRef: exec.toolRef, toolName: name, executionId, durationMs, errorCategory: result.errorCategory ?? "unknown", outputDigest: result.outputDigest }); }
      return result;
    } catch (err: any) {
      recordToolFailure(name);
      const durationMs = Date.now() - startTime;
      await auditToolFailed({ toolRef: exec.toolRef, toolName: name, executionId, durationMs, errorCategory: "plugin_exception", outputDigest: { error: String(err?.message ?? "unknown").slice(0, 200) } });
      return { status: "failed", errorCategory: "plugin_exception", outputDigest: { error: String(err?.message ?? "unknown") } };
    }
  }

  await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "unsupported_tool" });
  return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolRef: exec.toolRef } };
}
