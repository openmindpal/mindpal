import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

/* ── 模块07: schemas ── */
export function registerSchemasCommands(parent: Command) {
  const cmd = parent.command("schemas").description("Schema 建模管理");
  cmd.command("list").description("列出 Schema").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/schemas"), g.format); });
  cmd.command("get-latest").description("获取最新版本").requiredOption("--name <name>", "Schema 名").action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/schemas/${encodeURIComponent(o.name)}/latest`), g.format); });
  cmd.command("get-version").description("获取指定版本").requiredOption("--name <name>", "Schema 名").requiredOption("--version <ver>", "版本号").action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/schemas/${encodeURIComponent(o.name)}/${o.version}`), g.format); });
  cmd.command("versions").description("列出版本历史").requiredOption("--name <name>", "Schema 名").action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/schemas/${encodeURIComponent(o.name)}/versions`), g.format); });
  cmd.command("publish").description("发布 Schema").requiredOption("--name <name>", "Schema 名").requiredOption("--data <json>", "Schema JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/schemas/${encodeURIComponent(o.name)}/publish`, JSON.parse(o.data)), g.format); });
  cmd.command("effective").description("获取有效 Schema").requiredOption("--entity <name>", "实体名")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/schemas/${encodeURIComponent(o.entity)}/effective`), g.format); });
  cmd.command("set-active").description("设置活动版本").requiredOption("--name <name>", "Schema 名").requiredOption("--version <ver>", "版本号")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/schemas/${encodeURIComponent(o.name)}/set-active`, { version: Number(o.version) }), g.format); });
  cmd.command("rollback").description("回滚 Schema").requiredOption("--name <name>", "Schema 名")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/schemas/${encodeURIComponent(o.name)}/rollback`), g.format); });

  const mig = cmd.command("migrations").description("Schema 迁移管理");
  mig.command("list").description("列出迁移").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/schema-migrations"), g.format); });
  mig.command("create").description("创建迁移").requiredOption("--data <json>", "迁移请求 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), "/governance/schema-migrations", JSON.parse(o.data)), g.format); });
  mig.command("get-run").description("获取迁移运行").requiredOption("--id <id>", "运行 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/schema-migration-runs/${encodeURIComponent(o.id)}`), g.format); });
  mig.command("cancel-run").description("取消迁移运行").requiredOption("--id <id>", "运行 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/schema-migration-runs/${encodeURIComponent(o.id)}/cancel`), g.format); });
}

/* ── 模块08: entities ── */
export function registerEntitiesCommands(parent: Command) {
  const cmd = parent.command("entities").description("实体数据管理");
  cmd.command("list").description("列出实体记录").requiredOption("--entity <name>", "实体名").option("--limit <n>", "条数").option("--offset <n>", "偏移").option("--schema-name <name>", "Schema 名")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/entities/${encodeURIComponent(o.entity)}${qs({ limit: o.limit, offset: o.offset })}`, o.schemaName ? { "x-schema-name": o.schemaName } : undefined), g.format); });
  cmd.command("get").description("获取单条记录").requiredOption("--entity <name>", "实体名").requiredOption("--id <id>", "记录 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/entities/${encodeURIComponent(o.entity)}/${encodeURIComponent(o.id)}`), g.format); });
  cmd.command("query").description("高级查询").requiredOption("--entity <name>", "实体名").requiredOption("--filter <json>", "过滤条件 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/entities/${encodeURIComponent(o.entity)}/query`, JSON.parse(o.filter)), g.format); });
  cmd.command("create").description("创建记录").requiredOption("--entity <name>", "实体名").requiredOption("--data <json>", "数据 JSON").option("--schema-name <name>", "Schema 名")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/entities/${encodeURIComponent(o.entity)}`, JSON.parse(o.data), o.schemaName ? { "x-schema-name": o.schemaName } : undefined), g.format); });
  cmd.command("update").description("更新记录").requiredOption("--entity <name>", "实体名").requiredOption("--id <id>", "记录 ID").requiredOption("--data <json>", "数据 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPatch(toApiOpts(g), `/entities/${encodeURIComponent(o.entity)}/${encodeURIComponent(o.id)}`, JSON.parse(o.data)), g.format); });
  cmd.command("delete").description("删除记录").requiredOption("--entity <name>", "实体名").requiredOption("--id <id>", "记录 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiDelete(toApiOpts(g), `/entities/${encodeURIComponent(o.entity)}/${encodeURIComponent(o.id)}`), g.format); });
  cmd.command("export").description("导出数据").requiredOption("--entity <name>", "实体名").option("--format <fmt>", "导出格式")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/entities/${encodeURIComponent(o.entity)}/export`, { format: o.format }), g.format); });
  cmd.command("import").description("导入数据").requiredOption("--entity <name>", "实体名").requiredOption("--data <json>", "导入数据 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/entities/${encodeURIComponent(o.entity)}/import`, JSON.parse(o.data)), g.format); });
}

