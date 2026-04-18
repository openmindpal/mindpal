/**
 * me 命令组 — 当前用户信息与偏好
 *
 * 覆盖端点：
 * - GET /me                — 当前用户身份信息
 * - GET /me/preferences    — 获取用户偏好
 * - PUT /me/preferences    — 更新用户偏好
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPut } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerMeCommands(program: Command) {
  const me = program.command("me").description("当前用户信息与偏好");

  me.command("info").description("获取当前用户身份信息").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/me"), g.format);
  });

  me.command("prefs-get").description("获取用户偏好设置").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/me/preferences"), g.format);
  });

  me.command("prefs-set").description("更新用户偏好设置").requiredOption("--locale <locale>", "语言偏好 (如 zh-CN, en-US)").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, "/me/preferences", { locale: _o.locale }), g.format);
  });
}
