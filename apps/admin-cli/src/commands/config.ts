/**
 * config 命令组 — Runtime 配置治理
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPut, apiDelete, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerConfigCommands(program: Command) {
  const cfg = program.command("config").description("Runtime 配置治理");

  cfg.command("registry").description("查看配置注册表").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/config/registry"), g.format);
  });

  cfg.command("overrides").description("列出配置覆盖").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/config/overrides"), g.format);
  });

  cfg.command("resolved").description("解析所有有效值").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/config/resolved"), g.format);
  });

  cfg.command("resolve <key>").description("解析单个配置").action(async (key, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/config/resolve/${encodeURIComponent(key)}`), g.format);
  });

  cfg.command("set-override <key>").description("设置覆盖").requiredOption("--value <v>", "值").option("--description <d>", "描述").action(async (key, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, `/governance/config/overrides/${encodeURIComponent(key)}`, { value: _o.value, description: _o.description }), g.format);
  });

  cfg.command("delete-override <key>").description("删除覆盖").action(async (key, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiDelete(o, `/governance/config/overrides/${encodeURIComponent(key)}`), g.format);
  });

  cfg.command("audit-log").description("配置变更日志").option("--config-key <k>").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/config/audit-log${qs({ configKey: _o.configKey, limit: _o.limit })}`), g.format);
  });
}
