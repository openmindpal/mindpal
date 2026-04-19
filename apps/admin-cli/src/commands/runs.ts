/**
 * runs 命令组 — 工作流运行管理
 *
 * 覆盖: runs/query, runs/execution, runs/recovery, runs/governance, runs/replan
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerRunsCommands(program: Command) {
  const runs = program.command("runs").description("工作流运行管理");

  // ── query ──────────────────────────────────────────────────────
  runs.command("list").description("列出运行").option("--limit <n>", "数量").option("--offset <n>", "偏移").option("--status <s>", "状态").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/runs${qs({ limit: _o.limit, offset: _o.offset, status: _o.status })}`), g.format);
  });

  runs.command("active").description("活跃运行").option("--limit <n>", "数量").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/runs/active${qs({ limit: _o.limit })}`), g.format);
  });

  runs.command("get <runId>").description("获取运行详情").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/runs/${encodeURIComponent(runId)}`), g.format);
  });

  runs.command("replay <runId>").description("运行回放").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/runs/${encodeURIComponent(runId)}/replay`), g.format);
  });

  runs.command("task-state <runId>").description("获取 TaskState").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/task-states/${encodeURIComponent(runId)}`), g.format);
  });

  runs.command("editable-steps <runId>").description("可编辑步骤").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/runs/${encodeURIComponent(runId)}/steps/editable`), g.format);
  });

  // ── recovery ───────────────────────────────────────────────────
  runs.command("cancel <runId>").description("取消运行").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/cancel`), g.format);
  });

  runs.command("retry <runId>").description("重试运行").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/retry`), g.format);
  });

  runs.command("pause <runId>").description("暂停运行").option("--reason <r>", "原因").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/pause`, { reason: _o.reason }), g.format);
  });

  runs.command("resume <runId>").description("恢复运行").option("--reason <r>", "原因").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/resume`, { reason: _o.reason }), g.format);
  });

  runs.command("skip <runId>").description("跳过当前步骤").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/skip`), g.format);
  });

  // ── execution ──────────────────────────────────────────────────
  runs.command("reexec <runId>").description("重新执行运行").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/reexec`), g.format);
  });

  runs.command("approve <runId>").description("批准运行").option("--reason <r>", "批准原因").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/approve`, { reason: _o.reason }), g.format);
  });

  runs.command("reject <runId>").description("拒绝运行").option("--reason <r>", "拒绝原因").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/reject`, { reason: _o.reason }), g.format);
  });

  // ── replan ─────────────────────────────────────────────────────
  runs.command("replan <runId>").description("重新规划").requiredOption("--cursor <n>", "当前游标").requiredOption("--steps-json <json>", "新步骤 JSON 数组").option("--keep-pending", "保留 pending 步骤").option("--reason <r>", "原因").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/replan`, { currentCursor: Number(_o.cursor), newSteps: JSON.parse(_o.stepsJson), keepPendingSteps: _o.keepPending ?? false, reason: _o.reason }), g.format);
  });

  runs.command("step-insert <runId>").description("插入步骤").requiredOption("--tool-ref <ref>", "工具引用").option("--position <p>", "位置: before|after|append", "append").option("--anchor-step-id <id>", "锚点步骤").option("--reason <r>", "原因").action(async (runId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/steps/insert`, { toolRef: _o.toolRef, position: _o.position, anchorStepId: _o.anchorStepId, reason: _o.reason }), g.format);
  });

  runs.command("step-remove <runId> <stepId>").description("移除步骤").option("--reason <r>", "原因").action(async (runId, stepId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/remove`, { reason: _o.reason }), g.format);
  });

  // ── governance: deadletters ────────────────────────────────────
  const dl = runs.command("deadletters").description("死信队列管理");

  dl.command("list").description("列出死信").option("--tool-ref <ref>", "工具引用").option("--limit <n>", "数量").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/workflow/deadletters${qs({ toolRef: _o.toolRef, limit: _o.limit })}`), g.format);
  });

  dl.command("retry <stepId>").description("重试死信").action(async (stepId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/workflow/deadletters/${encodeURIComponent(stepId)}/retry`), g.format);
  });

  dl.command("cancel <stepId>").description("取消死信").action(async (stepId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/workflow/deadletters/${encodeURIComponent(stepId)}/cancel`), g.format);
  });

  // ── governance: steps ──────────────────────────────────────────
  const steps = runs.command("steps").description("步骤治理");

  steps.command("reveal <stepId>").description("解密步骤输出").action(async (stepId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/workflow/steps/${encodeURIComponent(stepId)}/output/reveal`), g.format);
  });

  steps.command("compensate <stepId>").description("补偿步骤").action(async (stepId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/workflow/steps/${encodeURIComponent(stepId)}/compensate`), g.format);
  });

  steps.command("compensations <stepId>").description("查看补偿记录").action(async (stepId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/workflow/steps/${encodeURIComponent(stepId)}/compensations`), g.format);
  });

  // ── governance: compensations ──────────────────────────────────
  const comp = runs.command("compensations").description("补偿管理");

  comp.command("retry <compensationId>").description("重试补偿").action(async (compensationId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/workflow/compensations/${encodeURIComponent(compensationId)}/retry`), g.format);
  });

  comp.command("cancel <compensationId>").description("取消补偿").action(async (compensationId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/workflow/compensations/${encodeURIComponent(compensationId)}/cancel`), g.format);
  });
}
