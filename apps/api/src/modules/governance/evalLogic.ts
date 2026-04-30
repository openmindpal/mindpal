export type EvalThresholds = {
  passRateMin?: number;
  denyRateMax?: number;
  sealRequired?: boolean;
  /** 标记为核心回归套件，release 时强制检查 */
  core?: boolean;
  /** 分类级别阈值：{ "intent": { passRateMin: 0.9 } } */
  categoryThresholds?: Record<string, { passRateMin?: number; denyRateMax?: number }>;
  /** 允许的最大过期时间(小时)，超过则视为过期需重新运行 */
  maxStaleHours?: number;
};

export type EvalRunSummary = {
  totalCases?: number;
  passedCases?: number;
  deniedCases?: number;
  failedCases?: number;
  passRate?: number;
  denyRate?: number;
  reportDigest8?: string;
  result?: "pass" | "fail";
  thresholds?: { passRateMin: number; denyRateMax: number };
  /** 分类维度汇总 */
  categoryBreakdown?: Record<string, { total: number; passed: number; passRate: number }>;
};

export function evalPassed(params: { thresholds: EvalThresholds | null | undefined; summary: EvalRunSummary | null | undefined }) {
  const thresholds = params.thresholds ?? {};
  const minPassRate = typeof thresholds.passRateMin === "number" ? thresholds.passRateMin : 1;
  const maxDenyRate = typeof thresholds.denyRateMax === "number" ? thresholds.denyRateMax : 1;
  const passRate = typeof params.summary?.passRate === "number" ? params.summary.passRate : 0;
  const denyRate = typeof params.summary?.denyRate === "number" ? params.summary.denyRate : 0;
  return passRate >= minPassRate && denyRate <= maxDenyRate;
}

export function computeEvalSummary(params: { casesJson: any[]; thresholds: EvalThresholds | null | undefined; reportDigest8: string }) {
  const totalCases = params.casesJson.length;
  let passedCases = 0;
  let deniedCases = 0;
  let failedCases = 0;

  const sealRequired = Boolean(params.thresholds?.sealRequired);

  for (const c of params.casesJson) {
    const expectedConstraints = c && typeof c === "object" ? (c as any).expectedConstraints : null;
    const isDeny =
      Boolean((c as any)?.deny) ||
      Boolean((c as any)?.denied) ||
      Boolean((c as any)?.expectedDeny) ||
      Boolean(expectedConstraints?.deny) ||
      Boolean(expectedConstraints?.denied) ||
      Boolean(expectedConstraints?.expectedDeny) ||
      String(expectedConstraints?.outcome ?? "").toLowerCase() === "deny" ||
      (sealRequired && String((c as any)?.sealStatus ?? "") !== "sealed");

    const isFail =
      Boolean((c as any)?.fail) ||
      Boolean((c as any)?.failed) ||
      (typeof (c as any)?.passed === "boolean" && !(c as any).passed) ||
      (typeof (c as any)?.denied === "boolean" && !(c as any).denied && typeof (c as any)?.passed === "boolean" && !(c as any).passed) ||
      Boolean(expectedConstraints?.fail) ||
      Boolean(expectedConstraints?.failed) ||
      Boolean(expectedConstraints?.forceFail) ||
      expectedConstraints?.pass === false ||
      String(expectedConstraints?.outcome ?? "").toLowerCase() === "fail";

    if (isDeny) {
      deniedCases += 1;
      continue;
    }
    if (isFail) {
      failedCases += 1;
      continue;
    }
    passedCases += 1;
  }

  const passRate = totalCases > 0 ? passedCases / totalCases : 0;
  const denyRate = totalCases > 0 ? deniedCases / totalCases : 0;
  const minPassRate = typeof params.thresholds?.passRateMin === "number" ? params.thresholds!.passRateMin! : 1;
  const maxDenyRate = typeof params.thresholds?.denyRateMax === "number" ? params.thresholds!.denyRateMax! : 1;
  const result = evalPassed({ thresholds: params.thresholds, summary: { passRate, denyRate } }) ? "pass" : "fail";

  return {
    totalCases,
    passedCases,
    deniedCases,
    failedCases,
    passRate,
    denyRate,
    reportDigest8: params.reportDigest8,
    result,
    thresholds: { passRateMin: minPassRate, denyRateMax: maxDenyRate },
  } satisfies EvalRunSummary;
}

// ── P2-7: 回归评测门禁增强 ─────────────────────────────────

/** 分类级别阈值检查 */
export function evalPassedWithCategories(params: {
  thresholds: EvalThresholds | null | undefined;
  summary: EvalRunSummary | null | undefined;
}): { passed: boolean; failedCategories: string[]; details: string[] } {
  const details: string[] = [];
  const failedCategories: string[] = [];

  // 1. 全局通过率检查
  const globalPassed = evalPassed(params);
  if (!globalPassed) {
    const passRate = params.summary?.passRate ?? 0;
    const minPassRate = params.thresholds?.passRateMin ?? 1;
    details.push(`全局通过率不足: ${(passRate * 100).toFixed(1)}% < ${(minPassRate * 100).toFixed(1)}%`);
  }

  // 2. 分类级别阈值检查
  const catThresholds = params.thresholds?.categoryThresholds;
  const catBreakdown = params.summary?.categoryBreakdown;
  if (catThresholds && catBreakdown) {
    for (const [cat, catThreshold] of Object.entries(catThresholds)) {
      const catData = catBreakdown[cat];
      if (!catData) {
        failedCategories.push(cat);
        details.push(`分类 [${cat}] 无评测数据`);
        continue;
      }
      const minRate = catThreshold.passRateMin ?? 0;
      if (catData.passRate < minRate) {
        failedCategories.push(cat);
        details.push(`分类 [${cat}] 通过率不足: ${(catData.passRate * 100).toFixed(1)}% < ${(minRate * 100).toFixed(1)}%`);
      }
    }
  }

  return {
    passed: globalPassed && failedCategories.length === 0,
    failedCategories,
    details,
  };
}

/** 检查 eval run 是否过期 */
export function isEvalRunStale(params: {
  runFinishedAt: string | null | undefined;
  maxStaleHours: number;
}): boolean {
  if (!params.runFinishedAt) return true;
  const finishedAt = new Date(params.runFinishedAt).getTime();
  if (isNaN(finishedAt)) return true;
  const now = Date.now();
  const staleMs = params.maxStaleHours * 60 * 60 * 1000;
  return (now - finishedAt) > staleMs;
}

/** 构建详细的 eval gate 失败报告 */
export function buildEvalGateReport(params: {
  suiteId: string;
  suiteName?: string;
  reason: "missing" | "stale" | "failed" | "running" | "threshold_not_met" | "category_threshold_not_met";
  details?: string[];
  runId?: string | null;
  passRate?: number;
  categoryFailures?: string[];
}): EvalGateFailure {
  return {
    suiteId: params.suiteId,
    suiteName: params.suiteName,
    reason: params.reason,
    details: params.details ?? [],
    runId: params.runId ?? null,
    passRate: params.passRate,
    categoryFailures: params.categoryFailures,
  };
}

export type EvalGateFailure = {
  suiteId: string;
  suiteName?: string;
  reason: "missing" | "stale" | "failed" | "running" | "threshold_not_met" | "category_threshold_not_met";
  details: string[];
  runId?: string | null;
  passRate?: number;
  categoryFailures?: string[];
};

