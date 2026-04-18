import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

/* ── 模块10: changesets ── */
export function registerChangesetsCommands(parent: Command) {
  const cmd = parent.command("changesets").description("变更集管理");
  cmd.command("list").description("列出变更集").option("--scope <s>", "tenant|space").option("--limit <n>", "条数")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/changesets${qs({ scope: o.scope, limit: o.limit })}`), g.format); });
  cmd.command("get").description("获取变更集").requiredOption("--id <id>", "变更集 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}`), g.format); });
  cmd.command("create").description("创建变更集").requiredOption("--title <title>", "标题").option("--scope <s>", "tenant|space")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), "/governance/changesets", { title: o.title, scope: o.scope }), g.format); });
  cmd.command("add-item").description("添加变更项").requiredOption("--id <id>", "变更集 ID").requiredOption("--data <json>", "变更项 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/items`, JSON.parse(o.data)), g.format); });
  cmd.command("submit").description("提交变更集").requiredOption("--id <id>", "变更集 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/submit`), g.format); });
  cmd.command("approve").description("审批变更集").requiredOption("--id <id>", "变更集 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/approve`), g.format); });
  cmd.command("release").description("发布变更集").requiredOption("--id <id>", "变更集 ID").option("--mode <mode>", "full|canary")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/release${qs({ mode: o.mode })}`), g.format); });
  cmd.command("preflight").description("预检变更集").requiredOption("--id <id>", "变更集 ID").option("--mode <mode>", "full|canary")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/preflight${qs({ mode: o.mode })}`), g.format); });
  cmd.command("pipeline").description("变更集流水线").requiredOption("--id <id>", "变更集 ID").option("--mode <mode>", "full|canary")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/pipeline${qs({ mode: o.mode })}`), g.format); });
  cmd.command("pipelines").description("全部流水线").option("--scope <s>", "tenant|space").option("--mode <mode>", "full|canary")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/changesets/pipelines${qs({ scope: o.scope, mode: o.mode })}`), g.format); });
  cmd.command("promote").description("灰度升级全量").requiredOption("--id <id>", "变更集 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/promote`), g.format); });
  cmd.command("rollback").description("回滚变更集").requiredOption("--id <id>", "变更集 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/rollback`), g.format); });
  cmd.command("system-status").description("系统状态汇总").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/system-status"), g.format); });

  const ev = cmd.command("evals").description("变更集评测绑定");
  ev.command("bind").description("绑定评测套件").requiredOption("--id <id>", "变更集 ID").requiredOption("--data <json>", "绑定 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/evals/bind`, JSON.parse(o.data)), g.format); });
  ev.command("list").description("列出评测绑定").requiredOption("--id <id>", "变更集 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/evals`), g.format); });
  ev.command("execute").description("执行评测").requiredOption("--id <id>", "变更集 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/changesets/${encodeURIComponent(o.id)}/evals/execute`), g.format); });
}

/* ── 模块11: evals ── */
export function registerEvalsCommands(parent: Command) {
  const cmd = parent.command("evals").description("评测管理");
  const suites = cmd.command("suites").description("评测套件");
  suites.command("list").description("列出套件").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/evals/suites"), g.format); });
  suites.command("get").description("获取套件").requiredOption("--id <id>", "套件 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/evals/suites/${encodeURIComponent(o.id)}`), g.format); });
  suites.command("create").description("创建套件").requiredOption("--data <json>", "套件 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), "/governance/evals/suites", JSON.parse(o.data)), g.format); });
  suites.command("update").description("更新套件").requiredOption("--id <id>", "套件 ID").requiredOption("--data <json>", "更新 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPut(toApiOpts(g), `/governance/evals/suites/${encodeURIComponent(o.id)}`, JSON.parse(o.data)), g.format); });
  suites.command("from-replay").description("从回放生成用例").requiredOption("--id <id>", "套件 ID").requiredOption("--data <json>", "回放 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/evals/suites/${encodeURIComponent(o.id)}/cases/from-replay`, JSON.parse(o.data)), g.format); });
  suites.command("run").description("执行评测").requiredOption("--id <id>", "套件 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/evals/suites/${encodeURIComponent(o.id)}/runs`), g.format); });

  const runs = cmd.command("runs").description("评测运行");
  runs.command("list").description("列出运行").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/evals/runs"), g.format); });
  runs.command("get").description("获取运行").requiredOption("--id <id>", "运行 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/evals/runs/${encodeURIComponent(o.id)}`), g.format); });
  cmd.command("metrics").description("评测指标").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/evals/metrics"), g.format); });

  const dash = cmd.command("dashboard").description("评测看板");
  dash.command("overview").description("总览").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/evals/dashboard/overview"), g.format); });
  dash.command("trend").description("通过率趋势").option("--suite-id <id>", "套件 ID").option("--days <n>", "天数")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/evals/dashboard/trend${qs({ suiteId: o.suiteId, days: o.days })}`), g.format); });
  dash.command("failures").description("失败用例").requiredOption("--suite-id <id>", "套件 ID").option("--run-id <id>", "运行 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/evals/dashboard/failures/${encodeURIComponent(o.suiteId)}${qs({ runId: o.runId })}`), g.format); });
  dash.command("categories").description("分类统计").requiredOption("--suite-id <id>", "套件 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/evals/dashboard/categories/${encodeURIComponent(o.suiteId)}`), g.format); });
}

/* ── 模块12: policy ── */
export function registerPolicyCommands(parent: Command) {
  const cmd = parent.command("policy").description("策略管理");
  const snap = cmd.command("snapshots").description("策略快照");
  snap.command("list").description("列出快照").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/policy/snapshots"), g.format); });
  snap.command("explain").description("快照解释").requiredOption("--id <id>", "快照 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/policy/snapshots/${encodeURIComponent(o.id)}/explain`), g.format); });
  snap.command("get").description("获取快照").requiredOption("--id <id>", "快照 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/policy-snapshots/${encodeURIComponent(o.id)}`), g.format); });

  cmd.command("debug-evaluate").description("策略调试评估").requiredOption("--data <json>", "评估请求 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), "/governance/policy/debug/evaluate", JSON.parse(o.data)), g.format); });

  const cache = cmd.command("cache").description("策略缓存");
  cache.command("epoch").description("缓存纪元").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/policy/cache/epoch"), g.format); });
  cache.command("invalidate").description("清除缓存").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiPost(toApiOpts(g), "/governance/policy/cache/invalidate"), g.format); });

  const ver = cmd.command("versions").description("策略版本管理");
  ver.command("list").description("列出版本").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/policy/versions"), g.format); });
  ver.command("get").description("获取版本").requiredOption("--name <name>", "策略名").requiredOption("--version <ver>", "版本号")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/policy/versions/${encodeURIComponent(o.name)}/${o.version}`), g.format); });
  ver.command("create").description("创建版本").requiredOption("--data <json>", "版本 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), "/governance/policy/versions", JSON.parse(o.data)), g.format); });
  ver.command("release").description("发布版本").requiredOption("--name <name>", "策略名").requiredOption("--version <ver>", "版本号")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/policy/versions/${encodeURIComponent(o.name)}/${o.version}/release`), g.format); });
  ver.command("deprecate").description("废弃版本").requiredOption("--name <name>", "策略名").requiredOption("--version <ver>", "版本号")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/policy/versions/${encodeURIComponent(o.name)}/${o.version}/deprecate`), g.format); });
}

/* ── 模块13: approvals ── */
export function registerApprovalsCommands(parent: Command) {
  const cmd = parent.command("approvals").description("审批管理");
  cmd.command("list").description("列出审批").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/approvals"), g.format); });
  cmd.command("get").description("获取审批").requiredOption("--id <id>", "审批 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/approvals/${encodeURIComponent(o.id)}`), g.format); });
  cmd.command("decide").description("审批决策").requiredOption("--id <id>", "审批 ID").requiredOption("--decision <d>", "approved|rejected").option("--reason <r>", "原因")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/approvals/${encodeURIComponent(o.id)}/decisions`, { decision: o.decision, reason: o.reason }), g.format); });
}
