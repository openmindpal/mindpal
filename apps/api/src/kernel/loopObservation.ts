/**
 * Agent Loop — 观察构建 + 步骤历史渲染
 */
import type { Pool } from "pg";
import type { StepObservation } from "./loopTypes";
import { errorActionHint, resolveNumber, resolveBoolean } from "@mindpal/shared";

export const AGENT_LOOP_BATCH_OBSERVE = process.env.AGENT_LOOP_BATCH_OBSERVE !== "false";

/* ================================================================== */
/*  Observe — 收集上一步执行结果                                         */
/* ================================================================== */

type StepRow = {
  step_id: string;
  seq: number;
  tool_ref: string | null;
  status: string;
  output_digest: any;
  output: any;
  error_category: string | null;
  created_at: string | null;
  finished_at: string | null;
};

const STEP_COLUMNS = `step_id, seq, tool_ref, status, output_digest, output, error_category, created_at, finished_at`;

function mapRow(row: StepRow): StepObservation {
  let durationMs: number | null = null;
  if (row.created_at && row.finished_at) {
    durationMs = Date.parse(row.finished_at) - Date.parse(row.created_at);
  }
  return {
    stepId: row.step_id,
    seq: row.seq,
    toolRef: row.tool_ref ?? "",
    status: row.status,
    outputDigest: row.output_digest ?? null,
    output: row.output ?? null,
    errorCategory: row.error_category ?? null,
    durationMs,
  };
}

export async function buildObservation(
  pool: Pool,
  runId: string,
  lastStepSeq?: number,
): Promise<{ observation: StepObservation | null; dbDurationMs: number }> {
  if (lastStepSeq === undefined || lastStepSeq < 1) return { observation: null, dbDurationMs: 0 };

  const dbStart = Date.now();
  const res = await pool.query<StepRow>(
    `SELECT ${STEP_COLUMNS} FROM steps WHERE run_id = $1 AND seq = $2 LIMIT 1`,
    [runId, lastStepSeq],
  );
  const dbDurationMs = Date.now() - dbStart;
  if (!res.rowCount) return { observation: null, dbDurationMs };
  return { observation: mapRow(res.rows[0]), dbDurationMs };
}

export async function buildObservationsBatch(
  pool: Pool,
  runId: string,
  afterSeq?: number,
): Promise<{ observations: StepObservation[]; dbDurationMs: number }> {
  const dbStart = Date.now();
  const res = await pool.query<StepRow>(
    `SELECT ${STEP_COLUMNS} FROM steps WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC`,
    [runId, afterSeq ?? 0],
  );
  const dbDurationMs = Date.now() - dbStart;
  return { observations: res.rows.map(mapRow), dbDurationMs };
}

/* ================================================================== */
/*  步骤历史滑动窗口                                                     */
/* ================================================================== */

/**
 * 步骤历史滑动窗口配置：
 * - RECENT_WINDOW: 保留完整输出的最近步骤数（环境变量可覆盖）
 * - COMPRESSED_OUTPUT_LIMIT: 压缩步骤的输出截取上限（字符数）
 * - RECENT_OUTPUT_LIMIT: 近期步骤的输出截取上限（字符数）
 */
const STEP_HISTORY_RECENT_WINDOW = resolveNumber("AGENT_LOOP_RECENT_WINDOW").value;
const STEP_HISTORY_COMPRESSED_OUTPUT_LIMIT = resolveNumber("AGENT_LOOP_COMPRESSED_OUTPUT_LIMIT").value;
const STEP_HISTORY_RECENT_OUTPUT_LIMIT = resolveNumber("AGENT_LOOP_RECENT_OUTPUT_LIMIT").value;
const STEP_HISTORY_FAILED_OUTPUT_LIMIT = resolveNumber("AGENT_LOOP_FAILED_OUTPUT_LIMIT").value;
const STEP_HISTORY_FAILED_PRESERVE = resolveBoolean("AGENT_LOOP_FAILED_PRESERVE").value;

/**
 * 将步骤列表分为"压缩历史"和"近期步骤"两部分。
 * - 近期步骤保留完整输出（供 LLM 精确决策）
 * - 早期步骤仅保留 status + toolRef + error 摘要（大幅降低 token 消耗）
 * - **失败/deadletter 步骤始终保留完整信息**（不参与压缩）
 *
 * 当步骤数 <= RECENT_WINDOW 时，所有步骤均视为近期，不做压缩。
 */
