/**
 * integrations 命令组 — 集成概览
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerIntegrationsCommands(program: Command) {
  const intg = program.command("integrations").description("集成概览");

  intg.command("list").description("列出集成").option("--scope-type <t>", "tenant|space").option("--limit <n>").option("--offset <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/integrations${qs({ scopeType: _o.scopeType, limit: _o.limit, offset: _o.offset })}`), g.format);
  });

  intg.command("get <integrationId>").description("获取集成详情").action(async (integrationId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/integrations/${encodeURIComponent(integrationId)}`), g.format);
  });
}
