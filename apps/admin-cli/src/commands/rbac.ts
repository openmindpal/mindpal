import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiDelete, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerRbacCommands(parent: Command) {
  const cmd = parent.command("rbac").description("RBAC/ABAC 权限管理");

  /* ─── roles ─── */
  const roles = cmd.command("roles").description("角色管理");
  roles.command("list").description("列出角色").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/rbac/roles"), g.format);
  });
  roles.command("get").description("获取角色详情").requiredOption("--role-id <id>", "角色 ID")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiGet(toApiOpts(g), `/rbac/roles/${encodeURIComponent(o.roleId)}`), g.format);
    });
  roles.command("create").description("创建角色").requiredOption("--name <name>", "角色名").option("--description <desc>", "描述")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), "/rbac/roles", { name: o.name, description: o.description }), g.format);
    });
  roles.command("bind-perm").description("绑定权限到角色").requiredOption("--role-id <id>", "角色 ID").requiredOption("--permission-ids <ids>", "权限 ID (逗号分隔)")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), `/rbac/roles/${encodeURIComponent(o.roleId)}/permissions`, { permissionIds: o.permissionIds.split(",") }), g.format);
    });
  roles.command("unbind-perm").description("解绑权限").requiredOption("--role-id <id>", "角色 ID").requiredOption("--permission-ids <ids>", "权限 ID (逗号分隔)")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiDelete(toApiOpts(g), `/rbac/roles/${encodeURIComponent(o.roleId)}/permissions`, { permissionIds: o.permissionIds.split(",") }), g.format);
    });

  /* ─── permissions ─── */
  const perms = cmd.command("permissions").description("权限管理");
  perms.command("list").description("列出权限").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/rbac/permissions"), g.format);
  });
  perms.command("create").description("创建权限").requiredOption("--resource-type <type>", "资源类型").requiredOption("--action <action>", "操作")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), "/rbac/permissions", { resourceType: o.resourceType, action: o.action }), g.format);
    });

  /* ─── bindings ─── */
  const bindings = cmd.command("bindings").description("角色绑定管理");
  bindings.command("list").description("列出绑定").option("--subject-id <id>", "主体 ID").option("--role-id <id>", "角色 ID")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiGet(toApiOpts(g), `/rbac/bindings${qs({ subjectId: o.subjectId, roleId: o.roleId })}`), g.format);
    });
  bindings.command("create").description("创建绑定").requiredOption("--subject-id <id>", "主体 ID").requiredOption("--role-id <id>", "角色 ID").option("--scope-type <type>", "范围类型").option("--scope-id <id>", "范围 ID")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), "/rbac/bindings", { subjectId: o.subjectId, roleId: o.roleId, scopeType: o.scopeType, scopeId: o.scopeId }), g.format);
    });
  bindings.command("delete").description("删除绑定").requiredOption("--binding-id <id>", "绑定 ID")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiDelete(toApiOpts(g), `/rbac/bindings/${encodeURIComponent(o.bindingId)}`), g.format);
    });

  /* ─── check / preflight ─── */
  cmd.command("check").description("权限检查").requiredOption("--resource-type <type>", "资源类型").requiredOption("--action <action>", "操作").option("--subject-id <id>", "主体 ID")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), "/rbac/check", { resourceType: o.resourceType, action: o.action, subjectId: o.subjectId }), g.format);
    });
  cmd.command("preflight").description("策略预检").action(async function (this: Command) {
    const g = resolveGlobalOptions(this);
    printResult(await apiPost(toApiOpts(g), "/rbac/policy/preflight"), g.format);
  });

  /* ─── ABAC ─── */
  const abac = cmd.command("abac").description("ABAC 属性策略管理");

  const ps = abac.command("policy-sets").description("策略集管理");
  ps.command("list").description("列出策略集").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); printResult(await apiGet(toApiOpts(g), "/rbac/abac/policy-sets"), g.format);
  });
  ps.command("get").description("获取策略集").requiredOption("--id <id>", "策略集 ID")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiGet(toApiOpts(g), `/rbac/abac/policy-sets/${encodeURIComponent(o.id)}`), g.format);
    });
  ps.command("create").description("创建策略集").requiredOption("--name <name>", "名称").option("--resource-type <type>", "资源类型").option("--combining <algo>", "合并算法")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), "/rbac/abac/policy-sets", { name: o.name, resourceType: o.resourceType, combiningAlgorithm: o.combining }), g.format);
    });
  ps.command("update").description("更新策略集").requiredOption("--id <id>", "策略集 ID").option("--combining <algo>", "合并算法").option("--status <status>", "状态")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), `/rbac/abac/policy-sets/${encodeURIComponent(o.id)}/update`, { combiningAlgorithm: o.combining, status: o.status }), g.format);
    });
  ps.command("delete").description("删除策略集").requiredOption("--id <id>", "策略集 ID")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiDelete(toApiOpts(g), `/rbac/abac/policy-sets/${encodeURIComponent(o.id)}`), g.format);
    });

  const rules = abac.command("rules").description("ABAC 规则管理");
  rules.command("create").description("创建规则").requiredOption("--policy-set-id <id>", "策略集 ID").requiredOption("--name <name>", "名称").requiredOption("--resource-type <type>", "资源类型").requiredOption("--effect <effect>", "allow|deny")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), `/rbac/abac/policy-sets/${encodeURIComponent(o.policySetId)}/rules`, { name: o.name, resourceType: o.resourceType, effect: o.effect, actions: ["*"], conditionExpr: { op: "true" } }), g.format);
    });
  rules.command("update").description("更新规则").requiredOption("--rule-id <id>", "规则 ID").option("--name <name>", "名称").option("--effect <effect>", "allow|deny").option("--enabled <bool>", "启停")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), `/rbac/abac/rules/${encodeURIComponent(o.ruleId)}/update`, { name: o.name, effect: o.effect, enabled: o.enabled === "true" ? true : o.enabled === "false" ? false : undefined }), g.format);
    });
  rules.command("delete").description("删除规则").requiredOption("--rule-id <id>", "规则 ID")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiDelete(toApiOpts(g), `/rbac/abac/rules/${encodeURIComponent(o.ruleId)}`), g.format);
    });

  abac.command("evaluate").description("ABAC 实时评估").requiredOption("--policy-set-id <id>", "策略集 ID").requiredOption("--subject-id <sid>", "主体 ID").requiredOption("--resource-type <type>", "资源类型").requiredOption("--action <action>", "操作")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const o = this.opts();
      printResult(await apiPost(toApiOpts(g), "/rbac/abac/evaluate", {
        policySetId: o.policySetId,
        request: { subject: { subjectId: o.subjectId, tenantId: g.tenantId }, resource: { resourceType: o.resourceType }, action: o.action },
      }), g.format);
    });
}
