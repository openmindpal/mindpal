/**
 * HTTP Polling Agent — HTTP轮询模式的设备代理
 *
 * [SDK迁移] 从 apps/device-agent/src/agent.ts 迁入
 *
 * 应用层依赖解耦：
 * - ./api → ./httpClient
 * - ./config → ../config
 * - ./log → ../kernel/log
 * - @openslin/device-agent-sdk (executeDeviceTool, etc.) → ../kernel/...
 * - ./websocketClient → ./websocketClient
 */

import { apiGetJson, apiPostJson } from "./httpClient";
import type { DeviceAgentConfig } from "../config";
import { safeError, safeLog, sha256_8 } from "../kernel/log";
import { executeDeviceTool } from "../kernel/taskExecutor";
import { disposeAllPlugins } from "../kernel/pluginLifecycle";
import { syncPolicyToCache, getCachedPolicy, isCachedToolAllowed } from "../kernel/auth";
import { WebSocketDeviceAgent, probeDeviceModalities } from "./websocketClient";

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
  const pending = await apiGetJson<{ executions: DeviceExecution[] }>({ apiBase: params.cfg.apiBase, path: "/device-agent/executions/pending?limit=10", token: params.cfg.deviceToken }).catch((err) => {
    safeError(`[agent] Network error fetching pending executions: ${err?.message ?? "unknown"}`);
    return { status: 0, json: null, networkError: true };
  });

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
  idleTimeoutMs?: number;
  onLog?: (s: string) => void;
  shouldStopFn?: () => boolean;
  /** 传输模式: auto(WS优先降级HTTP) / ws(仅WS) / http(仅HTTP轮询) */
  transport?: 'auto' | 'ws' | 'http';
}) {
  const log = params.onLog ?? safeLog;
  const err = safeError;
  const transport = params.transport ?? 'auto';

  log(`device-agent running: deviceId=${params.cfg.deviceId} tokenSha256_8=${sha256_8(params.cfg.deviceToken)} transport=${transport}`);

  let stopped = false;
  let stopReason: "manual" | "re-enroll" | "heartbeat-fail" | "idle-timeout" = "manual";
  const stop = (reason: typeof stopReason = "manual") => {
    stopReason = reason;
    stopped = true;
  };

  let lastTaskTime = Date.now();
  const idleTimeoutMs = params.idleTimeoutMs ?? 0;
  const checkIdleTimeout = () => {
    if (idleTimeoutMs > 0 && Date.now() - lastTaskTime > idleTimeoutMs) {
      log(`device-agent idle timeout: no tasks for ${Math.round(idleTimeoutMs / 1000)}s, exiting to save resources`);
      return true;
    }
    return false;
  };

  let currentTransport: 'ws' | 'http-polling' = transport === 'http' ? 'http-polling' : 'ws';
  let wsClient: WebSocketDeviceAgent | null = null;

  if (transport !== 'http') {
    wsClient = new WebSocketDeviceAgent(params.cfg, params.confirmFn);

    // P3: 探测设备能力并设置到 WS 客户端，握手时自动携带
    const capDesc = probeDeviceModalities();
    wsClient.setCapabilityDescriptor(capDesc);
    log(`[agent] 设备能力探测完成: type=${capDesc.deviceType} sensors=${capDesc.capabilities.sensors.map(s => s.type).join(',')}`);

    wsClient.onDisconnect(() => {
      if (currentTransport === 'ws') {
        log('[agent] WS断开，降级到HTTP轮询模式');
        currentTransport = 'http-polling';
      }
    });
    wsClient.onReconnect(() => {
      if (currentTransport === 'http-polling') {
        log('[agent] WS重连成功，切回WS模式');
        currentTransport = 'ws';
      }
    });

    try {
      await wsClient.connect();
      currentTransport = 'ws';
      log('[agent] WS连接成功，进入WS推送驱动模式');
    } catch (wsErr: unknown) {
      const msg = wsErr instanceof Error ? wsErr.message : 'unknown';
      log(`[agent] WS连接失败: ${msg}`);
      if (transport === 'ws') {
        err('[agent] WS-only模式，不降级HTTP，退出');
        return { stopReason: 'manual' as const };
      }
      currentTransport = 'http-polling';
      log('[agent] 降级到HTTP轮询模式');
    }
  }

  let consecutiveHeartbeatFailures = 0;
  const MAX_HEARTBEAT_FAILURES = 10;

  const heartbeatTimer = setInterval(async () => {
    if (stopped) return;
    if (currentTransport === 'ws') return;
    try {
      const hb = await heartbeatOnce({ cfg: params.cfg });
      if (hb.needReEnroll) {
        err("device-agent unauthorized: need re-enroll");
        stop("re-enroll");
        return;
      }
      if (hb.ok) {
        consecutiveHeartbeatFailures = 0;
      } else {
        consecutiveHeartbeatFailures++;
        err(`device-agent heartbeat failed (${consecutiveHeartbeatFailures}/${MAX_HEARTBEAT_FAILURES})`);
      }
    } catch (e: unknown) {
      consecutiveHeartbeatFailures++;
      const msg = e instanceof Error ? e.message : 'unknown';
      err(`device-agent heartbeat error (${consecutiveHeartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${msg}`);
    }
    if (consecutiveHeartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
      err(`device-agent stopping: ${MAX_HEARTBEAT_FAILURES} consecutive heartbeat failures`);
      stop("heartbeat-fail");
    }
  }, params.heartbeatIntervalMs);

  while (!stopped) {
    if (params.shouldStopFn?.()) {
      stop("manual");
      break;
    }

    if (checkIdleTimeout()) {
      stop("idle-timeout");
      break;
    }

    if (wsClient?.needReEnroll) {
      stop("re-enroll");
      break;
    }

    if (currentTransport === 'ws') {
      await new Promise((resolve) => setTimeout(resolve, params.heartbeatIntervalMs));
    } else {
      const r = await runOnce({ cfg: params.cfg, confirmFn: params.confirmFn, now: () => new Date() });
      if (!r.ok && r.needReEnroll) {
        stop("re-enroll");
        break;
      }
      if (r.ok && r.hadTasks) {
        lastTaskTime = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
    }
  }

  clearInterval(heartbeatTimer);

  if (wsClient) {
    wsClient.stop();
  }

  try {
    await disposeAllPlugins();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    err(`device-agent disposeAllPlugins error: ${msg}`);
  }

  log(`device-agent stopped: reason=${stopReason}`);
  return { stopReason };
}
