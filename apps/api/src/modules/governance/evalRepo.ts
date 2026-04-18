import type { Pool, PoolClient } from "pg";

export type EvalSuiteRow = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  casesJson: any[];
  thresholds: any;
  createdAt: string;
  updatedAt: string;
};

export type EvalRunRow = {
  id: string;
  tenantId: string;
  suiteId: string;
  changesetId: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  summary: any;
  evidenceDigest: any;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
};

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw e;
  } finally {
    client.release();
  }
}

function toSuite(r: any): EvalSuiteRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    description: r.description,
    casesJson: r.cases_json ?? [],
    thresholds: r.thresholds ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r: any): EvalRunRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    suiteId: r.suite_id,
    changesetId: r.changeset_id,
    status: r.status,
    summary: r.summary ?? {},
    evidenceDigest: r.evidence_digest ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
  };
}

export async function createEvalSuite(params: { pool: Pool; tenantId: string; name: string; description?: string | null; casesJson: any[]; thresholds: any }) {
  const casesJson = JSON.stringify(params.casesJson ?? []);
  const thresholds = JSON.stringify(params.thresholds ?? {});
  const res = await params.pool.query(
    `
      INSERT INTO eval_suites (tenant_id, name, description, cases_json, thresholds)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
      RETURNING *
    `,
    [params.tenantId, params.name, params.description ?? null, casesJson, thresholds],
  );
  return toSuite(res.rows[0]);
}

export async function updateEvalSuite(params: { pool: Pool; tenantId: string; id: string; description?: string | null; casesJson?: any[]; thresholds?: any }) {
  const patch: string[] = [];
  const args: any[] = [params.tenantId, params.id];
  let idx = 3;

  if (params.description !== undefined) {
    patch.push(`description = $${idx++}`);
    args.push(params.description);
  }
  if (params.casesJson !== undefined) {
    patch.push(`cases_json = $${idx++}::jsonb`);
    args.push(JSON.stringify(params.casesJson));
  }
  if (params.thresholds !== undefined) {
    patch.push(`thresholds = $${idx++}::jsonb`);
    args.push(JSON.stringify(params.thresholds));
  }
  if (!patch.length) {
    const cur = await getEvalSuite({ pool: params.pool, tenantId: params.tenantId, id: params.id });
    if (!cur) throw new Error("suite_not_found");
    return cur;
  }

  const res = await params.pool.query(
    `
      UPDATE eval_suites
      SET ${patch.join(", ")}, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `,
    args,
  );
  if (!res.rowCount) throw new Error("suite_not_found");
  return toSuite(res.rows[0]);
}

export async function getEvalSuite(params: { pool: Pool; tenantId: string; id: string }) {
  const res = await params.pool.query(
    `SELECT * FROM eval_suites WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [params.tenantId, params.id],
  );
  if (!res.rowCount) return null;
  return toSuite(res.rows[0]);
}

export async function listEvalSuites(params: { pool: Pool; tenantId: string; limit: number }) {
  const res = await params.pool.query(
    `SELECT * FROM eval_suites WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [params.tenantId, params.limit],
  );
  return res.rows.map(toSuite);
}

export async function createEvalRun(params: { pool: Pool; tenantId: string; suiteId: string; changesetId?: string | null; status: EvalRunRow["status"]; summary: any; evidenceDigest?: any }) {
  const summary = JSON.stringify(params.summary ?? {});
  const evidenceDigest = params.evidenceDigest === undefined ? null : JSON.stringify(params.evidenceDigest);
  const res = await params.pool.query(
    `
      INSERT INTO eval_runs (tenant_id, suite_id, changeset_id, status, summary, evidence_digest, finished_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb, CASE WHEN $4 IN ('succeeded','failed') THEN now() ELSE NULL END)
      RETURNING *
    `,
    [params.tenantId, params.suiteId, params.changesetId ?? null, params.status, summary, evidenceDigest],
  );
  return toRun(res.rows[0]);
}

