import { apiGetJson, apiPostJson } from "./api";
import type { DeviceAgentConfig } from "./config";
import { safeError, safeLog, sha256_8 } from "./log";
import { executeDeviceTool } from "./kernel/taskExecutor";
import { disposeAllPlugins } from "./kernel/pluginLifecycle";
import { syncPolicyToCache, getCachedPolicy, isCachedToolAllowed } from "./kernel/auth";

export type DeviceExecution = {
  deviceExecutionId: string;
  toolRef: string;
  input?: any;
};

function toolName(toolRef: string) {
  const idx = toolRef.indexOf("@");
  if (idx <= 0) return toolRef;
  return toolRef.slice(0, idx);
}

function digestObject(v: any) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  return { keyCount: keys.length, keys: keys.slice(0, 50) };
}

function mergeOutputDigest(base: any, extra: any) {
  const a = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  const b = extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {};
  return { ...a, ...b };
}

export async function runOnce(params: {
  cfg: DeviceAgentConfig;
  confirmFn: (q: string) => Promise<boolean>;
  now: () => Date;
}) {
  // 尝试从服务端获取待执行任务
  const pending = await apiGetJson<{ executions: DeviceExecution[] }>({ apiBase: params.cfg.apiBase, path: "/device-agent/executions/pending?limit=10", token: params.cfg.deviceToken }).catch((err) => {
    // 网络失败时返回模拟响应
    safeError(`[agent] Network error fetching pending executions: ${err?.message ?? "unknown"}`);
    return { status: 0, json: null, networkError: true };
  });

  // 网络失败时，检查是否有缓存策略可用于离线模式
  if ((pending as any).networkError) {
    const cached = getCachedPolicy();
    if (cached) {
      safeLog(`[agent] Network unavailable, but cached policy available (version=${cached.version}). Waiting for network...`);
    }
    return { ok: false, needReEnroll: false as const, offline: true };
  }
  if (pending.status === 401 || pending.status === 403) return { ok: false, needReEnroll: true as const };
  if (pending.status !== 200) return { ok: false, needReEnroll: false as const };

  const list = Array.isArray(pending.json?.executions) ? pending.json.executions : [];
  for (const e of list) {
    const claim = await apiPostJson<{ execution: DeviceExecution; requireUserPresence?: boolean; policy?: any; policyDigest?: any }>({
      apiBase: params.cfg.apiBase,
      path: `/device-agent/executions/${encodeURIComponent(e.deviceExecutionId)}/claim`,
      token: params.cfg.deviceToken,
      body: {},
    });
    if (claim.status === 401 || claim.status === 403) return { ok: false, needReEnroll: true as const };
    if (claim.status !== 200) continue;

    // 成功获取策略后同步到缓存
    if (claim.json?.policy) {
      try {
        await syncPolicyToCache(claim.json.policy);
      } catch (cacheErr: any) {
        safeError(`[agent] Failed to cache policy: ${cacheErr?.message ?? "unknown"}`);
      }
    }

    const name = toolName(e.toolRef);
    let status: "succeeded" | "failed" = "succeeded";
    let errorCategory: string | undefined;
    let outputDigest: any = null;
    let evidenceRefs: string[] | undefined;
    try {
      const out = await executeDeviceTool({ cfg: params.cfg, claim: claim.json as any, confirmFn: params.confirmFn });
      status = out.status;
      errorCategory = out.errorCategory;
      outputDigest = out.outputDigest ?? null;
      evidenceRefs = Array.isArray((out as any).evidenceRefs) ? ((out as any).evidenceRefs as string[]) : undefined;
    } catch (err: any) {
      status = "failed";
      errorCategory = "executor_error";
      outputDigest = { messageLen: String(err?.message ?? "unknown").length };
    }

    const policyDigest = (claim.json as any)?.policyDigest ?? null;
    outputDigest = mergeOutputDigest(outputDigest, policyDigest ? { policyDigest } : null);
    outputDigest = mergeOutputDigest(outputDigest, { tool: name, inputDigest: digestObject(e.input ?? null) });

    const result = await apiPostJson({
      apiBase: params.cfg.apiBase,
      path: `/device-agent/executions/${encodeURIComponent(e.deviceExecutionId)}/result`,
      token: params.cfg.deviceToken,
      body: { status, errorCategory, outputDigest, evidenceRefs: status === "succeeded" ? (evidenceRefs ?? [`local:evidence:${sha256_8(e.deviceExecutionId)}`]) : undefined },
    });
    if (result.status === 401 || result.status === 403) return { ok: false, needReEnroll: true as const };
  }

  return { ok: true, needReEnroll: false as const, hadTasks: list.length > 0, offline: false };
}

