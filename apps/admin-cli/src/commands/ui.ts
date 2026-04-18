/**
 * ui 命令组 — UI 组件注册表治理
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerUiCommands(program: Command) {
  const ui = program.command("ui").description("UI 组件治理");
  const cr = ui.command("component-registry").description("组件注册表");

  cr.command("get").description("获取注册表").option("--scope <s>", "tenant|space").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/ui/component-registry${qs({ scope: _o.scope })}`), g.format);
  });

  cr.command("draft").description("保存草稿").requiredOption("--component-ids-json <json>", "组件ID数组").option("--scope <s>", "tenant|space").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, "/governance/ui/component-registry/draft", { scope: _o.scope, componentIds: JSON.parse(_o.componentIdsJson) }), g.format);
  });

  cr.command("publish").description("发布草稿").option("--scope <s>", "tenant|space").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/ui/component-registry/publish", { scope: _o.scope }), g.format);
  });

  cr.command("rollback").description("回滚到上一版本").option("--scope <s>", "tenant|space").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/ui/component-registry/rollback", { scope: _o.scope }), g.format);
  });
}