export async function setEvalRunFinished(params: { pool: Pool; tenantId: string; id: string; status: "succeeded" | "failed"; summary: any; evidenceDigest?: any }) {
  const summary = JSON.stringify(params.summary ?? {});
  const evidenceDigest = params.evidenceDigest === undefined ? null : JSON.stringify(params.evidenceDigest);
  const res = await params.pool.query(
    `
      UPDATE eval_runs
      SET status = $3, summary = $4::jsonb, evidence_digest = $5::jsonb, finished_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `,
    [params.tenantId, params.id, params.status, summary, evidenceDigest],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function setEvalRunStatus(params: { pool: Pool; tenantId: string; id: string; status: "queued" | "running" | "succeeded" | "failed" }) {
  const res = await params.pool.query(
    `
      UPDATE eval_runs
      SET status = $3
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `,
    [params.tenantId, params.id, params.status],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function getEvalRun(params: { pool: Pool; tenantId: string; id: string }) {
  const res = await params.pool.query(
    `SELECT * FROM eval_runs WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [params.tenantId, params.id],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function listEvalRuns(params: { pool: Pool; tenantId: string; suiteId?: string; changesetId?: string; limit: number }) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  let idx = 2;
  if (params.suiteId) {
    where.push(`suite_id = $${idx++}`);
    args.push(params.suiteId);
  }
  if (params.changesetId) {
    where.push(`changeset_id = $${idx++}`);
    args.push(params.changesetId);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM eval_runs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `,
    [...args, params.limit],
  );
  return res.rows.map(toRun);
}

export async function replaceChangeSetEvalBindings(params: { pool: Pool; tenantId: string; changesetId: string; suiteIds: string[] }) {
  return withTransaction(params.pool, async (client) => {
    await client.query(
      `DELETE FROM changeset_eval_bindings WHERE tenant_id = $1 AND changeset_id = $2`,
      [params.tenantId, params.changesetId],
    );
    for (const suiteId of params.suiteIds) {
      await client.query(
        `
          INSERT INTO changeset_eval_bindings (tenant_id, changeset_id, suite_id)
          VALUES ($1,$2,$3)
          ON CONFLICT DO NOTHING
        `,
        [params.tenantId, params.changesetId, suiteId],
      );
    }
  });
}

export async function listChangeSetEvalBindings(params: { pool: Pool; tenantId: string; changesetId: string }) {
  const res = await params.pool.query(
    `
      SELECT suite_id
      FROM changeset_eval_bindings
      WHERE tenant_id = $1 AND changeset_id = $2
      ORDER BY created_at ASC
    `,
    [params.tenantId, params.changesetId],
  );
  return res.rows.map((r) => r.suite_id as string);
}

export async function getLatestSucceededEvalRun(params: { pool: Pool; tenantId: string; suiteId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM eval_runs
      WHERE tenant_id = $1 AND suite_id = $2 AND status = 'succeeded'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [params.tenantId, params.suiteId],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function getLatestEvalRunForChangeSet(params: { pool: Pool; tenantId: string; suiteId: string; changesetId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM eval_runs
      WHERE tenant_id = $1 AND suite_id = $2 AND changeset_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [params.tenantId, params.suiteId, params.changesetId],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function getActiveEvalRunForChangeSet(params: {
  pool: Pool;
  tenantId: string;
  suiteId: string;
  changesetId: string;
  reportDigest8?: string | null;
}) {
  const where: string[] = ["tenant_id = $1", "suite_id = $2", "changeset_id = $3", "status IN ('queued','running')"];
  const args: any[] = [params.tenantId, params.suiteId, params.changesetId];
  let idx = 4;
  if (params.reportDigest8) {
    where.push(`(summary->>'reportDigest8') = $${idx++}`);
    args.push(params.reportDigest8);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM eval_runs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    args,
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

// ── P2-7: 核心回归评测套件查询 ──────────────────────────────

/**
 * 查询标记为 core 的评测套件（thresholds->>'core' = 'true'）
 * 这些套件在任何 changeset release 时都强制执行，无需显式绑定。
 */
export async function listCoreEvalSuites(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM eval_suites
      WHERE tenant_id = $1
        AND (thresholds->>'core')::boolean = true
      ORDER BY created_at ASC
    `,
    [params.tenantId],
  );
  return res.rows.map(toSuite);
}

/**
 * 查询某 eval suite 的最新成功运行（全局，不限定 changeset）用于 core suite 的回归检查
 */
export async function getLatestSucceededEvalRunGlobal(params: { pool: Pool; tenantId: string; suiteId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM eval_runs
      WHERE tenant_id = $1 AND suite_id = $2 AND status = 'succeeded'
      ORDER BY finished_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.suiteId],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

// ── P2-9: Dashboard 聚合查询 ───────────────────────────────

/** 获取所有 suite 的概览（含最新 run 状态） */
export async function getEvalDashboardOverview(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query(
    `
      SELECT
        s.id AS suite_id,
        s.name AS suite_name,
        s.description,
        s.thresholds,
        s.created_at AS suite_created_at,
        s.updated_at AS suite_updated_at,
        (SELECT count(*) FROM eval_runs r WHERE r.tenant_id = s.tenant_id AND r.suite_id = s.id) AS total_runs,
        (SELECT count(*) FROM eval_runs r WHERE r.tenant_id = s.tenant_id AND r.suite_id = s.id AND r.status = 'succeeded') AS succeeded_runs,
        (SELECT count(*) FROM eval_runs r WHERE r.tenant_id = s.tenant_id AND r.suite_id = s.id AND r.status = 'failed') AS failed_runs,
        lr.id AS latest_run_id,
        lr.status AS latest_run_status,
        lr.summary AS latest_run_summary,
        lr.finished_at AS latest_run_finished_at
      FROM eval_suites s
      LEFT JOIN LATERAL (
        SELECT id, status, summary, finished_at
        FROM eval_runs
        WHERE tenant_id = s.tenant_id AND suite_id = s.id
        ORDER BY created_at DESC
        LIMIT 1
      ) lr ON true
      WHERE s.tenant_id = $1
      ORDER BY s.created_at DESC
    `,
    [params.tenantId],
  );
  return res.rows.map((r: any) => ({
    suiteId: r.suite_id,
    suiteName: r.suite_name,
    description: r.description,
    thresholds: r.thresholds ?? {},
    suiteCreatedAt: r.suite_created_at,
    suiteUpdatedAt: r.suite_updated_at,
    totalRuns: Number(r.total_runs),
    succeededRuns: Number(r.succeeded_runs),
    failedRuns: Number(r.failed_runs),
    latestRun: r.latest_run_id ? {
      id: r.latest_run_id,
      status: r.latest_run_status,
      summary: r.latest_run_summary ?? {},
      finishedAt: r.latest_run_finished_at,
    } : null,
  }));
}

/** 获取套件通过率趋势（按天聚合） */
export async function getEvalPassRateTrend(params: {
  pool: Pool;
  tenantId: string;
  suiteId?: string;
  days?: number;
}) {
  const days = params.days ?? 30;
  const args: any[] = [params.tenantId, days];
  let suiteFilter = "";
  if (params.suiteId) {
    suiteFilter = " AND r.suite_id = $3";
    args.push(params.suiteId);
  }
  const res = await params.pool.query(
    `
      SELECT
        date_trunc('day', r.finished_at) AS day,
        count(*) AS total_runs,
        count(*) FILTER (WHERE (r.summary->>'result') = 'pass') AS passed_runs,
        avg((r.summary->>'passRate')::numeric) FILTER (WHERE (r.summary->>'passRate') IS NOT NULL) AS avg_pass_rate
      FROM eval_runs r
      WHERE r.tenant_id = $1
        AND r.status = 'succeeded'
        AND r.finished_at >= now() - make_interval(days => $2)
        ${suiteFilter}
      GROUP BY date_trunc('day', r.finished_at)
      ORDER BY day ASC
    `,
    args,
  );
  return res.rows.map((r: any) => ({
    day: r.day,
    totalRuns: Number(r.total_runs),
    passedRuns: Number(r.passed_runs),
    avgPassRate: r.avg_pass_rate !== null ? Number(Number(r.avg_pass_rate).toFixed(4)) : null,
  }));
}

/** 获取失败用例详情 */
export async function getEvalFailedCases(params: {
  pool: Pool;
  tenantId: string;
  suiteId: string;
  runId?: string;
  limit?: number;
}) {
  const limit = params.limit ?? 50;
  let runId = params.runId;
  if (!runId) {
    const latest = await getLatestSucceededEvalRunGlobal({ pool: params.pool, tenantId: params.tenantId, suiteId: params.suiteId });
    runId = latest?.id;
  }
  if (!runId) return { runId: null, cases: [] };

  const res = await params.pool.query(
    `SELECT summary FROM eval_runs WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [params.tenantId, runId],
  );
  if (!res.rowCount) return { runId, cases: [] };

  const summary = res.rows[0].summary ?? {};
  const allCases = Array.isArray(summary.cases) ? summary.cases : [];
  const failedCases = allCases
    .filter((c: any) => {
      const isDeny = Boolean(c?.deny) || Boolean(c?.denied);
      const isFail = Boolean(c?.fail) || Boolean(c?.failed) || (typeof c?.passed === "boolean" && !c.passed);
      return isDeny || isFail;
    })
    .slice(0, limit);

  return { runId, cases: failedCases };
}

/** 获取套件的分类维度统计 */
export async function getEvalCategoryBreakdown(params: {
  pool: Pool;
  tenantId: string;
  suiteId: string;
}) {
  const suite = await getEvalSuite({ pool: params.pool, tenantId: params.tenantId, id: params.suiteId });
  if (!suite) return null;

  const casesJson = Array.isArray(suite.casesJson) ? suite.casesJson : [];
  const categoryMap: Record<string, { total: number; sampleInputs: string[] }> = {};
  for (const c of casesJson) {
    const cat = String((c as any)?.category ?? (c as any)?.source?.type ?? "unknown");
    if (!categoryMap[cat]) categoryMap[cat] = { total: 0, sampleInputs: [] };
    categoryMap[cat].total += 1;
    if (categoryMap[cat].sampleInputs.length < 3) {
      const input = String((c as any)?.input ?? (c as any)?.caseId ?? "").slice(0, 80);
      if (input) categoryMap[cat].sampleInputs.push(input);
    }
  }

  const latestRun = await getLatestSucceededEvalRunGlobal({ pool: params.pool, tenantId: params.tenantId, suiteId: params.suiteId });
  const breakdown = latestRun?.summary?.categoryBreakdown ?? {};

  return {
    suiteId: suite.id,
    suiteName: suite.name,
    totalCases: casesJson.length,
    categories: Object.entries(categoryMap).map(([cat, data]) => ({
      category: cat,
      totalCases: data.total,
      sampleInputs: data.sampleInputs,
      passRate: breakdown[cat]?.passRate ?? null,
      passed: breakdown[cat]?.passed ?? null,
    })),
    latestRunId: latestRun?.id ?? null,
  };
}
