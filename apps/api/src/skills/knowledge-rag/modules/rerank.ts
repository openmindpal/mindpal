/**
 * Rerank 模块：支持外部重排模型（Cohere/Jina/自建 API 兼容格式）
 *
 * 配置方式:
 *   1. 环境变量: KNOWLEDGE_RERANK_ENDPOINT / KNOWLEDGE_RERANK_API_KEY / KNOWLEDGE_RERANK_MODEL
 *   2. 数据库: knowledge_rerank_configs 表（按 tenant/space 粒度）
 *
 * 调用格式 (POST endpoint/v1/rerank):
 *   { query, documents: string[], model, top_n }
 *   返回: { results: [{ index, relevance_score }] }
 */

import type { Pool } from "pg";

export type RerankConfig = {
  enabled: boolean;
  provider: string;
  endpoint: string;
  apiKey: string | null;
  model: string;
  topN: number;
  timeoutMs: number;
};

export type RerankResult = {
  reranked: boolean;
  items: Array<{ originalIndex: number; score: number }>;
  degraded: boolean;
  degradeReason: string | null;
  latencyMs: number;
};

/* ── 配置解析 ─────────────────────────────────────────────── */

function resolveRerankConfigFromEnv(): RerankConfig | null {
  const endpoint = String(process.env.KNOWLEDGE_RERANK_ENDPOINT ?? "").trim();
  if (!endpoint) return null;
  return {
    enabled: true,
    provider: "external",
    endpoint,
    apiKey: String(process.env.KNOWLEDGE_RERANK_API_KEY ?? "").trim() || null,
    model: String(process.env.KNOWLEDGE_RERANK_MODEL ?? "rerank-v1").trim(),
    topN: Math.max(1, Math.min(100, Number(process.env.KNOWLEDGE_RERANK_TOP_N ?? 10))),
    timeoutMs: Math.max(1000, Number(process.env.KNOWLEDGE_RERANK_TIMEOUT_MS ?? 5000)),
  };
}

export async function getRerankConfig(params: { pool: Pool; tenantId: string; spaceId: string }): Promise<RerankConfig | null> {
  /* 优先从数据库查询 */
  try {
    const res = await params.pool.query(
      "SELECT * FROM knowledge_rerank_configs WHERE tenant_id = $1 AND space_id = $2 LIMIT 1",
      [params.tenantId, params.spaceId],
    );
    if (res.rowCount) {
      const r = res.rows[0] as any;
      if (!Boolean(r.enabled)) return null;
      const endpoint = String(r.endpoint ?? "").trim();
      if (!endpoint) return resolveRerankConfigFromEnv();
      return {
        enabled: true,
        provider: String(r.provider ?? "external"),
        endpoint,
        apiKey: r.api_key ? String(r.api_key) : null,
        model: String(r.model ?? "rerank-v1"),
        topN: Math.max(1, Math.min(100, Number(r.top_n ?? 10))),
        timeoutMs: Math.max(1000, Number(r.timeout_ms ?? 5000)),
      };
    }
  } catch {
    /* 表不存在或查询失败，降级到环境变量 */
  }
  return resolveRerankConfigFromEnv();
}

/* ── Rerank 执行 ──────────────────────────────────────────── */

export async function rerank(params: {
  config: RerankConfig;
  query: string;
  documents: string[];
}): Promise<RerankResult> {
  const startedAt = Date.now();
  const url = params.config.endpoint.replace(/\/$/, "") + "/v1/rerank";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (params.config.apiKey) headers["authorization"] = `Bearer ${params.config.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.config.timeoutMs);

  try {
    const payload = {
      query: params.query,
      documents: params.documents,
      model: params.config.model,
      top_n: Math.min(params.config.topN, params.documents.length),
    };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    } as any);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[knowledge:rerank] Rerank API 返回 ${res.status}: ${errBody.slice(0, 500)}`);
      return {
        reranked: false,
        items: params.documents.map((_, i) => ({ originalIndex: i, score: 0 })),
        degraded: true,
        degradeReason: `rerank_api_http_${res.status}`,
        latencyMs: Date.now() - startedAt,
      };
    }

    const json = (await res.json()) as any;
    const results = Array.isArray(json?.results) ? json.results : [];
    const items = results.map((r: any) => ({
      originalIndex: Number(r?.index ?? 0),
      score: Number(r?.relevance_score ?? r?.score ?? 0),
    }));

    console.log(`[knowledge:rerank] Rerank 成功，返回 ${items.length} 条结果，耗时 ${Date.now() - startedAt}ms`);
    return {
      reranked: true,
      items,
      degraded: false,
      degradeReason: null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (e: any) {
    const reason = e?.name === "AbortError" ? "rerank_timeout" : `rerank_error: ${e?.message ?? e}`;
    console.error(`[knowledge:rerank] Rerank 失败: ${reason}`);
    return {
      reranked: false,
      items: params.documents.map((_, i) => ({ originalIndex: i, score: 0 })),
      degraded: true,
      degradeReason: reason,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
