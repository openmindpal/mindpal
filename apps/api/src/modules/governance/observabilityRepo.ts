import type { Pool } from "pg";

export type ObservabilitySummary = {
  window: "1h" | "24h";
  routes: Array<{ key: string; total: number; success: number; denied: number; error: number; p50Ms: number | null; p95Ms: number | null }>;
  sync: Array<{ spaceId: string | null; pushes: number; ops: number; conflicts: number; conflictRate: number | null }>;
  knowledge: { searches: number; ok: number; denied: number; error: number; emptyResults: number };
  topErrors: Array<{ errorCategory: string | null; key: string; count: number; sampleTraceId: string }>;
};

function windowToInterval(window: "1h" | "24h") {
  return window === "24h" ? "24 hours" : "1 hour";
}

export async function getObservabilitySummary(params: { pool: Pool; tenantId: string; window: "1h" | "24h" }): Promise<ObservabilitySummary> {
  const interval = windowToInterval(params.window);

  const routesRes = await params.pool.query(
    `
      SELECT
        resource_type,
        action,
        COUNT(*)::int AS total,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END)::int AS success,
        SUM(CASE WHEN result = 'denied' THEN 1 ELSE 0 END)::int AS denied,
        SUM(CASE WHEN result = 'error' THEN 1 ELSE 0 END)::int AS error,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND latency_ms IS NOT NULL
      GROUP BY resource_type, action
      ORDER BY total DESC
      LIMIT 80
    `,
    [params.tenantId, interval],
  );

  const syncRes = await params.pool.query(
    `
      SELECT
        space_id,
        COUNT(*)::int AS pushes,
        COALESCE(SUM(NULLIF((output_digest->>'opCount')::int, NULL)), 0)::int AS ops,
        COALESCE(SUM(NULLIF((output_digest->>'conflicts')::int, NULL)), 0)::int AS conflicts
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND resource_type = 'sync'
        AND action = 'push'
        AND result = 'success'
      GROUP BY space_id
      ORDER BY pushes DESC
      LIMIT 50
    `,
    [params.tenantId, interval],
  );

  const knowledgeRes = await params.pool.query(
    `
      SELECT
        COUNT(*)::int AS searches,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END)::int AS ok,
        SUM(CASE WHEN result = 'denied' THEN 1 ELSE 0 END)::int AS denied,
        SUM(CASE WHEN result = 'error' THEN 1 ELSE 0 END)::int AS error,
        SUM(CASE WHEN result = 'success' AND COALESCE((output_digest->>'returnedCount')::int, 0) = 0 THEN 1 ELSE 0 END)::int AS empty_results
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND resource_type = 'knowledge'
        AND action = 'search'
    `,
    [params.tenantId, interval],
  );

  const topErrRes = await params.pool.query(
    `
      SELECT
        error_category,
        resource_type,
        action,
        COUNT(*)::int AS c,
        MIN(trace_id) AS sample_trace_id
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND result <> 'success'
      GROUP BY error_category, resource_type, action
      ORDER BY c DESC
      LIMIT 30
    `,
    [params.tenantId, interval],
  );

  return {
    window: params.window,
    routes: routesRes.rows.map((r) => ({
      key: `${r.resource_type}.${r.action}`,
      total: Number(r.total ?? 0),
      success: Number(r.success ?? 0),
      denied: Number(r.denied ?? 0),
      error: Number(r.error ?? 0),
      p50Ms: r.p50_ms == null ? null : Math.round(Number(r.p50_ms)),
      p95Ms: r.p95_ms == null ? null : Math.round(Number(r.p95_ms)),
    })),
    sync: syncRes.rows.map((r) => {
      const ops = Number(r.ops ?? 0);
      const conflicts = Number(r.conflicts ?? 0);
      return {
        spaceId: r.space_id ? String(r.space_id) : null,
        pushes: Number(r.pushes ?? 0),
        ops,
        conflicts,
        conflictRate: ops > 0 ? Math.round((conflicts / ops) * 10000) / 10000 : null,
      };
    }),
    knowledge: {
      searches: Number(knowledgeRes.rows[0]?.searches ?? 0),
      ok: Number(knowledgeRes.rows[0]?.ok ?? 0),
      denied: Number(knowledgeRes.rows[0]?.denied ?? 0),
      error: Number(knowledgeRes.rows[0]?.error ?? 0),
      emptyResults: Number(knowledgeRes.rows[0]?.empty_results ?? 0),
    },
    topErrors: topErrRes.rows.map((r) => ({
      errorCategory: r.error_category ? String(r.error_category) : null,
      key: `${r.resource_type}.${r.action}`,
      count: Number(r.c ?? 0),
      sampleTraceId: String(r.sample_trace_id ?? ""),
    })),
  };
}

