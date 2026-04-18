/**
 * observability 命令组 — 可观测性 + 词表治理
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, apiDelete, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerObservabilityCommands(program: Command) {
  const obs = program.command("observability").description("可观测性");

  obs.command("summary").description("可观测性摘要").option("--window <w>", "1h|24h").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/observability/summary${qs({ window: _o.window })}`), g.format);
  });

  obs.command("operations").description("Agent OS 运营指标").option("--window <w>", "1h|24h|7d").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/observability/operations${qs({ window: _o.window })}`), g.format);
  });

  obs.command("quality-alerts").description("架构质量告警").option("--window <w>", "1h|24h|7d").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/observability/quality-alerts${qs({ window: _o.window })}`), g.format);
  });

  obs.command("degradation-stats").description("运行时降级统计").option("--window <w>", "1h|24h|7d").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/observability/degradation-stats${qs({ window: _o.window })}`), g.format);
  });

  obs.command("run-metrics").description("核心运行指标").option("--window <w>", "1h|24h|7d").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/run-metrics${qs({ window: _o.window })}`), g.format);
  });

  // ── vocab ──────────────────────────────────────────────────────
  const vocab = obs.command("vocab").description("词表治理");

  vocab.command("status").description("词表加载状态").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/vocab/status"), g.format);
  });

  vocab.command("snapshot").description("全局词表快照").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/vocab/snapshot"), g.format);
  });

  vocab.command("tenant-snapshot").description("租户词表快照").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/vocab/tenant-snapshot"), g.format);
  });

  vocab.command("reload").description("强制重新加载全局词表").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/vocab/reload"), g.format);
  });

  vocab.command("set-tenant-override").description("设置租户词表覆盖").option("--body-json <json>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, "/governance/vocab/tenant-override", _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });

  vocab.command("clear-tenant-override").description("清除租户词表覆盖").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiDelete(o, "/governance/vocab/tenant-override"), g.format);
  });
}
