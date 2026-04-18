/**
 * Agent Loop — 观察构建 + 步骤历史渲染
 */
import type { Pool } from "pg";
import type { StepObservation } from "./loopTypes";

/* ================================================================== */
/*  Observe — 收集上一步执行结果                                         */
/* ================================================================== */

export async function buildObservation(
  pool: Pool,
  runId: string,
  lastStepSeq?: number,
): Promise<StepObservation | null> {
  if (lastStepSeq === undefined || lastStepSeq < 1) return null;

  const res = await pool.query<{
    step_id: string;
    seq: number;
    tool_ref: string | null;
    status: string;
    output_digest: any;
    output: any;
    error_category: string | null;
    created_at: string | null;
    finished_at: string | null;
  }>(
    `SELECT step_id, seq, tool_ref, status, output_digest, output, error_category, created_at, finished_at
     FROM steps WHERE run_id = $1 AND seq = $2 LIMIT 1`,
    [runId, lastStepSeq],
  );

  if (!res.rowCount) return null;
  const row = res.rows[0];

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

/* ================================================================== */
/*  步骤历史滑动窗口                                                     */
/* ================================================================== */

/**
 * 步骤历史滑动窗口配置：
 * - RECENT_WINDOW: 保留完整输出的最近步骤数（环境变量可覆盖）
 * - COMPRESSED_OUTPUT_LIMIT: 压缩步骤的输出截取上限（字符数）
 * - RECENT_OUTPUT_LIMIT: 近期步骤的输出截取上限（字符数）
 */
const STEP_HISTORY_RECENT_WINDOW = Math.max(1, Number(process.env.AGENT_LOOP_RECENT_WINDOW ?? "3"));
const STEP_HISTORY_COMPRESSED_OUTPUT_LIMIT = Math.max(0, Number(process.env.AGENT_LOOP_COMPRESSED_OUTPUT_LIMIT ?? "80"));
const STEP_HISTORY_RECENT_OUTPUT_LIMIT = Math.max(50, Number(process.env.AGENT_LOOP_RECENT_OUTPUT_LIMIT ?? "400"));

/**
 * 将步骤列表分为"压缩历史"和"近期步骤"两部分。
 * - 近期步骤保留完整输出（供 LLM 精确决策）
 * - 早期步骤仅保留 status + toolRef + error 摘要（大幅降低 token 消耗）
 *
 * 当步骤数 <= RECENT_WINDOW 时，所有步骤均视为近期，不做压缩。
 */
export function compressStepHistory(steps: StepObservation[], recentWindow?: number): {
  compressed: StepObservation[];
  recent: StepObservation[];
  totalCount: number;
} {
  const window = recentWindow ?? STEP_HISTORY_RECENT_WINDOW;
  const totalCount = steps.length;
  if (totalCount <= window) {
    return { compressed: [], recent: steps, totalCount };
  }
  return {
    compressed: steps.slice(0, totalCount - window),
    recent: steps.slice(totalCount - window),
    totalCount,
  };
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
    if (step.errorCategory) line += ` (error: ${step.errorCategory})`;
    // 对压缩步骤：只保留极短的输出片段（仅供回溯参考）
    if (STEP_HISTORY_COMPRESSED_OUTPUT_LIMIT > 0) {
      const outputData = step.output ?? step.outputDigest;
      if (outputData) {
        const snippet = JSON.stringify(outputData).slice(0, STEP_HISTORY_COMPRESSED_OUTPUT_LIMIT);
        line += ` [${snippet}${JSON.stringify(outputData).length > STEP_HISTORY_COMPRESSED_OUTPUT_LIMIT ? "…" : ""}]`;
      }
    }
    lines.push(line);
  }
  const stats = `(${succeededCount} succeeded, ${failedCount} failed, ${steps.length - succeededCount - failedCount} other)`;
  return `### Earlier Steps Summary ${stats}\n${lines.join("\n")}\n`;
}

/**
 * 将近期步骤渲染为带完整输出的详细格式（供 LLM 精确决策）
 */
export function renderRecentSteps(steps: StepObservation[]): string {
  if (steps.length === 0) return "";
  const lines: string[] = [];
  for (const step of steps) {
    const statusIcon = step.status === "succeeded" ? "✅" : step.status === "failed" ? "❌" : "⏳";
    const outputData = step.output ?? step.outputDigest;
    const outputSummary = outputData
      ? JSON.stringify(outputData).slice(0, STEP_HISTORY_RECENT_OUTPUT_LIMIT)
      : "(no output)";
    let line = `${statusIcon} Step ${step.seq}: ${step.toolRef} → ${step.status}`;
    if (step.errorCategory) line += ` (error: ${step.errorCategory})`;
    line += `\n   Output: ${outputSummary}`;
    lines.push(line);
  }
  return `### Recent Steps (detailed)\n${lines.join("\n")}\n`;
}
