/**
 * Device-OS 内核模块 #4：任务执行引擎
 *
 * 统一任务状态机：pending → claimed → running → succeeded → failed → canceled → timed_out
 * 统一主链路：registerCapability → policyCheck → claim → execute → result → audit/evidence → replay
 *
 * @layer kernel
 */
import type { TaskState, ToolExecutionContext, ToolExecutionResult, DeviceClaimEnvelope } from "./types";
import { isValidTransition, isTerminalState, toolName } from "./types";
import { findPluginForTool, getToolRiskLevel, registerPlugin } from "./capabilityRegistry";
import { isCallerAllowed, isToolAllowed, getOrCreateContext, extractCallerFromRequest } from "./auth";
import { resolveToolAlias } from "./capabilityRegistry";
import { isToolFeatureEnabled, getDegradationRule, recordToolSuccess, recordToolFailure } from "./toolFeatureFlags";
import { auditToolStart, auditToolSuccess, auditToolFailed, auditToolDenied } from "./audit";
import { sha256_8, safeError, safeLog } from "../log";
import { isToolLocallyDisabled } from "../tray";
import builtinToolPlugin from "../plugins/builtinToolPlugin";

// ══════════════════════════════════════════════════════════════
// 第一部分：任务状态机与队列
// ══════════════════════════════════════════════════════════════

export type TaskPriority = "urgent" | "high" | "normal" | "low";
const PRIORITY_WEIGHT: Record<TaskPriority, number> = { urgent: 1000, high: 100, normal: 10, low: 1 };

export interface QueuedTask {
  taskId: string;
  deviceExecutionId: string;
  toolRef: string;
  input?: any;
  priority: TaskPriority;
  state: TaskState;
  enqueuedAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  idempotencyKey?: string;
  retryCount: number;
  maxRetries: number;
  timeoutMs: number;
  metadata?: Record<string, any>;
}

export interface TaskResult {
  taskId: string;
  status: "succeeded" | "failed" | "canceled" | "timed_out";
  errorCategory?: string;
  outputDigest?: any;
  evidenceRefs?: string[];
  executedAt: string;
  durationMs: number;
}

export type TaskQueueConfig = { maxQueueSize?: number; defaultPriority?: TaskPriority; defaultTimeoutMs?: number; maxRetries?: number };

let queueConfig: TaskQueueConfig = { maxQueueSize: 100, defaultPriority: "normal", defaultTimeoutMs: 60_000, maxRetries: 3 };
const taskQueue: QueuedTask[] = [];
const executingTasks = new Map<string, { task: QueuedTask; startedAt: number }>();
const completedTasks = new Map<string, TaskResult>();
const idempotencyMap = new Map<string, string>();

export function initTaskQueue(cfg?: TaskQueueConfig): void {
  if (cfg) queueConfig = { ...queueConfig, ...cfg };
}

