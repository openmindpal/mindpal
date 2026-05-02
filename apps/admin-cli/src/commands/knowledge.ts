/**
 * knowledge 命令组 — 知识库治理
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerKnowledgeCommands(program: Command) {
  const k = program.command("knowledge").description("知识库治理");

  // ── documents ──────────────────────────────────────────────────
  const docs = k.command("documents").description("文档管理");
  docs.command("list").description("列出文档").option("--limit <n>").option("--offset <n>").option("--status <s>").option("--source-type <t>").option("--search <q>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/documents${qs({ limit: _o.limit, offset: _o.offset, status: _o.status, sourceType: _o.sourceType, search: _o.search })}`), g.format);
  });
  docs.command("get <id>").description("获取文档").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/documents/${encodeURIComponent(id)}`), g.format);
  });

  // ── retrieval logs ─────────────────────────────────────────────
  const rl = k.command("retrieval-logs").description("检索日志");
  rl.command("list").description("列出检索日志").option("--limit <n>").option("--offset <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/retrieval-logs${qs({ limit: _o.limit, offset: _o.offset })}`), g.format);
  });
  rl.command("get <id>").description("获取检索日志").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/retrieval-logs/${encodeURIComponent(id)}`), g.format);
  });

  // ── retention policy ───────────────────────────────────────────
  k.command("retention-get").description("获取保留策略").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/knowledge/retention-policies"), g.format);
  });
  k.command("retention-set").description("设置保留策略").option("--body-json <json>", "策略 JSON").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, "/governance/knowledge/retention-policy", _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });

  // ── strategies ─────────────────────────────────────────────────
  const strat = k.command("strategies").description("检索策略");
  strat.command("list").description("列出策略").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/knowledge/retrieval-strategies"), g.format);
  });
  strat.command("create").description("创建策略").option("--body-json <json>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/knowledge/retrieval-strategies", _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });
  strat.command("activate <id>").description("激活策略").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/knowledge/retrieval-strategies/${encodeURIComponent(id)}/activate`), g.format);
  });

  // ── strategy eval runs ─────────────────────────────────────────
  const ser = k.command("strategy-evals").description("策略评测");
  ser.command("list").description("列出评测运行").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/strategy-eval-runs${qs({ limit: _o.limit })}`), g.format);
  });
  ser.command("create").description("创建评测运行").option("--body-json <json>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/knowledge/strategy-eval-runs", _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });
  ser.command("get <id>").description("获取评测运行").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/strategy-eval-runs/${encodeURIComponent(id)}`), g.format);
  });

  // ── jobs ───────────────────────────────────────────────────────
  const ij = k.command("ingest-jobs").description("摄取作业");
  ij.command("list").description("列出").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/ingest-jobs${qs({ limit: _o.limit })}`), g.format);
  });
  ij.command("get <id>").description("获取").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/ingest-jobs/${encodeURIComponent(id)}`), g.format);
  });

  const ej = k.command("embedding-jobs").description("嵌入作业");
  ej.command("list").description("列出").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/embedding-jobs${qs({ limit: _o.limit })}`), g.format);
  });
  ej.command("get <id>").description("获取").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/embedding-jobs/${encodeURIComponent(id)}`), g.format);
  });

  const xj = k.command("index-jobs").description("索引作业");
  xj.command("list").description("列出").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/index-jobs${qs({ limit: _o.limit })}`), g.format);
  });
  xj.command("get <id>").description("获取").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/index-jobs/${encodeURIComponent(id)}`), g.format);
  });

  // ── quality ────────────────────────────────────────────────────
  const q = k.command("quality").description("质量评测");
  const es = q.command("eval-sets").description("评测集");
  es.command("list").description("列出").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/eval-sets${qs({ limit: _o.limit })}`), g.format);
  });
  es.command("get <id>").description("获取").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/eval-sets/${encodeURIComponent(id)}`), g.format);
  });
  es.command("create").description("创建").option("--body-json <json>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/governance/knowledge/eval-sets", _o.bodyJson ? JSON.parse(_o.bodyJson) : {}), g.format);
  });
  es.command("run <id>").description("执行评测").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/knowledge/eval-sets/${encodeURIComponent(id)}/run`), g.format);
  });

  const er = q.command("runs").description("评测运行");
  er.command("list").description("列出").option("--limit <n>").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/eval-runs${qs({ limit: _o.limit })}`), g.format);
  });
  er.command("get <id>").description("获取").action(async (id, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/governance/knowledge/eval-runs/${encodeURIComponent(id)}`), g.format);
  });
}
