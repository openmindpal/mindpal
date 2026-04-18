import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, apiDelete, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerScimCommands(parent: Command) {
  const cmd = parent.command("scim").description("SCIM 身份同步管理");

  cmd.command("config").description("SCIM 服务配置").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/scim/v2/ServiceProviderConfig"), g.format);
  });
  cmd.command("resource-types").description("SCIM 资源类型").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/scim/v2/ResourceTypes"), g.format);
  });
  cmd.command("schemas").description("SCIM Schema").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/scim/v2/Schemas"), g.format);
  });

  const users = cmd.command("users").description("SCIM 用户管理");
  users.command("list").description("列出用户").option("--filter <f>", "过滤表达式").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const o = this.opts();
    printResult(await apiGet(toApiOpts(g), `/scim/v2/Users${qs({ filter: o.filter })}`), g.format);
  });
  users.command("get").description("获取用户").requiredOption("--id <id>", "用户 ID").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const o = this.opts();
    printResult(await apiGet(toApiOpts(g), `/scim/v2/Users/${encodeURIComponent(o.id)}`), g.format);
  });
  users.command("create").description("创建用户").requiredOption("--username <name>", "用户名").requiredOption("--email <email>", "邮箱")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), "/scim/v2/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: o.username, emails: [{ value: o.email, primary: true }] }), g.format);
    });
  users.command("update").description("更新用户").requiredOption("--id <id>", "用户 ID").requiredOption("--data <json>", "JSON 数据")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPut(toApiOpts(g), `/scim/v2/Users/${encodeURIComponent(o.id)}`, JSON.parse(o.data)), g.format);
    });
  users.command("delete").description("删除用户").requiredOption("--id <id>", "用户 ID").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const o = this.opts();
    printResult(await apiDelete(toApiOpts(g), `/scim/v2/Users/${encodeURIComponent(o.id)}`), g.format);
  });

  const groups = cmd.command("groups").description("SCIM 组管理");
  groups.command("list").description("列出组").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/scim/v2/Groups"), g.format);
  });
  groups.command("get").description("获取组").requiredOption("--id <id>", "组 ID").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const o = this.opts();
    printResult(await apiGet(toApiOpts(g), `/scim/v2/Groups/${encodeURIComponent(o.id)}`), g.format);
  });
  groups.command("create").description("创建组").requiredOption("--name <name>", "组名")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), "/scim/v2/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: o.name }), g.format);
    });
  groups.command("update").description("更新组").requiredOption("--id <id>", "组 ID").requiredOption("--data <json>", "JSON 数据")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPut(toApiOpts(g), `/scim/v2/Groups/${encodeURIComponent(o.id)}`, JSON.parse(o.data)), g.format);
    });
  groups.command("delete").description("删除组").requiredOption("--id <id>", "组 ID").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const o = this.opts();
    printResult(await apiDelete(toApiOpts(g), `/scim/v2/Groups/${encodeURIComponent(o.id)}`), g.format);
  });
}
