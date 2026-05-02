/**
 * P2: Loop Resume Handler — Worker 端 Agent Loop 恢复处理器
 *
 * 职责：
 * - 处理 Supervisor 投递的 loop_resume BullMQ 任务
 * - 通过 HTTP 调用 API 内部恢复端点，让任意 API 节点恢复中断的 Agent Loop
 * - 支持负载感知路由（优先选择低负载 API 节点）
 * - 完善的重试与错误处理
 *
 * 架构：
 *   Worker[Supervisor] → BullMQ(loop_resume) → Worker[ResumeHandler] → HTTP → API[/internal/loop-resume]
 *   任意 API 节点接收到请求后调用 runAgentLoop(resumeLoopId, resumeState)
 */
import type { Pool } from "pg";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:loopResume" });

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export interface LoopResumePayload {
  loopId: string;
  runId: string;
  jobId: string;
  taskId: string | null;
  tenantId: string;
  spaceId: string | null;
  goal: string;
  maxIterations: number;
  maxWallTimeMs: number;
  subjectPayload: Record<string, unknown>;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  defaultModelRef: string | null;
  executionConstraints?: {
    allowedTools?: string[];
    allowWrites?: boolean;
  } | null;
  resumeState: {
    iteration: number;
    currentSeq: number;
    succeededSteps: number;
    failedSteps: number;
    observations: any[];
    lastDecision: any;
    toolDiscoveryCache?: any;
    memoryContext?: string | null;
    taskHistory?: string | null;
    knowledgeContext?: string | null;
  };
}

export interface ResumeResult {
  ok: boolean;
  loopId: string;
  runId: string;
  apiNode?: string;
  error?: string;
  durationMs: number;
}

export interface ResumeHandlerDeps {
  pool: Pool;
  /** API 服务器地址列表，支持多节点负载均衡 */
  apiEndpoints?: string[];
  /** 内部通信密钥（Worker→API） */
  internalSecret?: string;
}

/* ================================================================== */
/*  Configuration                                                       */
/* ================================================================== */

