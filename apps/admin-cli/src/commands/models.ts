/**
 * models 命令组 — 模型网关管理
 *
 * 覆盖端点：
 * - GET    /models/catalog                              — 静态目录+模板
 * - GET    /models/catalog/db                           — DB 目录列表
 * - GET    /models/catalog/db/:modelRef                 — 单模型详情
 * - PUT    /models/catalog/db                           — 注册/更新模型
 * - PATCH  /models/catalog/db/:modelRef/status          — 更新模型状态
 * - DELETE /models/catalog/db/:modelRef                 — 删除模型
 * - GET    /models/bindings                             — 列出绑定
 * - POST   /models/bindings                             — 创建绑定
 * - DELETE /models/bindings/:id                         — 删除绑定
 * - POST   /models/onboard                              — 一站式接入模型
 * - POST   /models/chat                                 — 聊天调用
 * - GET    /governance/model-gateway/routing             — 列出路由策略
 * - PUT    /governance/model-gateway/routing/:purpose    — 创建/更新路由策略
 * - POST   /governance/model-gateway/routing/:purpose/disable — 禁用路由策略
 * - DELETE /governance/model-gateway/routing/:purpose    — 删除路由策略
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerModelsCommands(program: Command) {
  const models = program.command("models").description("模型网关管理（catalog / bindings / routing）");

  // ─── Catalog ──────────────────────────────────────────────────
  const catalog = models.command("catalog").description("模型目录管理");

  catalog.command("list").description("静态目录 + 模板").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/models/catalog"), g.format);
  });

  catalog.command("db-list").description("DB 目录列表").option("--status <s>", "按状态过滤 active|degraded|unavailable|probing").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/models/catalog/db${qs({ status: _o.status })}`), g.format);
  });

  catalog.command("db-get").description("查询单个模型详情").requiredOption("--model-ref <ref>", "模型引用").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/models/catalog/db/${encodeURIComponent(_o.modelRef)}`), g.format);
  });

  catalog.command("db-upsert").description("注册/更新模型能力画像").requiredOption("--body <json>", "请求体 JSON").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, "/models/catalog/db", JSON.parse(_o.body)), g.format);
  });

  catalog.command("db-set-status").description("更新模型状态").requiredOption("--model-ref <ref>", "模型引用").requiredOption("--status <s>", "目标状态").option("--degradation-score <n>", "降级评分 0~1").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    const body: Record<string, unknown> = { status: _o.status };
    if (_o.degradationScore !== undefined) body.degradationScore = Number(_o.degradationScore);
    printResult(await apiPatch(o, `/models/catalog/db/${encodeURIComponent(_o.modelRef)}/status`, body), g.format);
  });

  catalog.command("db-delete").description("删除模型注册").requiredOption("--model-ref <ref>", "模型引用").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiDelete(o, `/models/catalog/db/${encodeURIComponent(_o.modelRef)}`), g.format);
  });

  // ─── Bindings ─────────────────────────────────────────────────
  const bindings = models.command("bindings").description("模型绑定管理");

  bindings.command("list").description("列出当前绑定").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/models/bindings"), g.format);
  });

  bindings.command("create").description("创建绑定").requiredOption("--body <json>", "请求体 JSON").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/models/bindings", JSON.parse(_o.body)), g.format);
  });

  bindings.command("delete").description("删除绑定").requiredOption("--id <id>", "绑定 ID").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiDelete(o, `/models/bindings/${encodeURIComponent(_o.id)}`), g.format);
  });

  // ─── Onboard ──────────────────────────────────────────────────
  models.command("onboard").description("一站式接入模型").requiredOption("--body <json>", "请求体 JSON").option("--idempotency-key <key>", "幂等键").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    const extra: Record<string, string> = {};
    if (_o.idempotencyKey) extra["idempotency-key"] = _o.idempotencyKey;
    printResult(await apiPost(o, "/models/onboard", JSON.parse(_o.body), extra), g.format);
  });

  // ─── Chat ─────────────────────────────────────────────────────
  models.command("chat").description("模型聊天调用（同步）").requiredOption("--body <json>", "请求体 JSON").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/models/chat", JSON.parse(_o.body)), g.format);
  });

  // ─── Routing Policies ─────────────────────────────────────────
  const routing = models.command("routing").description("模型路由策略管理");

  routing.command("list").description("列出路由策略").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/governance/model-gateway/routing"), g.format);
  });

  routing.command("upsert").description("创建/更新路由策略").requiredOption("--purpose <p>", "用途标识").requiredOption("--body <json>", "请求体 JSON").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPut(o, `/governance/model-gateway/routing/${encodeURIComponent(_o.purpose)}`, JSON.parse(_o.body)), g.format);
  });

  routing.command("disable").description("禁用路由策略").requiredOption("--purpose <p>", "用途标识").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/governance/model-gateway/routing/${encodeURIComponent(_o.purpose)}/disable`), g.format);
  });

  routing.command("delete").description("删除路由策略").requiredOption("--purpose <p>", "用途标识").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiDelete(o, `/governance/model-gateway/routing/${encodeURIComponent(_o.purpose)}`), g.format);
  });
}
