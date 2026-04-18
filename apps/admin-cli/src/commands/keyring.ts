/**
 * keyring 命令组 — 加密密钥环管理
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiPost } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerKeyringCommands(program: Command) {
  const keyring = program.command("keyring").description("加密密钥环管理");

  keyring.command("init").description("初始化分区密钥").requiredOption("--scope-type <t>", "tenant|space").option("--scope-space-id <id>", "空间ID").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/keyring/keys/init", { scopeType: _o.scopeType, spaceId: _o.scopeSpaceId }), g.format);
  });

  keyring.command("rotate").description("轮换分区密钥").requiredOption("--scope-type <t>", "tenant|space").option("--scope-space-id <id>", "空间ID").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/keyring/keys/rotate", { scopeType: _o.scopeType, spaceId: _o.scopeSpaceId }), g.format);
  });

  keyring.command("disable").description("禁用分区密钥").requiredOption("--scope-type <t>", "tenant|space").requiredOption("--key-version <n>", "密钥版本").option("--scope-space-id <id>", "空间ID").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/keyring/keys/disable", { scopeType: _o.scopeType, keyVersion: Number(_o.keyVersion), spaceId: _o.scopeSpaceId }), g.format);
  });

  keyring.command("reencrypt").description("重加密").requiredOption("--scope-type <t>", "tenant|space").option("--scope-space-id <id>", "空间ID").option("--limit <n>", "数量").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    const body: any = { scopeType: _o.scopeType, spaceId: _o.scopeSpaceId };
    if (_o.limit) body.limit = Number(_o.limit);
    printResult(await apiPost(o, "/keyring/keys/reencrypt", body), g.format);
  });
}
