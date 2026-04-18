/**
 * settings 命令组 — 系统设置
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPut } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerSettingsCommands(program: Command) {
  const settings = program.command("settings").description("系统设置");

  settings.command("locale-defaults").description("查看语言默认值").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/settings/locale-defaults"), g.format);
  });

  settings.command("tenant-locale").description("设置租户默认语言").requiredOption("--locale <l>", "语言代码").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, "/settings/tenant-locale", { defaultLocale: _o.locale }), g.format);
  });

  settings.command("space-locale").description("设置空间默认语言").requiredOption("--locale <l>", "语言代码").option("--target-space-id <id>", "目标空间").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, "/settings/space-locale", { defaultLocale: _o.locale, spaceId: _o.targetSpaceId }), g.format);
  });

  settings.command("retention-get").description("获取步骤载荷保留天数").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/settings/workflow-step-payload-retention"), g.format);
  });

  settings.command("retention-set").description("设置步骤载荷保留天数").requiredOption("--days <n>", "天数 (0-365 或 null)").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    const days = _o.days === "null" ? null : Number(_o.days);
    printResult(await apiPut(o, "/settings/workflow-step-payload-retention", { retentionDays: days }), g.format);
  });
}
