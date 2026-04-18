/**
 * Device-Agent Executor — 纯调度器
 *
 * 职责：策略检查 → 用户确认 → 查插件注册表分发 → 审计日志
 * 不硬编码任何具体设备工具，所有场景能力由插件提供。
 */
import { findPluginForTool, registerPlugin, type ToolExecutionContext, type ToolExecutionResult } from "./pluginRegistry";
import { resolveToolAlias } from "./kernel/capabilityRegistry";
import { isToolFeatureEnabled, getDegradationRule, recordToolSuccess, recordToolFailure } from "./kernel/toolFeatureFlags";
import { sha256_8 } from "./log";
import { auditToolStart, auditToolSuccess, auditToolFailed, auditToolDenied } from "./audit";
import { isCallerAllowed, isToolAllowed, getOrCreateContext, extractCallerFromRequest } from "./accessControl";
import { isPlainObject } from "@openslin/shared";
import builtinToolPlugin from "./plugins/builtinToolPlugin";

function toolName(toolRef: string) {
  const idx = toolRef.indexOf("@");
  return idx > 0 ? toolRef.slice(0, idx) : toolRef;
}

/**
 * 别名→标准名转换。
 * 委托给 kernel/capabilityRegistry 的动态别名注册表，不再硬编码任何映射规则。
 */
export function normalizeToolName(name: string): string {
  return resolveToolAlias(name);
}

function ensureBuiltinToolPlugin(toolName: string): void {
  if (toolName !== "noop" && toolName !== "echo") return;
  if (findPluginForTool(toolName)) return;
  try {
    registerPlugin(builtinToolPlugin);
  } catch (err: any) {
    if (!String(err?.message ?? "").startsWith("plugin_already_registered:")) throw err;
  }
}

export type DeviceClaimEnvelope = {
  execution: { deviceExecutionId: string; toolRef: string; input?: any };
  requireUserPresence?: boolean;
  policy?: any;
  policyDigest?: any;
};

