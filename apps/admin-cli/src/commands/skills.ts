/**
 * skills 命令组 — Skill 生命周期 + 运行时 Runner + 可信密钥
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerSkillsCommands(program: Command) {
  const skills = program.command("skills").description("Skill 管理");

  // ── lifecycle ──────────────────────────────────────────────────
  const lc = skills.command("lifecycle").description("Skill 生命周期");

  lc.command("summary").description("状态摘要").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/skill-lifecycle/summary"), g.format);
  });

  lc.command("events").description("生命周期事件").option("--skill-name <n>").option("--scope-type <t>").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/skill-lifecycle/events${qs({ skillName: _o.skillName, scopeType: _o.scopeType, limit: _o.limit })}`), g.format);
  });

  lc.command("transition").description("状态转换").requiredOption("--skill-name <n>", "Skill 名称").requiredOption("--to-status <s>", "目标状态").option("--skill-version <v>").option("--scope-type <t>").option("--scope-id <id>").option("--approval-id <id>").option("--reason <r>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/skill-lifecycle/transition", { skillName: _o.skillName, skillVersion: _o.skillVersion, toStatus: _o.toStatus, scopeType: _o.scopeType, scopeId: _o.scopeId, approvalId: _o.approvalId, reason: _o.reason }), g.format);
  });

  lc.command("check <skillName>").description("检查 Skill 是否启用").action(async (skillName, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/skill-lifecycle/check/${encodeURIComponent(skillName)}`), g.format);
  });

  // ── runners ────────────────────────────────────────────────────
  const runners = skills.command("runners").description("运行时 Runner");

  runners.command("list").description("列出 Runner").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/skill-runtime/runners"), g.format);
  });

  runners.command("create").description("创建 Runner").requiredOption("--endpoint <url>", "端点 URL").option("--enabled", "启用").option("--auth-secret-id <id>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/skill-runtime/runners", { endpoint: _o.endpoint, enabled: _o.enabled ?? true, authSecretId: _o.authSecretId }), g.format);
  });

  runners.command("enable <runnerId>").description("启用 Runner").action(async (runnerId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/skill-runtime/runners/${encodeURIComponent(runnerId)}/enable`), g.format);
  });

  runners.command("disable <runnerId>").description("禁用 Runner").action(async (runnerId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/skill-runtime/runners/${encodeURIComponent(runnerId)}/disable`), g.format);
  });

  runners.command("test <runnerId>").description("测试 Runner").action(async (runnerId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/skill-runtime/runners/${encodeURIComponent(runnerId)}/test`), g.format);
  });

  // ── trusted keys ───────────────────────────────────────────────
  const keys = skills.command("trusted-keys").description("可信密钥管理");

  keys.command("list").description("列出可信密钥").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/skill-runtime/trusted-keys"), g.format);
  });

  keys.command("create").description("创建可信密钥").requiredOption("--key-id <id>", "密钥标识").requiredOption("--public-key-pem <pem>", "公钥 PEM").option("--status <s>", "active|disabled", "active").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/skill-runtime/trusted-keys", { keyId: _o.keyId, publicKeyPem: _o.publicKeyPem, status: _o.status }), g.format);
  });

  keys.command("rotate <keyId>").description("轮换可信密钥").action(async (keyId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/skill-runtime/trusted-keys/${encodeURIComponent(keyId)}/rotate`), g.format);
  });
}
