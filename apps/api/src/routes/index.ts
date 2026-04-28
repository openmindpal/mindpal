/**
 * 路由注册入口 — 按逻辑域分组
 *
 * 功能目标：将 25+ 个路由的线性注册改为按业务域分组，
 * 提升可读性和可维护性，不改变任何路由的功能行为。
 */
import type { FastifyInstance } from "fastify";
import { entityRoutes } from "./entities";
import { effectiveSchemaRoutes } from "./effectiveSchema";
import { schemaRoutes } from "./schemas";
import { toolRoutes } from "./tools";
import { toolCategoryRoutes } from "./toolCategory";
import { secretRoutes } from "./secrets";
import { keyringRoutes } from "./keyring";
import { jobRoutes } from "./jobs";
import { runRoutes } from "./runs";
import { governanceRoutes } from "./governance";
import { rbacRoutes } from "./rbac";
import { approvalRoutes } from "./approvals";
import { policySnapshotRoutes } from "./policySnapshots";
import { auditRoutes } from "./audit";
import { settingsRoutes } from "./settings";
import { healthRoutes } from "./health";
import { diagnosticsRoutes } from "./diagnostics";
import { metricsRoutes } from "./metrics";
import { meRoutes } from "./me";
import { authTokenRoutes } from "./authTokens";
import { scimRoutes } from "./scimRoutes";
import { notificationPreferenceRoutes } from "./notificationPreferences";
import { spacesRoutes } from "./spaces";
import { skillLifecycleRoutes } from "./extended";
import { audioRoutes } from "./audio";

// ── 核心数据路由 ──
async function coreDataRoutes(app: FastifyInstance) {
  app.register(entityRoutes);
  app.register(effectiveSchemaRoutes);
  app.register(schemaRoutes);
  app.register(toolRoutes);
  app.register(toolCategoryRoutes);
  app.register(secretRoutes);
  app.register(keyringRoutes);
}

// ── 执行引擎路由 ──
async function executionRoutes(app: FastifyInstance) {
  app.register(jobRoutes);
  app.register(runRoutes);
}

// ── 治理路由 ──
async function governanceGroup(app: FastifyInstance) {
  app.register(governanceRoutes);
  app.register(rbacRoutes);
  app.register(approvalRoutes);
  app.register(policySnapshotRoutes);
  app.register(auditRoutes);
}

// ── 系统路由 ──
async function systemRoutes(app: FastifyInstance) {
  app.register(healthRoutes);
  app.register(diagnosticsRoutes);
  app.register(metricsRoutes);
  app.register(settingsRoutes);
}

// ── 身份与用户路由 ──
async function identityRoutes(app: FastifyInstance) {
  app.register(meRoutes);
  app.register(authTokenRoutes);
  app.register(scimRoutes);
  app.register(notificationPreferenceRoutes);
}

// ── 协作与空间路由 ──
async function collabRoutes(app: FastifyInstance) {
  app.register(spacesRoutes);
}

// ── 技能生命周期路由 ──
async function skillRoutes(app: FastifyInstance) {
  app.register(skillLifecycleRoutes);
}

// ── 音频服务路由 ──
async function audioGroup(app: FastifyInstance) {
  app.register(audioRoutes);
}

export async function registerAllRoutes(app: FastifyInstance): Promise<void> {
  await app.register(systemRoutes);
  await app.register(identityRoutes);
  await app.register(governanceGroup);
  await app.register(coreDataRoutes);
  await app.register(executionRoutes);
  await app.register(collabRoutes);
  await app.register(skillRoutes);
  await app.register(audioGroup);
}
