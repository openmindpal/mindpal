import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, apiDelete, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerSpacesCommands(parent: Command) {
  const cmd = parent.command("spaces").description("空间管理");
  cmd.command("list").description("列出空间").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/spaces"), g.format); });
  cmd.command("get").description("获取空间").requiredOption("--space-id <id>", "空间 ID").action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/spaces/${encodeURIComponent(o.spaceId)}`), g.format); });
  cmd.command("create").description("创建空间").requiredOption("--name <name>", "名称").option("--description <desc>", "描述")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), "/spaces", { name: o.name, description: o.description }), g.format); });
  cmd.command("delete").description("删除空间").requiredOption("--space-id <id>", "空间 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiDelete(toApiOpts(g), `/spaces/${encodeURIComponent(o.spaceId)}`), g.format); });

  const members = cmd.command("members").description("空间成员管理");
  members.command("list").description("列出成员").requiredOption("--space-id <id>", "空间 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiGet(toApiOpts(g), `/spaces/${encodeURIComponent(o.spaceId)}/members`), g.format); });
  members.command("add").description("添加成员").requiredOption("--space-id <id>", "空间 ID").requiredOption("--subject-id <sid>", "主体 ID").option("--role <role>", "角色")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), `/spaces/${encodeURIComponent(o.spaceId)}/members`, { subjectId: o.subjectId, role: o.role }), g.format); });
  members.command("update").description("更新成员").requiredOption("--space-id <id>", "空间 ID").requiredOption("--subject-id <sid>", "主体 ID").requiredOption("--role <role>", "角色")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPut(toApiOpts(g), `/spaces/${encodeURIComponent(o.spaceId)}/members/${encodeURIComponent(o.subjectId)}`, { role: o.role }), g.format); });
  members.command("remove").description("移除成员").requiredOption("--space-id <id>", "空间 ID").requiredOption("--subject-id <sid>", "主体 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiDelete(toApiOpts(g), `/spaces/${encodeURIComponent(o.spaceId)}/members/${encodeURIComponent(o.subjectId)}`), g.format); });

  const org = parent.command("org").description("组织单元管理");
  const units = org.command("units").description("组织单元 CRUD");
  units.command("list").description("列出组织单元").action(async function (this: Command) { const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/org/units"), g.format); });
  units.command("create").description("创建组织单元").requiredOption("--name <name>", "名称").option("--parent-id <id>", "上级 ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPost(toApiOpts(g), "/org/units", { name: o.name, parentId: o.parentId }), g.format); });
  units.command("update").description("更新组织单元").requiredOption("--id <id>", "ID").option("--name <name>", "名称")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiPut(toApiOpts(g), `/org/units/${encodeURIComponent(o.id)}`, { name: o.name }), g.format); });
  units.command("delete").description("删除组织单元").requiredOption("--id <id>", "ID")
    .action(async function (this: Command) { const g = resolveGlobalOptions(this); const o = this.opts(); printResult(await apiDelete(toApiOpts(g), `/org/units/${encodeURIComponent(o.id)}`), g.format); });
}
