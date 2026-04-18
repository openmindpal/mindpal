import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet } from "../lib/apiClient";
import { qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerDiagnosticsCommands(parent: Command) {
  const cmd = parent.command("diagnostics").description("系统诊断");

  cmd.command("status").description("队列与系统诊断状态").option("--scope <scope>", "tenant|space")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g);
      const o = this.opts(); printResult(await apiGet(api, `/diagnostics${qs({ scope: o.scope })}`), g.format);
    });

  cmd.command("dump").description("诊断信息转储")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g);
      printResult(await apiGet(api, "/diagnostics/dump"), g.format);
    });

  cmd.command("metrics").description("Prometheus 指标")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g);
      printResult(await apiGet(api, "/metrics"), g.format);
    });
}
