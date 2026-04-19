/**
 * Run 响应 DTO —— 统一 /runs、/runs/active、/runs/:runId 的返回格式
 */

/**
 * Run 摘要 DTO —— /runs 和 /runs/active 返回的统一格式
 */
export interface RunSummaryDTO {
  runId: string;
  status: string;
  phase: string | null;
  createdAt: string;
  updatedAt: string;
  traceId: string | null;
  trigger: string | null;
  jobType: string | null;
  /** 步骤进度 */
  progress: {
    current: number;
    total: number;
    percentage: number;
  };
  /** 当前正在执行的步骤（如有） */
  currentStep: {
    stepId: string;
    seq: number;
    status: string;
    toolRef: string | null;
    name: string | null;
    attempt: number;
  } | null;
  durationMs: number | null;
  outputDigest: unknown | null;
  errorDigest: unknown | null;
}

/**
 * Run 详情 DTO —— /runs/:runId 返回的扩展格式
 */
export interface RunDetailDTO extends RunSummaryDTO {
  steps: RunStepDTO[];
  blockReason: string | null;
  nextAction: string | null;
  createdBySubjectId: string | null;
  idempotencyKey: string | null;
}

/**
 * 步骤 DTO
 */
export interface RunStepDTO {
  stepId: string;
  seq: number;
  status: string;
  toolRef: string | null;
  inputDigest: unknown | null;
  outputDigest: unknown | null;
  errorCategory: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}
