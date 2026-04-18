import type { Pool } from "pg";

// ── P2-5: 结构化能力画像类型 ─────────────────────────

export type ReasoningDepth = "low" | "medium" | "high";
export type ToolCallAbility = "none" | "basic" | "native" | "advanced";
export type StructuredOutputAbility = "none" | "json" | "json_schema";
export type QualityLevel = "none" | "low" | "medium" | "high";

/** P2-5: 结构化模型能力画像 */
export type ModelCapabilities = {
  supportedModalities: string[];     // ["text", "image", "audio"]
  contextWindow: number;              // e.g. 128000
  maxOutputTokens: number;            // e.g. 4096
  reasoningDepth: ReasoningDepth;
  toolCallAbility: ToolCallAbility;
  structuredOutputAbility: StructuredOutputAbility;
  streamingSupport: boolean;
  visionSupport: boolean;
  codeGenQuality: QualityLevel;
  multilingualSupport: string[];      // ["zh","en","ja"]
};

/** P2-5: 模型性能统计 */
export type ModelPerformanceStats = {
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  successRate: number;                 // 0~1
  avgOutputTokensPerSec: number;
  costPer1kInputTokens: number;
  costPer1kOutputTokens: number;
  sampleCount: number;
  lastMeasuredAt: string | null;
};

/** P2-5: 模型状态 */
export type ModelStatus = "active" | "degraded" | "unavailable" | "probing";

export type ModelCatalogEntry = {
  provider: string;
  model: string;
  modelRef: string;
  endpointHost: string;
  capabilities: ModelCapabilities | Record<string, unknown>;
  defaultLimits: { timeoutMs: number };
  /** P2-5: DB-backed fields */
  id?: string;
  displayName?: string;
  performanceStats?: ModelPerformanceStats;
  status?: ModelStatus;
  degradationScore?: number;
  lastProbedAt?: string | null;
};

export const modelCatalog: ModelCatalogEntry[] = [];

export const openaiCompatibleProviders = ["openai_compatible", "deepseek", "hunyuan", "qianwen", "zhipu", "doubao", "kimi", "kimimax", "custom_openai"] as const;
export type OpenAiCompatibleProvider = (typeof openaiCompatibleProviders)[number];

function isOpenAiCompatibleProvider(v: string): v is OpenAiCompatibleProvider {
  return (openaiCompatibleProviders as readonly string[]).includes(v);
}

export const nativeProtocolProviders = ["anthropic", "gemini", "custom_anthropic", "custom_gemini"] as const;
export type NativeProtocolProvider = (typeof nativeProtocolProviders)[number];

function isNativeProtocolProvider(v: string): v is NativeProtocolProvider {
  return (nativeProtocolProviders as readonly string[]).includes(v);
}

export function findCatalogByRef(modelRef: string) {
  const exact = modelCatalog.find((e) => e.modelRef === modelRef) ?? null;
  if (exact) return exact;

  const m = /^([a-z0-9_]+):(.+)$/.exec(String(modelRef ?? "").trim());
  if (!m) return null;
  const provider = m[1];
  const model = m[2];
  if (!provider || !model) return null;
  if (!isOpenAiCompatibleProvider(provider) && !isNativeProtocolProvider(provider)) return null;
  return {
    provider,
    model,
    modelRef: `${provider}:${model}`,
    endpointHost: "",
    capabilities: { chat: true, structuredOutput: false } as Record<string, unknown>,
    defaultLimits: { timeoutMs: isNativeProtocolProvider(provider) ? 30000 : 20000 },
  };
}

// ── P2-5: DB-backed 模型目录 CRUD ───────────────────────

const defaultCapabilities: ModelCapabilities = {
  supportedModalities: ["text"],
  contextWindow: 8192,
  maxOutputTokens: 2048,
  reasoningDepth: "medium",
  toolCallAbility: "basic",
  structuredOutputAbility: "json",
  streamingSupport: true,
  visionSupport: false,
  codeGenQuality: "medium",
  multilingualSupport: ["en"],
};

const defaultPerformanceStats: ModelPerformanceStats = {
  latencyP50Ms: 0, latencyP95Ms: 0, latencyP99Ms: 0,
  successRate: 1, avgOutputTokensPerSec: 0,
  costPer1kInputTokens: 0, costPer1kOutputTokens: 0,
  sampleCount: 0, lastMeasuredAt: null,
};

function toDbCatalogEntry(r: any): ModelCatalogEntry {
  const caps = r.capabilities ?? {};
  const perf = r.performance_stats ?? {};
  return {
    id: r.id,
    provider: r.provider,
    model: r.model_name,
    modelRef: r.model_ref,
    endpointHost: r.endpoint_host ?? "",
    displayName: r.display_name ?? undefined,
    capabilities: { ...defaultCapabilities, ...caps },
    defaultLimits: { timeoutMs: 20000 },
    performanceStats: { ...defaultPerformanceStats, ...perf },
    status: r.status ?? "active",
    degradationScore: Number(r.degradation_score ?? 0),
    lastProbedAt: r.last_probed_at ?? null,
  };
}

