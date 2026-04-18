import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerHealthCommands(parent: Command) {
  const cmd = parent.command("health").description("系统健康检查");

  cmd.command("live").description("存活探针").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const api = toApiOpts(g);
    printResult(await apiGet(api, "/health/live"), g.format);
  });

  cmd.command("ready").description("就绪探针").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const api = toApiOpts(g);
    printResult(await apiGet(api, "/health/ready"), g.format);
  });

  cmd.command("full").description("完整健康检查").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const api = toApiOpts(g);
    printResult(await apiGet(api, "/health"), g.format);
  });

  cmd.command("db-pool").description("数据库连接池状态").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const api = toApiOpts(g);
    printResult(await apiGet(api, "/health/db-pool"), g.format);
  });

  cmd.command("system").description("系统资源状态").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const api = toApiOpts(g);
    printResult(await apiGet(api, "/health/system"), g.format);
  });
}