function generateTaskId(): string { return `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }
function sortQueue(): void {
  taskQueue.sort((a, b) => {
    const sa = (PRIORITY_WEIGHT[a.priority] ?? 10) * 1e6 + (Date.now() - new Date(a.enqueuedAt).getTime());
    const sb = (PRIORITY_WEIGHT[b.priority] ?? 10) * 1e6 + (Date.now() - new Date(b.enqueuedAt).getTime());
    return sb - sa;
  });
}

export function enqueueTask(params: { deviceExecutionId: string; toolRef: string; input?: any; priority?: TaskPriority; idempotencyKey?: string; timeoutMs?: number; maxRetries?: number; metadata?: Record<string, any> }): QueuedTask | null {
  if (taskQueue.length >= (queueConfig.maxQueueSize ?? 100)) return null;
  if (params.idempotencyKey && idempotencyMap.has(params.idempotencyKey)) {
    const existingId = idempotencyMap.get(params.idempotencyKey);
    if (existingId) { const existing = taskQueue.find((t) => t.taskId === existingId); if (existing) return existing; }
    idempotencyMap.delete(params.idempotencyKey);
  }
  let priority = params.priority ?? queueConfig.defaultPriority ?? "normal";
  if (!params.priority) { const risk = getToolRiskLevel(toolName(params.toolRef)); if (risk === "critical" || risk === "high") priority = "high"; }
  const task: QueuedTask = { taskId: generateTaskId(), deviceExecutionId: params.deviceExecutionId, toolRef: params.toolRef, input: params.input, priority, state: "pending", enqueuedAt: new Date().toISOString(), idempotencyKey: params.idempotencyKey, retryCount: 0, maxRetries: params.maxRetries ?? queueConfig.maxRetries ?? 3, timeoutMs: params.timeoutMs ?? queueConfig.defaultTimeoutMs ?? 60_000, metadata: params.metadata };
  taskQueue.push(task); sortQueue();
  if (params.idempotencyKey) idempotencyMap.set(params.idempotencyKey, task.taskId);
  return task;
}

export function dequeueTask(): QueuedTask | null {
  if (taskQueue.length === 0) return null;
  const task = taskQueue.shift()!; task.state = "claimed"; task.claimedAt = new Date().toISOString();
  executingTasks.set(task.taskId, { task, startedAt: Date.now() });
  return task;
}

export function completeTask(taskId: string, result: Omit<TaskResult, "taskId">): void {
  const executing = executingTasks.get(taskId);
  if (!executing) return;
  executingTasks.delete(taskId);
  if (executing.task.idempotencyKey) idempotencyMap.delete(executing.task.idempotencyKey);
  executing.task.state = result.status === "succeeded" ? "succeeded" : result.status === "timed_out" ? "timed_out" : "failed";
  executing.task.completedAt = new Date().toISOString();
  completedTasks.set(taskId, { taskId, ...result });
  if (completedTasks.size > 100) { const oldest = completedTasks.keys().next().value; if (oldest) completedTasks.delete(oldest); }
}

export function cancelTask(taskId: string): boolean {
  const qIdx = taskQueue.findIndex((t) => t.taskId === taskId);
  if (qIdx !== -1) { const task = taskQueue.splice(qIdx, 1)[0]; task.state = "canceled"; if (task.idempotencyKey) idempotencyMap.delete(task.idempotencyKey); return true; }
  const executing = executingTasks.get(taskId);
  if (executing) { executingTasks.delete(taskId); executing.task.state = "canceled"; if (executing.task.idempotencyKey) idempotencyMap.delete(executing.task.idempotencyKey); completeTask(taskId, { status: "canceled", executedAt: new Date().toISOString(), durationMs: Date.now() - executing.startedAt }); return true; }
  return false;
}

export function getQueueStatus() {
  const byPriority: Record<TaskPriority, number> = { urgent: 0, high: 0, normal: 0, low: 0 };
  for (const t of taskQueue) byPriority[t.priority]++;
  return { queueSize: taskQueue.length, executingCount: executingTasks.size, completedCount: completedTasks.size, byPriority };
}

export function getTask(taskId: string): { task: QueuedTask | null; status: "queued" | "executing" | "completed" | "not_found" } {
  const queued = taskQueue.find((t) => t.taskId === taskId); if (queued) return { task: queued, status: "queued" };
  const executing = executingTasks.get(taskId); if (executing) return { task: executing.task, status: "executing" };
  if (completedTasks.has(taskId)) return { task: null, status: "completed" };
  return { task: null, status: "not_found" };
}

export function getPendingTasks(): QueuedTask[] { return [...taskQueue]; }

// ══════════════════════════════════════════════════════════════
// 第二部分：设备工具执行（纯调度器）
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

  // 本地禁用检查（托盘用户禁用的工具）
  try {
    if (isToolLocallyDisabled(name) || isToolLocallyDisabled(exec.toolRef)) {
      safeLog(`[taskExecutor] 工具被本地禁用: ${name}`);
      await auditToolDenied({ toolRef: exec.toolRef, toolName: name, executionId, reason: "locally_disabled" });
      return { status: "failed", errorCategory: "locally_disabled", outputDigest: { reason: "locally_disabled", tool: name } };
    }
  } catch {
    // tray 未初始化时忽略
  }

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
