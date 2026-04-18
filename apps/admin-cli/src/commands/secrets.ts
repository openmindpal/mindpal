/**
 * secrets 命令组 — 凭据/密钥管理
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerSecretsCommands(program: Command) {
  const secrets = program.command("secrets").description("凭据/密钥管理");

  secrets.command("list").description("列出密钥").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/secrets"), g.format);
  });

  secrets.command("get <id>").description("获取密钥详情").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/secrets/${encodeURIComponent(id)}`), g.format);
  });

  secrets.command("create").description("创建密钥").requiredOption("--connector-instance-id <id>", "连接器实例").requiredOption("--payload-json <json>", "载荷 JSON").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/secrets", { connectorInstanceId: _o.connectorInstanceId, payload: JSON.parse(_o.payloadJson) }), g.format);
  });

  secrets.command("revoke <id>").description("吊销密钥").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/secrets/${encodeURIComponent(id)}/revoke`), g.format);
  });

  secrets.command("rotate <id>").description("轮换密钥").requiredOption("--payload-json <json>", "新载荷 JSON").option("--grace-period-sec <n>", "宽限期(秒)").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    const body: any = { payload: JSON.parse(_o.payloadJson) };
    if (_o.gracePeriodSec) body.gracePeriodSec = Number(_o.gracePeriodSec);
    printResult(await apiPost(o, `/secrets/${encodeURIComponent(id)}/rotate`, body), g.format);
  });

  secrets.command("usage").description("密钥使用记录").requiredOption("--connector-instance-id <id>", "连接器实例").option("--limit <n>", "数量").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/secrets/usage${qs({ connectorInstanceId: _o.connectorInstanceId, limit: _o.limit })}`), g.format);
  });

  secrets.command("plaintext <id>").description("明文获取(禁止)").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/secrets/${encodeURIComponent(id)}/plaintext`), g.format);
  });
}