export function compressStepHistory(steps: StepObservation[], recentWindow?: number): {
  compressed: StepObservation[];
  recent: StepObservation[];
  preserved: StepObservation[];
  totalCount: number;
} {
  const window = recentWindow ?? STEP_HISTORY_RECENT_WINDOW;
  const totalCount = steps.length;
  if (totalCount <= window) {
    return { compressed: [], recent: steps, preserved: [], totalCount };
  }

  const earlySteps = steps.slice(0, totalCount - window);
  const recentSteps = steps.slice(totalCount - window);

  if (STEP_HISTORY_FAILED_PRESERVE) {
    const preserved: StepObservation[] = [];
    const compressed: StepObservation[] = [];
    for (const step of earlySteps) {
      if (step.status === "failed" || step.status === "deadletter") {
        preserved.push(step);
      } else {
        compressed.push(step);
      }
    }
    return { compressed, recent: recentSteps, preserved, totalCount };
  }

  return { compressed: earlySteps, recent: recentSteps, preserved: [], totalCount };
}

/**
 * 将压缩步骤渲染为单行摘要格式（极低 token 消耗）
 */
export function renderCompressedSteps(steps: StepObservation[]): string {
  if (steps.length === 0) return "";
  const lines: string[] = [];
  let succeededCount = 0;
  let failedCount = 0;
  for (const step of steps) {
    if (step.status === "succeeded") succeededCount++;
    else if (step.status === "failed") failedCount++;
    const icon = step.status === "succeeded" ? "✅" : step.status === "failed" ? "❌" : "⏳";
    let line = `${icon} Step ${step.seq}: ${step.toolRef} → ${step.status}`;
    if (step.errorCategory) {
      const hint = errorActionHint(step.errorCategory);
      line += ` (error: ${step.errorCategory})${hint ? " " + hint : ""}`;
    }
    // 根据步骤状态选择不同的截断限制
    const outputLimit = (step.status === "failed" || step.status === "deadletter")
      ? STEP_HISTORY_FAILED_OUTPUT_LIMIT
      : STEP_HISTORY_COMPRESSED_OUTPUT_LIMIT;
    if (outputLimit > 0) {
      const outputData = step.output ?? step.outputDigest;
      if (outputData) {
        const raw = JSON.stringify(outputData);
        const snippet = raw.slice(0, outputLimit);
        line += ` [${snippet}${raw.length > outputLimit ? "…" : ""}]`;
      }
    }
    lines.push(line);
  }
  const stats = `(${succeededCount} succeeded, ${failedCount} failed, ${steps.length - succeededCount - failedCount} other)`;
  return `### Earlier Steps Summary ${stats}\n${lines.join("\n")}\n`;
}

/**
 * 将近期步骤渲染为带完整输出的详细格式（供 LLM 精确决策）
 * @param labelPrefix 可选前缀标签，用于区分历史失败步骤等
 */
export function renderRecentSteps(steps: StepObservation[], labelPrefix?: string): string {
  if (steps.length === 0) return "";
  const prefix = labelPrefix ?? "";
  const lines: string[] = [];
  for (const step of steps) {
    const statusIcon = step.status === "succeeded" ? "✅" : step.status === "failed" ? "❌" : "⏳";
    const outputData = step.output ?? step.outputDigest;
    const outputSummary = outputData
      ? JSON.stringify(outputData).slice(0, STEP_HISTORY_RECENT_OUTPUT_LIMIT)
      : "(no output)";
    let line = `${prefix}${statusIcon} Step ${step.seq}: ${step.toolRef} → ${step.status}`;
    if (step.errorCategory) {
      const hint = errorActionHint(step.errorCategory);
      line += ` (error: ${step.errorCategory})${hint ? " " + hint : ""}`;
    }
    line += `\n   Output: ${outputSummary}`;
    lines.push(line);
  }
  const header = labelPrefix ? `### Preserved Failed Steps (detailed)` : `### Recent Steps (detailed)`;
  return `${header}\n${lines.join("\n")}\n`;
}
