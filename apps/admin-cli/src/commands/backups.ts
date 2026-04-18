/**
 * backups 命令组 — 备份与恢复
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerBackupsCommands(program: Command) {
  const backups = program.command("backups").description("备份与恢复");

  backups.command("list <spaceId>").description("列出备份").option("--limit <n>").action(async (spaceId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/spaces/${encodeURIComponent(spaceId)}/backups${qs({ limit: _o.limit })}`), g.format);
  });

  backups.command("get <backupId>").description("获取备份详情").action(async (backupId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/backups/${encodeURIComponent(backupId)}`), g.format);
  });

  backups.command("create <spaceId>").description("创建备份").option("--schema-name <n>").option("--entity-names-json <json>", "实体名数组").option("--format <f>", "jsonl|json", "jsonl").action(async (spaceId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    const body: any = { format: _o.format };
    if (_o.schemaName) body.schemaName = _o.schemaName;
    if (_o.entityNamesJson) body.entityNames = JSON.parse(_o.entityNamesJson);
    printResult(await apiPost(o, `/spaces/${encodeURIComponent(spaceId)}/backups`, body), g.format);
  });

  backups.command("restore <spaceId>").description("恢复备份").requiredOption("--backup-artifact-id <id>", "备份制品ID").option("--mode <m>", "dry_run|commit", "dry_run").option("--conflict-strategy <s>", "fail|upsert", "fail").option("--target-mode <t>", "current_space|new_space").option("--target-space-id <id>").option("--target-space-name <n>").action(async (spaceId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/spaces/${encodeURIComponent(spaceId)}/restores`, { backupArtifactId: _o.backupArtifactId, mode: _o.mode, conflictStrategy: _o.conflictStrategy, targetMode: _o.targetMode, targetSpaceId: _o.targetSpaceId, targetSpaceName: _o.targetSpaceName }), g.format);
  });
}
