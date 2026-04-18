/**
 * jobs 命令组 — 作业管理
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerJobsCommands(program: Command) {
  const jobs = program.command("jobs").description("作业管理");

  jobs.command("create <entity>").description("创建实体作业").requiredOption("--idempotency-key <key>", "幂等键").option("--body-json <json>", "请求体 JSON").action(async (entity, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    const body = _o.bodyJson ? JSON.parse(_o.bodyJson) : {};
    printResult(await apiPost(o, `/jobs/entities/${encodeURIComponent(entity)}/create`, body, { "idempotency-key": _o.idempotencyKey }), g.format);
  });

  jobs.command("get <jobId>").description("获取作业详情").action(async (jobId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/jobs/${encodeURIComponent(jobId)}`), g.format);
  });
}