export async function executeDeviceTool(params: {
  cfg: { apiBase: string; deviceToken: string };
  claim: DeviceClaimEnvelope;
  confirmFn: (q: string) => Promise<boolean>;
}): Promise<ToolExecutionResult> {
  const exec = params.claim.execution;
  const rawName = toolName(exec.toolRef);
  const name = normalizeToolName(rawName);
  const input = isPlainObject(exec.input) ? exec.input : {};
  const policy = params.claim.policy ?? null;
  const executionId = exec.deviceExecutionId;
  const startTime = Date.now();

  // 输入摘要（安全：仅记录键名和数量，不记录敏感值）
  const inputDigest = { keyCount: Object.keys(input).length, keys: Object.keys(input).slice(0, 20) };
  const policyDigest = policy ? { allowedToolsCount: Array.isArray(policy.allowedTools) ? policy.allowedTools.length : 0 } : null;

  // ── 调用方鉴权 ────────────────────────────────────────────────
  const caller = extractCallerFromRequest({ deviceToken: params.cfg.deviceToken });
  const isClaimedByTrustedDevice = Boolean(params.cfg.deviceToken);
  if (!caller && !isClaimedByTrustedDevice) {
    await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "caller_unverified" });
    return { status: "failed", errorCategory: "access_denied", outputDigest: { reason: "caller_unverified" } };
  }
  const callerId = caller?.callerId ?? `device:${sha256_8(params.cfg.deviceToken).padEnd(8, "0")}`;

  if (!isClaimedByTrustedDevice) {
    if (!isCallerAllowed(callerId)) {
      await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "caller_not_allowed" });
      return { status: "failed", errorCategory: "access_denied", outputDigest: { reason: "caller_not_allowed" } };
    }
    if (!isToolAllowed(callerId, name)) {
      await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "tool_not_allowed_for_caller" });
      return { status: "failed", errorCategory: "access_denied", outputDigest: { reason: "tool_not_allowed_for_caller" } };
    }
  }

  // 获取或创建执行上下文（用于状态隔离）
  const execContext = getOrCreateContext(callerId, policy?.allowedTools);

  // ── 策略检查：allowedTools ──────────────────────────────────────
  const allowedTools = Array.isArray(policy?.allowedTools) ? policy.allowedTools.map((x: any) => normalizeToolName(String(x))) : [];
  if (allowedTools.length > 0 && !allowedTools.includes(name)) {
    await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "tool_not_allowed" });
    return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "tool_not_allowed", tool: name } };
  }

  // ── 灰度开关 + 熔断器检查 ─────────────────────────────────────
  const featureCheck = isToolFeatureEnabled(name);
  if (!featureCheck.enabled) {
    const degradation = getDegradationRule(name);
    await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: featureCheck.reason ?? "feature_disabled" });
    return { status: "failed", errorCategory: degradation?.errorCategory ?? "feature_disabled", outputDigest: { reason: featureCheck.reason, tool: name, degradation: degradation?.message } };
  }

  // ── 用户确认 ────────────────────────────────────────────────────
  const requireUserPresence = Boolean(params.claim.requireUserPresence);
  if (requireUserPresence) {
    const ok = await params.confirmFn(`执行 ${name}？`);
    if (!ok) {
      await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "user_denied" });
      return { status: "failed", errorCategory: "user_denied", outputDigest: { ok: false } };
    }
    const confirmMode = String(policy?.uiPolicy?.confirmationMode ?? "").trim().toLowerCase();
    const strict = confirmMode === "double" || Boolean(policy?.uiPolicy?.strictConfirm);
    if (strict) {
      const code = sha256_8(String(exec.deviceExecutionId ?? ""));
      const ok2 = await params.confirmFn(`确认码 ${code}：再次确认执行 ${name}？`);
      if (!ok2) {
        await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "user_denied_double_confirm" });
        return { status: "failed", errorCategory: "user_denied", outputDigest: { ok: false, step: "confirm2", code } };
      }
    }
  }

  // ── 查找插件并委托执行（含 noop/echo 等内置工具，均通过插件注册表分发） ──
  ensureBuiltinToolPlugin(name);
  const plugin = findPluginForTool(name);
  if (plugin) {
    // 记录执行开始
    await auditToolStart({
      toolRef: exec.toolRef,
      toolName: name,
      executionId,
      inputDigest,
      policyDigest: policyDigest ?? undefined,
    });

    const ctx: ToolExecutionContext = {
      cfg: params.cfg,
      execution: exec,
      toolName: name,
      input,
      policy,
      requireUserPresence,
      confirmFn: params.confirmFn,
    };

    try {
      const result = await plugin.execute(ctx);
      const durationMs = Date.now() - startTime;

      // 记录执行结果
      if (result.status === "succeeded") {
        recordToolSuccess(name);
        await auditToolSuccess({
          toolRef: exec.toolRef,
          toolName: name,
          executionId,
          durationMs,
          outputDigest: result.outputDigest,
        });
      } else {
        recordToolFailure(name);
        await auditToolFailed({
          toolRef: exec.toolRef,
          toolName: name,
          executionId,
          durationMs,
          errorCategory: result.errorCategory ?? "unknown",
          outputDigest: result.outputDigest,
        });
      }

      return result;
    } catch (err: any) {
      recordToolFailure(name);
      const durationMs = Date.now() - startTime;
      await auditToolFailed({
        toolRef: exec.toolRef,
        toolName: name,
        executionId,
        durationMs,
        errorCategory: "plugin_exception",
        outputDigest: { error: String(err?.message ?? "unknown").slice(0, 200) },
      });
      return { status: "failed", errorCategory: "plugin_exception", outputDigest: { error: String(err?.message ?? "unknown") } };
    }
  }

  // ── 无插件能处理 ────────────────────────────────────────────────
  await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "unsupported_tool" });
  return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolRef: exec.toolRef } };
}
