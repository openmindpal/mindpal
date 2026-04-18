/**
 * audit 命令组 — 审计日志 + 法律保留 + 导出 + SIEM
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerAuditCommands(program: Command) {
  const audit = program.command("audit").description("审计日志管理");

  audit.command("list").description("查询审计事件").option("--trace-id <id>").option("--subject-id <id>").option("--action <a>").option("--from <iso>").option("--to <iso>").option("--limit <n>").option("--offset <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/audit${qs({ traceId: _o.traceId, subjectId: _o.subjectId, action: _o.action, from: _o.from, to: _o.to, limit: _o.limit, offset: _o.offset })}`), g.format);
  });

  audit.command("verify").description("哈希链验证").option("--from <iso>").option("--to <iso>").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/audit/verify${qs({ from: _o.from, to: _o.to, limit: _o.limit })}`), g.format);
  });

  audit.command("hashchain-verify").description("治理哈希链验证").option("--from <iso>").option("--to <iso>").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/audit/hashchain/verify${qs({ from: _o.from, to: _o.to, limit: _o.limit })}`), g.format);
  });

  // ── legal holds ────────────────────────────────────────────────
  const lh = audit.command("legal-holds").description("法律保留");

  lh.command("list").description("列出保留").option("--status <s>", "active|released").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/audit/legal-holds${qs({ status: _o.status, limit: _o.limit })}`), g.format);
  });

  lh.command("create").description("创建保留").requiredOption("--scope-type <t>", "tenant|space").requiredOption("--reason <r>", "原因").option("--scope-id <id>").option("--from <iso>").option("--to <iso>").option("--subject-id <id>").option("--trace-id <id>").option("--run-id <id>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/audit/legal-holds", { scopeType: _o.scopeType, scopeId: _o.scopeId, from: _o.from, to: _o.to, subjectId: _o.subjectId, traceId: _o.traceId, runId: _o.runId, reason: _o.reason }), g.format);
  });

  lh.command("release <holdId>").description("释放保留").action(async (holdId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/audit/legal-holds/${encodeURIComponent(holdId)}/release`), g.format);
  });

  // ── exports ────────────────────────────────────────────────────
  const exp = audit.command("exports").description("审计导出");

  exp.command("list").description("列出导出").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/audit/exports${qs({ limit: _o.limit })}`), g.format);
  });

  exp.command("get <exportId>").description("获取导出详情").action(async (exportId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/audit/exports/${encodeURIComponent(exportId)}`), g.format);
  });

  exp.command("create").description("创建导出").option("--from <iso>").option("--to <iso>").option("--action <a>").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/audit/exports", { from: _o.from, to: _o.to, action: _o.action, limit: _o.limit ? Number(_o.limit) : undefined }), g.format);
  });

  // ── SIEM ───────────────────────────────────────────────────────
  const siem = audit.command("siem").description("SIEM 目标管理");

  siem.command("list").description("列出 SIEM 目标").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/audit/siem-destinations${qs({ limit: _o.limit })}`), g.format);
  });

  siem.command("create").description("创建 SIEM 目标").requiredOption("--name <n>", "名称").requiredOption("--secret-id <id>", "密钥ID").option("--enabled", "启用").option("--batch-size <n>").option("--timeout-ms <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/audit/siem-destinations", { name: _o.name, secretId: _o.secretId, enabled: _o.enabled ?? false, batchSize: _o.batchSize ? Number(_o.batchSize) : undefined, timeoutMs: _o.timeoutMs ? Number(_o.timeoutMs) : undefined }), g.format);
  });

  siem.command("update").description("更新 SIEM 目标").requiredOption("--id <id>", "目标ID").option("--name <n>").option("--secret-id <id>").option("--enabled").option("--batch-size <n>").option("--timeout-ms <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    const body: any = { id: _o.id };
    if (_o.name) body.name = _o.name;
    if (_o.secretId) body.secretId = _o.secretId;
    if (_o.enabled !== undefined) body.enabled = Boolean(_o.enabled);
    if (_o.batchSize) body.batchSize = Number(_o.batchSize);
    if (_o.timeoutMs) body.timeoutMs = Number(_o.timeoutMs);
    printResult(await apiPut(o, "/audit/siem-destinations", body), g.format);
  });

  siem.command("test <id>").description("测试 SIEM 目标").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/audit/siem-destinations/${encodeURIComponent(id)}/test`), g.format);
  });

  siem.command("backfill <id>").description("回填 SIEM 目标").option("--from-timestamp <ts>").option("--from-event-id <id>").option("--clear-outbox").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/audit/siem-destinations/${encodeURIComponent(id)}/backfill`, { fromTimestamp: _o.fromTimestamp, fromEventId: _o.fromEventId, clearOutbox: _o.clearOutbox ?? true }), g.format);
  });

  siem.command("dlq <id>").description("查看死信队列").option("--limit <n>").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/audit/siem-destinations/${encodeURIComponent(id)}/dlq${qs({ limit: _o.limit })}`), g.format);
  });

  siem.command("dlq-clear <id>").description("清空死信队列").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/audit/siem-destinations/${encodeURIComponent(id)}/dlq/clear`), g.format);
  });

  siem.command("dlq-requeue <id>").description("重入队死信").option("--limit <n>").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/audit/siem-destinations/${encodeURIComponent(id)}/dlq/requeue`, { limit: _o.limit ? Number(_o.limit) : undefined }), g.format);
  });
}
