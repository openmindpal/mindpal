/**
 * artifact-policy 命令组 — 制品策略
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPut, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerArtifactPolicyCommands(program: Command) {
  const ap = program.command("artifact-policy").description("制品策略");

  ap.command("get").description("获取制品策略").option("--scope-type <t>", "tenant|space").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/artifact-policy${qs({ scopeType: _o.scopeType })}`), g.format);
  });

  ap.command("set").description("设置制品策略").option("--scope-type <t>", "tenant|space").option("--download-token-expires-sec <n>").option("--download-token-max-uses <n>").option("--watermark-headers-enabled").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    const body: any = {};
    if (_o.scopeType) body.scopeType = _o.scopeType;
    if (_o.downloadTokenExpiresSec) body.downloadTokenExpiresInSec = Number(_o.downloadTokenExpiresSec);
    if (_o.downloadTokenMaxUses) body.downloadTokenMaxUses = Number(_o.downloadTokenMaxUses);
    if (_o.watermarkHeadersEnabled !== undefined) body.watermarkHeadersEnabled = true;
    printResult(await apiPut(o, "/governance/artifact-policy", body), g.format);
  });
}
