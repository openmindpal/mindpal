/**
 * serverRoutes.ts — /v1 版本化路由注册
 *
 * 包含全局 /v1 前缀下的所有路由注册逻辑：
 * 中间件挂载、分组路由、内置 Skill 注册、启动校验。
 */
import type { FastifyInstance } from "fastify";
import { authMiddleware } from "./middleware/authMiddleware";
import { observabilityMiddleware } from "./middleware/observabilityMiddleware";
import { contextMiddleware } from "./middleware/contextMiddleware";
import { registerAllRoutes } from "./routes/index";
import { getBuiltinSkills, runStartupConsistencyCheck } from "./lib/skillPlugin";
import { initBuiltinSkills, checkSkillLayerConsistency } from "./skills/registry";
import { autoDiscoverAndRegisterTools } from "./modules/tools/toolAutoDiscovery";
import { runBoundaryScan, formatBoundaryScanReport } from "./lib/startupBoundaryScan";
import { validateVectorDimensions } from "./db/pool";

/**
 * 注册 /v1 作用域下的所有路由、中间件、Skill 及启动校验。
 * 由 server.ts 的 app.register(..., { prefix: "/v1" }) 调用。
 */
export async function registerV1Routes(scoped: FastifyInstance): Promise<void> {
  const app = scoped.server ? scoped : scoped; // top-level reference

  // 中间件按阶段注册（顺序重要）
  authMiddleware(scoped);        // Phase 1: 认证与授权
  observabilityMiddleware(scoped); // Phase 2: 审计、DLP、指标
  contextMiddleware(scoped);     // Phase 3: 业务上下文、租户隔离/配额

  // ── 分组路由注册 ──
  await registerAllRoutes(scoped);

  // ── Built-in Skill Routes (auto-discovered) ────────────────────
  const skillLoadResult = await initBuiltinSkills();
  if (skillLoadResult.degraded) {
    scoped.log.error(`[SkillRegistry] DEGRADED: ${skillLoadResult.errors.length} plugin(s) failed to load`);
    for (const e of skillLoadResult.errors) scoped.log.error(`  - ${e}`);
  }

  const startupCheck = runStartupConsistencyCheck();
  if (startupCheck.warnings.length > 0) {
    for (const w of startupCheck.warnings) scoped.log.warn(w);
  }
  if (!startupCheck.ok) {
    for (const e of startupCheck.errors) scoped.log.error(e);
    throw new Error(`[startup] Skill registry consistency check failed: ${startupCheck.errors.join("; ")}`);
  }
  scoped.log.info(startupCheck.summary, "[startup] Skill registry consistency check passed");

  // ── Skill Layer Consistency Check ─────────────────────────────
  const layerCheck = await checkSkillLayerConsistency();
  if (!layerCheck.ok) {
    scoped.log.warn({ mismatches: layerCheck.layerMismatches, orphans: layerCheck.orphanedDirs }, layerCheck.summary);
  } else {
    scoped.log.info(layerCheck.summary);
  }

  try {
    const srcRoot = __dirname;
    const scanResult = runBoundaryScan(srcRoot);
    if (!scanResult.ok || scanResult.warnings.length > 0) {
      scoped.log.warn(formatBoundaryScanReport(scanResult));
    }
    scoped.log.info(
      { scannedFiles: scanResult.scannedFiles, violations: scanResult.violations.length, ok: scanResult.ok },
      "[startup] Module boundary scan completed",
    );
  } catch (e: any) {
    scoped.log.warn({ err: e?.message }, "[startup] Module boundary scan skipped (non-fatal)");
  }

  // ── Built-in Skill Routes（统一注册在 /v1 作用域下） ────────
  const registeredSkills: string[] = [];
  for (const [name, skill] of getBuiltinSkills()) {
    scoped.register(skill.routes);
    registeredSkills.push(name);
  }
  scoped.log.info({ registeredSkills: registeredSkills.length, skills: registeredSkills }, "[startup] Built-in skills registered");

  // ── P2-1: 向量维度一致性校验 ──
  await validateVectorDimensions(scoped.db, scoped.log);

  try {
    const discovery = await autoDiscoverAndRegisterTools(scoped.db);
    scoped.log.info({ registered: discovery.registered, skipped: discovery.skipped }, "[startup] Tool discovery completed");
  } catch (e: unknown) {
    scoped.log.error({ err: e }, "[startup] Tool discovery failed (non-fatal)");
  }

  try {
    const db = scoped.db;
    const bindingRes = await db.query(
      `SELECT model_ref, status FROM provider_bindings WHERE status = 'enabled' LIMIT 10`
    );
    const enabledCount = bindingRes.rowCount ?? 0;
    if (enabledCount === 0) {
      scoped.log.warn(
        "[startup] ⚠️ 未找到任何已启用的模型绑定 (provider_bindings)\u3002" +
        "编排/意图分类/工具建议等功能将无法正常工作。" +
        "请通过 [设置 > 模型接入] 配置至少一个模型绑定。"
      );
    } else {
      const refs = bindingRes.rows.map((r: any) => r.model_ref);
      scoped.log.info({ count: enabledCount, models: refs }, "[startup] Model bindings check passed");
    }
  } catch (e: any) {
    scoped.log.warn({ err: e?.message }, "[startup] Model bindings check skipped (table may not exist)");
  }
}