/* ── 模块09: tools ── */
export function registerToolsCommands(parent: Command) {
  const cmd = parent.command("tools").description("工具管理");
  cmd.command("list").description("列出工具").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/tools"), g.format); });
  cmd.command("get").description("获取工具").requiredOption("--name <name>", "工具名").action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/tools/${encodeURIComponent(o.name)}`), g.format); });
  cmd.command("publish").description("发布工具").requiredOption("--name <name>", "工具名").requiredOption("--data <json>", "工具定义 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/tools/${encodeURIComponent(o.name)}/publish`, JSON.parse(o.data)), g.format); });
  cmd.command("versions").description("工具版本历史").requiredOption("--ref <ref>", "工具引用")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/tools/versions/${encodeURIComponent(o.ref)}`), g.format); });
  cmd.command("execute").description("执行工具").requiredOption("--ref <ref>", "工具引用").requiredOption("--input <json>", "输入 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/tools/${encodeURIComponent(o.ref)}/execute`, JSON.parse(o.input)), g.format); });
  cmd.command("run-status").description("工具运行状态").requiredOption("--run-id <id>", "运行 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/tools/runs/${encodeURIComponent(o.runId)}`), g.format); });
  cmd.command("step-status").description("步骤状态").requiredOption("--step-id <id>", "步骤 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/tools/steps/${encodeURIComponent(o.stepId)}`), g.format); });
  cmd.command("enable").description("启用工具").requiredOption("--ref <ref>", "工具引用")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/tools/${encodeURIComponent(o.ref)}/enable`), g.format); });
  cmd.command("disable").description("禁用工具").requiredOption("--ref <ref>", "工具引用")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/tools/${encodeURIComponent(o.ref)}/disable`), g.format); });
  cmd.command("set-active").description("设置活动版本").requiredOption("--name <name>", "工具名").requiredOption("--ref <ref>", "工具引用")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/tools/${encodeURIComponent(o.name)}/active`, { toolRef: o.ref }), g.format); });
  cmd.command("rollback").description("回滚工具").requiredOption("--name <name>", "工具名")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/governance/tools/${encodeURIComponent(o.name)}/rollback`), g.format); });
  cmd.command("batch").description("批量操作").requiredOption("--data <json>", "批量操作 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), "/governance/tools/batch", JSON.parse(o.data)), g.format); });
  cmd.command("impact-analysis").description("影响分析").requiredOption("--ref <ref>", "工具引用")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/tools/${encodeURIComponent(o.ref)}/impact-analysis`), g.format); });
  cmd.command("categories").description("工具分类列表").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/tools/categories"), g.format); });
  cmd.command("metadata").description("更新工具元数据").requiredOption("--name <name>", "工具名").requiredOption("--data <json>", "元数据 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPatch(toApiOpts(g), `/governance/tools/${encodeURIComponent(o.name)}/metadata`, JSON.parse(o.data)), g.format); });
  cmd.command("usage-stats").description("使用统计").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/tools/usage-stats"), g.format); });
  cmd.command("by-category").description("按分类查看").requiredOption("--category <cat>", "分类名")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/tools/by-category/${encodeURIComponent(o.category)}`), g.format); });

  const np = cmd.command("network-policies").description("网络策略管理");
  np.command("list").description("列出网络策略").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/tools/network-policies"), g.format); });
  np.command("get").description("获取网络策略").requiredOption("--ref <ref>", "工具引用")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/governance/tools/${encodeURIComponent(o.ref)}/network-policy`), g.format); });
  np.command("set").description("设置网络策略").requiredOption("--ref <ref>", "工具引用").requiredOption("--data <json>", "策略 JSON")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPut(toApiOpts(g), `/governance/tools/${encodeURIComponent(o.ref)}/network-policy`, JSON.parse(o.data)), g.format); });
  cmd.command("governance-list").description("治理视图工具列表").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/governance/tools"), g.format); });
}
