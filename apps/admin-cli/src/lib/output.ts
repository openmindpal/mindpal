/**
 * 输出格式化模块 — 支持 json / table 两种格式
 */
import type { ApiResponse } from "./apiClient";

export type OutputFormat = "json" | "table";

/** 打印 API 响应结果，失败时设置进程退出码 */
export function printResult(res: ApiResponse, format: OutputFormat = "json"): void {
  if (!res.ok) {
    console.error(JSON.stringify({ status: res.status, error: res.data }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (format === "table" && res.data && typeof res.data === "object") {
    const d = res.data as any;
    // 尝试找到数组字段用 console.table 展示
    const arrayKey = Object.keys(d).find((k) => Array.isArray(d[k]));
    if (arrayKey && d[arrayKey].length > 0) {
      console.table(d[arrayKey]);
      // 打印非数组字段
      const rest = Object.fromEntries(Object.entries(d).filter(([k]) => k !== arrayKey));
      if (Object.keys(rest).length > 0) console.log(JSON.stringify(rest, null, 2));
      return;
    }
  }
  console.log(JSON.stringify(res.data, null, 2));
}

/** 简单 JSON 输出 */
export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}
