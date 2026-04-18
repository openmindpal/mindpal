/**
 * collab 命令组 — 协作诊断
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerCollabCommands(program: Command) {
  const collab = program.command("collab").description("协作治理");

  collab.command("diagnostics <collabRunId>").description("协作运行诊断").option("--correlation-id <id>", "关联ID").action(async (collabRunId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/collab-runs/${encodeURIComponent(collabRunId)}/diagnostics${qs({ correlationId: _o.correlationId })}`), g.format);
  });
}