/** API 内部端点 URL（单节点时使用） */
function getApiInternalUrl(): string {
  return (process.env.API_INTERNAL_URL ?? process.env.API_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
}

/** 多节点 API 端点列表（逗号分隔） */
function getApiEndpoints(): string[] {
  const envList = (process.env.API_INTERNAL_ENDPOINTS ?? "").trim();
  if (envList) return envList.split(",").map((s) => s.trim()).filter(Boolean);
  return [getApiInternalUrl()];
}

/** 内部通信密钥 */
function getInternalSecret(): string {
  return process.env.INTERNAL_API_SECRET ?? process.env.API_SECRET ?? "";
}

/** 恢复请求超时（ms） */
const RESUME_TIMEOUT_MS = Math.max(5000, Number(process.env.LOOP_RESUME_TIMEOUT_MS ?? "30000"));

/** 最大重试次数 */
const MAX_RETRIES = Math.max(0, Number(process.env.LOOP_RESUME_MAX_RETRIES ?? "2"));

/* ================================================================== */
/*  Node Health Tracking                                                */
/* ================================================================== */

interface NodeHealth {
  url: string;
  lastSuccessAt: number;
  lastFailureAt: number;
  consecutiveFailures: number;
  avgResponseMs: number;
}

const _nodeHealth = new Map<string, NodeHealth>();

function getNodeHealth(url: string): NodeHealth {
  let h = _nodeHealth.get(url);
  if (!h) {
    h = { url, lastSuccessAt: 0, lastFailureAt: 0, consecutiveFailures: 0, avgResponseMs: 0 };
    _nodeHealth.set(url, h);
  }
  return h;
}

function recordNodeSuccess(url: string, responseMs: number): void {
  const h = getNodeHealth(url);
  h.lastSuccessAt = Date.now();
  h.consecutiveFailures = 0;
  h.avgResponseMs = h.avgResponseMs > 0 ? Math.round((h.avgResponseMs + responseMs) / 2) : responseMs;
}

function recordNodeFailure(url: string): void {
  const h = getNodeHealth(url);
  h.lastFailureAt = Date.now();
  h.consecutiveFailures++;
}

/** 选择最健康的 API 节点（最低失败次数 + 最低响应时间） */
function selectBestNode(endpoints: string[]): string {
  if (endpoints.length <= 1) return endpoints[0] ?? getApiInternalUrl();

  // 过滤掉连续失败 ≥5 且最近 60s 内失败的节点
  const now = Date.now();
  const candidates = endpoints.filter((url) => {
    const h = _nodeHealth.get(url);
    if (!h) return true;
    if (h.consecutiveFailures >= 5 && now - h.lastFailureAt < 60_000) return false;
    return true;
  });

  if (candidates.length === 0) return endpoints[0]; // 全部不健康，随机选一个

  // 按综合评分排序（失败次数权重 80%，响应时间权重 20%）
  candidates.sort((a, b) => {
    const ha = getNodeHealth(a);
    const hb = getNodeHealth(b);
    const scoreA = ha.consecutiveFailures * 1000 + ha.avgResponseMs * 0.2;
    const scoreB = hb.consecutiveFailures * 1000 + hb.avgResponseMs * 0.2;
    return scoreA - scoreB;
  });

  return candidates[0];
}

/* ================================================================== */
/*  Core: Process loop_resume Job                                       */
/* ================================================================== */

/**
 * 处理单个 loop_resume 任务。
 * 由 Worker 的 BullMQ processor 调用。
 */
export async function processLoopResume(
  payload: LoopResumePayload,
  deps: ResumeHandlerDeps,
): Promise<ResumeResult> {
  const t0 = Date.now();
  const endpoints = deps.apiEndpoints ?? getApiEndpoints();
  const secret = deps.internalSecret ?? getInternalSecret();
  if (!secret) {
    return { ok: false, loopId: payload.loopId, runId: payload.runId, error: "internal_secret_missing", durationMs: Date.now() - t0 };
  }

  // 验证 payload 完整性
  if (!payload.loopId || !payload.runId) {
    return { ok: false, loopId: payload.loopId ?? "", runId: payload.runId ?? "", error: "invalid_payload", durationMs: Date.now() - t0 };
  }

  // 检查 checkpoint 是否仍可恢复（避免过期数据）
  try {
    const cpRes = await deps.pool.query(
      "SELECT status FROM agent_loop_checkpoints WHERE loop_id = $1",
      [payload.loopId],
    );
    if (!cpRes.rowCount) {
      return { ok: false, loopId: payload.loopId, runId: payload.runId, error: "checkpoint_not_found", durationMs: Date.now() - t0 };
    }
    const status = String(cpRes.rows[0].status);
    if (status === "succeeded" || status === "failed" || status === "expired") {
      _logger.info("checkpoint already in terminal state", { loopId: payload.loopId, status });
      return { ok: true, loopId: payload.loopId, runId: payload.runId, durationMs: Date.now() - t0 };
    }
  } catch (e: any) {
    _logger.warn("checkpoint status check failed", { err: e?.message });
    // 继续尝试恢复
  }

  // 带重试调用 API
  let lastError: string = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const apiUrl = selectBestNode(endpoints);
    const url = `${apiUrl}/internal/loop-resume`;

    try {
      const t1 = Date.now();
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { "x-internal-secret": secret } : {}),
          "x-source": "worker-loop-resume",
          "x-loop-id": payload.loopId,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(RESUME_TIMEOUT_MS),
      });

      const responseMs = Date.now() - t1;

      if (resp.ok) {
        recordNodeSuccess(apiUrl, responseMs);
        const body = await resp.json().catch(() => ({})) as any;
        _logger.info("resume dispatched", { loopId: payload.loopId, apiNode: apiUrl, responseMs });
        return {
          ok: true,
          loopId: payload.loopId,
          runId: payload.runId,
          apiNode: apiUrl,
          durationMs: Date.now() - t0,
        };
      }

      // 非 2xx 响应
      const errBody = await resp.text().catch(() => "");
      lastError = `http_${resp.status}: ${errBody.slice(0, 200)}`;
      recordNodeFailure(apiUrl);
      _logger.warn("resume attempt failed", { attempt: attempt + 1, maxAttempts: MAX_RETRIES + 1, error: lastError });

      // 4xx 不重试（payload 问题）
      if (resp.status >= 400 && resp.status < 500) break;
    } catch (err: any) {
      lastError = err?.message ?? "unknown_error";
      recordNodeFailure(apiUrl);
      _logger.warn("resume attempt error", { attempt: attempt + 1, maxAttempts: MAX_RETRIES + 1, error: lastError });
    }

    // 指数退避
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 10_000)));
    }
  }

  // 所有重试失败 → 回退 checkpoint 状态，让 Supervisor 下次 tick 重试
  try {
    await deps.pool.query(
      "UPDATE agent_loop_checkpoints SET status = 'running', updated_at = now() WHERE loop_id = $1 AND status = 'resuming'",
      [payload.loopId],
    );
  } catch {}

  return {
    ok: false,
    loopId: payload.loopId,
    runId: payload.runId,
    error: `all_retries_failed: ${lastError}`,
    durationMs: Date.now() - t0,
  };
}

/* ================================================================== */
/*  Health Summary                                                      */
/* ================================================================== */

export function getResumeHandlerHealth(): {
  nodeCount: number;
  nodes: Array<{ url: string; healthy: boolean; consecutiveFailures: number; avgResponseMs: number }>;
} {
  const nodes = Array.from(_nodeHealth.values()).map((h) => ({
    url: h.url,
    healthy: h.consecutiveFailures < 5,
    consecutiveFailures: h.consecutiveFailures,
    avgResponseMs: h.avgResponseMs,
  }));
  return { nodeCount: nodes.length, nodes };
}
