#!/usr/bin/env node
/**
 * openslin-admin CLI — 灵智 MindPal 智能体 OS 全量运维管理命令行工具
 *
 * 架构：Commander.js 框架 + 模块化命令注册
 * 每个领域一个命令模块，通过 registerXxxCommands(program) 注册到根 Command
 */
import { Command } from "commander";
import { addGlobalOptions } from "./lib/globalOptions";

// ── 命令模块导入 ─────────────────────────────────────────────────
import { registerHealthCommands } from "./commands/health";
import { registerDiagnosticsCommands } from "./commands/diagnostics";
import { registerAuthCommands } from "./commands/auth";
import { registerRbacCommands } from "./commands/rbac";
import { registerScimCommands } from "./commands/scim";
import { registerSpacesCommands } from "./commands/spaces";
import { registerSchemasCommands, registerEntitiesCommands, registerToolsCommands } from "./commands/modeling";
import { registerChangesetsCommands, registerEvalsCommands, registerPolicyCommands, registerApprovalsCommands } from "./commands/governance";
import { registerRunsCommands } from "./commands/runs";
import { registerJobsCommands } from "./commands/jobs";
import { registerSecretsCommands } from "./commands/secrets";
import { registerKeyringCommands } from "./commands/keyring";
import { registerAuditCommands } from "./commands/audit";
import { registerSettingsCommands } from "./commands/settings";
import { registerNotificationsCommands } from "./commands/notifications";
import { registerSkillsCommands } from "./commands/skills";
import { registerKnowledgeCommands } from "./commands/knowledge";
import { registerFederationCommands } from "./commands/federation";
import { registerUiCommands } from "./commands/ui";
import { registerConfigCommands } from "./commands/config";
import { registerArtifactPolicyCommands } from "./commands/artifactPolicy";
import { registerIntegrationsCommands } from "./commands/integrations";
import { registerCollabCommands } from "./commands/collab";
import { registerObservabilityCommands } from "./commands/observability";
import { registerBackupsCommands } from "./commands/backups";
import { registerModelsCommands } from "./commands/models";
import { registerMeCommands } from "./commands/me";

// ── 主程序构建 ───────────────────────────────────────────────────
const program = new Command();
program
  .name("openslin-admin")
  .description("灵智 MindPal 智能体 OS — 运维管理 CLI (覆盖全量 250+ API 端点)")
  .version("0.1.0");

// 注册全局选项 (--api-base, --token, --tenant-id, --space-id, --format)
addGlobalOptions(program);

// ── 注册全部命令模块 ─────────────────────────────────────────────
// 基础运维
registerHealthCommands(program);       // health live|ready|full|db-pool|system
registerDiagnosticsCommands(program);  // diagnostics status|dump|metrics
registerMeCommands(program);           // me info|prefs-get|prefs-set

// 认证与权限
registerAuthCommands(program);         // auth tokens|mfa|sso
registerRbacCommands(program);         // rbac roles|permissions|bindings|check|abac
registerScimCommands(program);         // scim users|groups|config

// 空间与组织
registerSpacesCommands(program);       // spaces list|get|create|delete|members|org-units

// 建模
registerSchemasCommands(program);      // schemas list|get|publish|effective|...
registerEntitiesCommands(program);     // entities list|get|query|create|update|delete|export|import
registerToolsCommands(program);        // tools list|get|publish|execute|network-policies|...

// 变更集 & 评估 & 策略 & 审批
registerChangesetsCommands(program);   // changesets list|get|create|submit|approve|release|...
registerEvalsCommands(program);        // evals suites|runs|dashboard
registerPolicyCommands(program);       // policy snapshots|debug|cache|versions
registerApprovalsCommands(program);    // approvals list|get|decide
registerAuditCommands(program);        // audit list|verify|legal-holds|exports|siem
registerSettingsCommands(program);     // settings locale|retention
registerConfigCommands(program);       // config registry|overrides|resolve
registerArtifactPolicyCommands(program); // artifact-policy get|set
registerUiCommands(program);           // ui component-registry

// 执行引擎
registerRunsCommands(program);         // runs list|get|cancel|retry|pause|resume|skip|...
registerJobsCommands(program);         // jobs create|get

// 安全
registerSecretsCommands(program);      // secrets list|get|create|revoke|rotate
registerKeyringCommands(program);      // keyring init|rotate|disable|reencrypt

// 通知
registerNotificationsCommands(program); // notifications prefs|inbox

// Skill 运行时
registerSkillsCommands(program);       // skills lifecycle|runners|trusted-keys

// 模型网关
registerModelsCommands(program);       // models catalog|bindings|onboard|chat|routing

// 知识库
registerKnowledgeCommands(program);    // knowledge documents|strategies|jobs|quality

// 联邦
registerFederationCommands(program);   // federation nodes|grants|content-policies

// 集成与协作
registerIntegrationsCommands(program); // integrations list|get
registerCollabCommands(program);       // collab diagnostics

// 可观测性
registerObservabilityCommands(program); // observability summary|operations|vocab

// 备份
registerBackupsCommands(program);      // backups list|get|create|restore

// ── 解析并执行 ──────────────────────────────────────────────────
program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(String((err as Error)?.message ?? "unexpected error"));
  process.exitCode = 1;
});