/** P2-5: 从 DB 加载模型目录 */
export async function listModelCatalogFromDb(params: {
  pool: Pool; tenantId: string; status?: ModelStatus;
}): Promise<ModelCatalogEntry[]> {
  const { pool, tenantId, status } = params;
  const res = status
    ? await pool.query(
        `SELECT * FROM model_catalog WHERE tenant_id = $1 AND status = $2 ORDER BY model_ref`,
        [tenantId, status],
      )
    : await pool.query(
        `SELECT * FROM model_catalog WHERE tenant_id = $1 ORDER BY model_ref`,
        [tenantId],
      );
  return res.rows.map(toDbCatalogEntry);
}

/** P2-5: 按 model_ref 查找（优先 DB，回退到静态目录） */
export async function findCatalogByRefFromDb(params: {
  pool: Pool; tenantId: string; modelRef: string;
}): Promise<ModelCatalogEntry | null> {
  const res = await params.pool.query(
    `SELECT * FROM model_catalog WHERE tenant_id = $1 AND model_ref = $2 LIMIT 1`,
    [params.tenantId, params.modelRef],
  );
  if (res.rowCount) return toDbCatalogEntry(res.rows[0]);
  // 回退到静态目录
  return findCatalogByRef(params.modelRef);
}

/** P2-5: 注册或更新模型到 DB */
export async function upsertModelCatalog(params: {
  pool: Pool;
  tenantId: string;
  modelRef: string;
  provider: string;
  modelName: string;
  displayName?: string;
  capabilities?: Partial<ModelCapabilities>;
  performanceStats?: Partial<ModelPerformanceStats>;
  endpointHost?: string;
  status?: ModelStatus;
}): Promise<ModelCatalogEntry> {
  const caps = JSON.stringify({ ...defaultCapabilities, ...(params.capabilities ?? {}) });
  const perf = JSON.stringify({ ...defaultPerformanceStats, ...(params.performanceStats ?? {}) });
  const res = await params.pool.query(
    `INSERT INTO model_catalog (tenant_id, model_ref, provider, model_name, display_name, capabilities, performance_stats, endpoint_host, status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
     ON CONFLICT (tenant_id, model_ref) DO UPDATE SET
       provider = EXCLUDED.provider,
       model_name = EXCLUDED.model_name,
       display_name = COALESCE(EXCLUDED.display_name, model_catalog.display_name),
       capabilities = model_catalog.capabilities || EXCLUDED.capabilities,
       performance_stats = model_catalog.performance_stats || EXCLUDED.performance_stats,
       endpoint_host = COALESCE(EXCLUDED.endpoint_host, model_catalog.endpoint_host),
       status = COALESCE(EXCLUDED.status, model_catalog.status),
       updated_at = now()
     RETURNING *`,
    [params.tenantId, params.modelRef, params.provider, params.modelName,
     params.displayName ?? null, caps, perf, params.endpointHost ?? null, params.status ?? "active"],
  );
  return toDbCatalogEntry(res.rows[0]);
}

/** P2-5: 更新模型性能统计 */
export async function updateModelPerformanceStats(params: {
  pool: Pool; tenantId: string; modelRef: string;
  stats: Partial<ModelPerformanceStats>;
}) {
  const merged = JSON.stringify(params.stats);
  await params.pool.query(
    `UPDATE model_catalog SET
       performance_stats = performance_stats || $3::jsonb,
       updated_at = now()
     WHERE tenant_id = $1 AND model_ref = $2`,
    [params.tenantId, params.modelRef, merged],
  );
}

/** P2-5: 更新模型状态和退化分数 */
export async function updateModelStatus(params: {
  pool: Pool; tenantId: string; modelRef: string;
  status: ModelStatus; degradationScore?: number;
}) {
  await params.pool.query(
    `UPDATE model_catalog SET
       status = $3,
       degradation_score = COALESCE($4, degradation_score),
       updated_at = now()
     WHERE tenant_id = $1 AND model_ref = $2`,
    [params.tenantId, params.modelRef, params.status, params.degradationScore ?? null],
  );
}

/** P2-5: 记录探测结果 */
export async function recordProbeResult(params: {
  pool: Pool; tenantId: string; modelRef: string;
  probeType: string; probeInput?: any; probeOutput?: any;
  success: boolean; latencyMs?: number; errorMessage?: string;
}) {
  await params.pool.query(
    `INSERT INTO model_probe_log (tenant_id, model_ref, probe_type, probe_input, probe_output, success, latency_ms, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [params.tenantId, params.modelRef, params.probeType,
     params.probeInput ? JSON.stringify(params.probeInput) : null,
     params.probeOutput ? JSON.stringify(params.probeOutput) : null,
     params.success, params.latencyMs ?? null, params.errorMessage ?? null],
  );
  // 更新最后探测时间
  await params.pool.query(
    `UPDATE model_catalog SET last_probed_at = now(), probe_result = $3::jsonb WHERE tenant_id = $1 AND model_ref = $2`,
    [params.tenantId, params.modelRef, JSON.stringify({ type: params.probeType, success: params.success, latencyMs: params.latencyMs })],
  );
}

/** P2-5: 创建退化告警 */
export async function createDegradationAlert(params: {
  pool: Pool; tenantId: string; modelRef: string;
  alertType: string; severity?: string; details?: any;
}) {
  await params.pool.query(
    `INSERT INTO model_degradation_alerts (tenant_id, model_ref, alert_type, severity, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.tenantId, params.modelRef, params.alertType,
     params.severity ?? "warning", params.details ? JSON.stringify(params.details) : null],
  );
}
