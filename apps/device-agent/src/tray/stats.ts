/**
 * 托盘执行统计追踪模块
 */
import { safeLog } from "../log";

export interface ExecutionStats {
  totalExecuted: number;
  succeeded: number;
  failed: number;
  denied: number;
  lastExecutionTime: string | null;
  lastToolRef: string | null;
  confirmedByUser: number;
  autoConfirmed: number;
}

export const executionStats: ExecutionStats = {
  totalExecuted: 0,
  succeeded: 0,
  failed: 0,
  denied: 0,
  lastExecutionTime: null,
  lastToolRef: null,
  confirmedByUser: 0,
  autoConfirmed: 0,
};

export function recordExecution(toolRef: string, status: "succeeded" | "failed" | "denied", userConfirmed: boolean) {
  executionStats.totalExecuted++;
  if (status === "succeeded") executionStats.succeeded++;
  else if (status === "failed") executionStats.failed++;
  else if (status === "denied") executionStats.denied++;
  executionStats.lastExecutionTime = new Date().toISOString();
  executionStats.lastToolRef = toolRef;
  if (userConfirmed) executionStats.confirmedByUser++;
  else executionStats.autoConfirmed++;
  safeLog(`[托盘统计] tool=${toolRef} status=${status} userConfirmed=${userConfirmed} total=${executionStats.totalExecuted}`);
}