export async function heartbeatOnce(params: { cfg: DeviceAgentConfig }) {
  const r = await apiPostJson<{ ok: boolean }>({
    apiBase: params.cfg.apiBase,
    path: "/device-agent/heartbeat",
    token: params.cfg.deviceToken,
    body: { os: params.cfg.os, agentVersion: params.cfg.agentVersion },
  });
  if (r.status === 401 || r.status === 403) return { ok: false, needReEnroll: true as const };
  return { ok: r.status === 200, needReEnroll: false as const };
}

export type AgentState = "idle" | "running" | "stopped";

export async function runLoop(params: {
  cfg: DeviceAgentConfig;
  confirmFn: (q: string) => Promise<boolean>;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  idleTimeoutMs?: number; // 空闲超时自动退出（毫秒），0或undefined表示禁用
  onLog?: (s: string) => void;
  shouldStopFn?: () => boolean; // 外部控制停止（托盘模式用）
}) {
  const log = params.onLog ?? safeLog;
  const err = safeError;

  log(`device-agent running: deviceId=${params.cfg.deviceId} tokenSha256_8=${sha256_8(params.cfg.deviceToken)}`);

  let stopped = false;
  let stopReason: "manual" | "re-enroll" | "heartbeat-fail" | "idle-timeout" = "manual";
  const stop = (reason: typeof stopReason = "manual") => {
    stopReason = reason;
    stopped = true;
  };

  // 空闲自动退出机制（轻量化：无任务时自动释放资源）
  let lastTaskTime = Date.now();
  const idleTimeoutMs = params.idleTimeoutMs ?? 0; // 默认禁用，由调用方决定
  const checkIdleTimeout = () => {
    if (idleTimeoutMs > 0 && Date.now() - lastTaskTime > idleTimeoutMs) {
      log(`device-agent idle timeout: no tasks for ${Math.round(idleTimeoutMs / 1000)}s, exiting to save resources`);
      return true;
    }
    return false;
  };

  let consecutiveHeartbeatFailures = 0;
  const MAX_HEARTBEAT_FAILURES = 10; // 连续10次心跳失败才停止

  const heartbeatTimer = setInterval(async () => {
    if (stopped) return;
    try {
      const hb = await heartbeatOnce({ cfg: params.cfg });
      if (hb.needReEnroll) {
        err("device-agent unauthorized: need re-enroll");
        stop("re-enroll");
        return;
      }
      if (hb.ok) {
        consecutiveHeartbeatFailures = 0; // 重置失败计数
      } else {
        consecutiveHeartbeatFailures++;
        err(`device-agent heartbeat failed (${consecutiveHeartbeatFailures}/${MAX_HEARTBEAT_FAILURES})`);
      }
    } catch (e: any) {
      consecutiveHeartbeatFailures++;
      err(`device-agent heartbeat error (${consecutiveHeartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${e?.message ?? "unknown"}`);
    }
    // 连续多次失败后才停止，允许临时网络波动
    if (consecutiveHeartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
      err(`device-agent stopping: ${MAX_HEARTBEAT_FAILURES} consecutive heartbeat failures`);
      stop("heartbeat-fail");
    }
  }, params.heartbeatIntervalMs);

  while (!stopped) {
    // 检查外部停止信号
    if (params.shouldStopFn?.()) {
      stop("manual");
      break;
    }

    // 检查空闲超时
    if (checkIdleTimeout()) {
      stop("idle-timeout");
      break;
    }

    const r = await runOnce({ cfg: params.cfg, confirmFn: params.confirmFn, now: () => new Date() });
    if (!r.ok && r.needReEnroll) {
      stop("re-enroll");
      break;
    }

    // 如果本轮有任务执行，更新最后活跃时间
    if (r.ok && r.hadTasks) {
      lastTaskTime = Date.now();
    }

    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
  }

  clearInterval(heartbeatTimer);

  // Graceful plugin shutdown — invoke dispose() on all registered plugins
  try {
    await disposeAllPlugins();
  } catch (e: any) {
    err(`device-agent disposeAllPlugins error: ${e?.message ?? "unknown"}`);
  }

  log(`device-agent stopped: reason=${stopReason}`);
  return { stopReason };
}
