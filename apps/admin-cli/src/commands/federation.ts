/**
 * federation 命令组 — 联邦治理
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, apiDelete, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerFederationCommands(program: Command) {
  const fed = program.command("federation").description("联邦治理");

  fed.command("status").description("网关状态").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/federation/status"), g.format);
  });

  fed.command("logs").description("信封日志").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/federation/logs${qs({ limit: _o.limit })}`), g.format);
  });

  // ── nodes ──────────────────────────────────────────────────────
  const nodes = fed.command("nodes").description("联邦节点管理");
  nodes.command("list").description("列出节点").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/federation/nodes${qs({ limit: _o.limit })}`), g.format);
  });
  nodes.command("get <nodeId>").description("获取节点").action(async (nodeId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/federation/nodes/${encodeURIComponent(nodeId)}`), g.format);
  });
  nodes.command("create").description("创建节点").option("--body-json <json>", "节点 JSON").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/federation/nodes", _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });
  nodes.command("update <nodeId>").description("更新节点").option("--body-json <json>").action(async (nodeId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, `/governance/federation/nodes/${encodeURIComponent(nodeId)}`, _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });
  nodes.command("delete <nodeId>").description("删除节点").action(async (nodeId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiDelete(o, `/governance/federation/nodes/${encodeURIComponent(nodeId)}`), g.format);
  });
  nodes.command("test <nodeId>").description("测试节点连通性").action(async (nodeId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/federation/nodes/${encodeURIComponent(nodeId)}/test`), g.format);
  });
  nodes.command("heartbeat <nodeId>").description("心跳").action(async (nodeId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/federation/nodes/${encodeURIComponent(nodeId)}/heartbeat`), g.format);
  });
  nodes.command("capabilities <nodeId>").description("获取能力").action(async (nodeId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/federation/nodes/${encodeURIComponent(nodeId)}/capabilities`), g.format);
  });
  nodes.command("set-capabilities <nodeId>").description("设置能力").option("--body-json <json>").action(async (nodeId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/federation/nodes/${encodeURIComponent(nodeId)}/capabilities`, _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });

  // ── permission grants ──────────────────────────────────────────
  const pg = fed.command("permission-grants").description("权限授予");
  pg.command("list").description("列出").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/federation/permission-grants${qs({ limit: _o.limit })}`), g.format);
  });
  pg.command("create").description("创建").option("--body-json <json>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/federation/permission-grants", _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });
  pg.command("revoke <grantId>").description("吊销").action(async (grantId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/federation/permission-grants/${encodeURIComponent(grantId)}/revoke`), g.format);
  });
  pg.command("check").description("检查权限").option("--body-json <json>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/federation/permission-grants/check", _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });

  // ── user grants ────────────────────────────────────────────────
  const ug = fed.command("user-grants").description("用户授予");
  ug.command("list").description("列出").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/federation/user-grants${qs({ limit: _o.limit })}`), g.format);
  });
  ug.command("create").description("创建").option("--body-json <json>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/federation/user-grants", _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });
  ug.command("revoke <grantId>").description("吊销").action(async (grantId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/federation/user-grants/${encodeURIComponent(grantId)}/revoke`), g.format);
  });

  // ── content policies ───────────────────────────────────────────
  const cp = fed.command("content-policies").description("内容策略");
  cp.command("list").description("列出").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/federation/content-policies${qs({ limit: _o.limit })}`), g.format);
  });
  cp.command("get <policyId>").description("获取").action(async (policyId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/federation/content-policies/${encodeURIComponent(policyId)}`), g.format);
  });
  cp.command("create").description("创建").option("--body-json <json>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/federation/content-policies", _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });
  cp.command("update <policyId>").description("更新").option("--body-json <json>").action(async (policyId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, `/governance/federation/content-policies/${encodeURIComponent(policyId)}`, _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });
  cp.command("delete <policyId>").description("删除").action(async (policyId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiDelete(o, `/governance/federation/content-policies/${encodeURIComponent(policyId)}`), g.format);
  });

  // ── audit logs ─────────────────────────────────────────────────
  fed.command("audit-logs").description("联邦审计日志").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/federation/audit-logs${qs({ limit: _o.limit })}`), g.format);
  });
}
