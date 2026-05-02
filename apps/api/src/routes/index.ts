/**
 * 路由注册入口 — 按逻辑域分组
 *
 * 功能目标：将 25+ 个路由的线性注册改为按业务域分组，
 * 提升可读性和可维护性，不改变任何路由的功能行为。
 */
import type { FastifyInstance } from "fastify";
import { entityRoutes } from "./data/entities";
import { effectiveSchemaRoutes } from "./data/effectiveSchema";
import { schemaRoutes } from "./data/schemas";
import { toolRoutes } from "./tools/tools";
import { toolCategoryRoutes } from "./tools/toolCategory";
import { secretRoutes } from "./tools/secrets";
import { keyringRoutes } from "./tools/keyring";
import { jobRoutes } from "./runs/jobs";
import { runRoutes } from "./runs";
import { governanceRoutes } from "./governance";
import { rbacRoutes } from "./auth/rbac";
import { approvalRoutes } from "./audit/approvals";
import { policySnapshotRoutes } from "./audit/policySnapshots";
import { auditRoutes } from "./audit/audit";
import { settingsRoutes } from "./system/settings";
import { healthRoutes } from "./system/health";
import { diagnosticsRoutes } from "./system/diagnostics";
import { metricsRoutes } from "./system/metrics";
import { meRoutes } from "./me";
import { authTokenRoutes } from "./auth/authTokens";
import { scimRoutes } from "./scimRoutes";
import { notificationPreferenceRoutes } from "./notificationPreferences";
import { spacesRoutes } from "./data/spaces";
import { skillLifecycleRoutes } from "./extended";
import { audioRoutes } from "./media/audio";
import { memoryRoutes } from "./memory";

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

// ── 记忆管理路由 ──
async function memoryGroup(app: FastifyInstance) {
  app.register(memoryRoutes);
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
  await app.register(memoryGroup);
}
