import { StructuredLogger, resolveString } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:skillRegistry" });

/**
 * Built-in Skill Registry.
 *
 * 代码驱动：所有 Skill 的分层由插件目录与核心清单决定，
 * 启停通过环境变量覆盖，不再依赖 DB 中的 skill_manifests 表。
 * 所有可用的插件通过 ALL_AVAILABLE_PLUGINS 目录注册，
 * 启动时直接基于代码 manifest 决定哪些要注册。
 *
 * 四层结构：
 *   kernel        — 核心平台工具声明，始终自动启用
 *   core          — 基本平台能力，始终注册，不可禁用
 *   optional      — 可选平台能力，默认注册，可禁用
 *   extension     — 扩展层能力，按需加载
 *
 * ═══════════════════════════════════════════════════════════════════
 * 职责边界：builtin manifests vs tool_definitions
 * ═══════════════════════════════════════════════════════════════════
 *
 *  builtin manifests（本模块读取）:
 *    - 控制"平台内置插件"的分层（kernel/core/optional/extension）
 *    - 仅在启动时由 initBuiltinSkills() 读取一次
 *    - 决定哪些 BuiltinSkillPlugin 被注册到内存中的 Skill Registry
 *    - 不直接影响 Agent Loop 的工具可见性
 *
 *  tool_definitions 表（toolAutoDiscovery 模块写入，agentContext 模块读取）:
 *    - Agent Loop (discoverEnabledTools) 的唯一工具注册表
 *    - 由 autoDiscoverAndRegisterTools() 从已注册的 Skill 插件 → 写入
 *    - LLM 能"看到"并调用的工具列表完全由此表决定
 *
 *  数据流：builtin manifests → initBuiltinSkills → Skill Registry (内存)
 *          → autoDiscoverAndRegisterTools → DB tool_definitions
 *          → discoverEnabledTools → Agent Loop
 * ═══════════════════════════════════════════════════════════════════
 */
import { isBuiltinSkillRegistrySealed, registerBuiltinSkill, sealBuiltinSkillRegistry } from "../lib/skillPlugin";
import type { BuiltinSkillPlugin } from "../lib/skillPlugin";
import type { FastifyPluginAsync } from "fastify";
import * as path from "node:path";

// ── Manifest-driven skill loading ─────────────────────────────────
import manifestEntries from "./builtin-skills-manifest.json";

// ── Cross-layer contracts ─────────────────────────────────────────
import { registerPageConfigContract } from "../modules/contracts/pageConfigContract";
import { registerWorkbenchContract } from "../modules/contracts/workbenchContract";
import { registerKnowledgeContract } from "../modules/contracts/knowledgeContract";

/* ------------------------------------------------------------------ */
/*  ALL_AVAILABLE_PLUGINS — 所有可用插件的统一目录                     */
/*  从 builtin-skills-manifest.json 驱动，新增插件只需修改 manifest    */
/*  延迟初始化：首次调用时加载 manifest 中声明的模块                    */
/* ------------------------------------------------------------------ */

/** 内联定义的 kernel 插件映射（无独立模块文件） */
const INLINE_PLUGINS: Record<string, () => BuiltinSkillPlugin> = {
  "entity.kernel": () => entityKernel,
  "system.tool.governance": () => toolGovernanceKernel,
};

let _allAvailablePlugins: ReadonlyMap<string, BuiltinSkillPlugin> | null = null;

/** 获取所有可用插件的统一目录（延迟初始化，manifest 驱动） */
function getAllAvailablePlugins(): ReadonlyMap<string, BuiltinSkillPlugin> {
  if (_allAvailablePlugins) return _allAvailablePlugins;

  const map = new Map<string, BuiltinSkillPlugin>();
  for (const entry of manifestEntries) {
    try {
      if (entry.module === "__inline__") {
        const factory = INLINE_PLUGINS[entry.key];
        if (factory) {
          map.set(entry.key, factory());
        } else {
          _logger.warn("[SkillRegistry] No inline plugin for manifest key", { key: entry.key });
        }
        continue;
      }
      const resolved = path.resolve(__dirname, entry.module);
      const mod = require(resolved);
      const plugin: BuiltinSkillPlugin = mod.default ?? mod;
      map.set(entry.key, plugin);
    } catch (err) {
      _logger.warn("[SkillRegistry] Failed to load skill from manifest", {
        key: entry.key,
        module: entry.module,
        error: String(err),
      });
    }
  }
  _allAvailablePlugins = map;
  return _allAvailablePlugins;
}

/** 兼容性导出：静态常量（指向动态构建，仅用于旧代码引用） */
export const CORE_BUILTIN_SKILL_KEYS: readonly string[] = [];
export const OPTIONAL_BUILTIN_SKILL_KEYS: readonly string[] = [];

/* ------------------------------------------------------------------ */
/*  四层架构一致性校验                                                 */
/* ------------------------------------------------------------------ */

export interface SkillLayerCheckResult {
  ok: boolean;
  /** 注册在械文件中但 manifest.layer 与实际桶不匹配 */
  layerMismatches: Array<{ key: string; declaredLayer: string; actualBucket: string }>;
  /** skills/ 目录下存在但未在 ALL_AVAILABLE_PLUGINS 中注册的目录 */
  orphanedDirs: string[];
  summary: string;
}

/**
 * 校验所有已注册插件的 manifest.layer 与其实际桶分配一致。
 *
 * 启动时调用，产出 warn 日志，不阻断启动。
 */
export function checkSkillLayerConsistency(): SkillLayerCheckResult {
  const plugins = getAllAvailablePlugins();
  const layerMismatches: SkillLayerCheckResult["layerMismatches"] = [];
  const orphanedDirs: string[] = [];

  // 桶分配映射（从 manifest 读取 tier）
  const bucketMap: Record<string, "kernel" | "core" | "optional" | "extension"> = {};
  const manifestTierMap = new Map(manifestEntries.map(e => [e.key, e.tier as "kernel" | "core" | "optional" | "extension"]));
  for (const key of plugins.keys()) {
    bucketMap[key] = manifestTierMap.get(key) ?? "optional";
  }

  // 校验 layer 声明一致性
  for (const [key, plugin] of plugins) {
    const declaredLayer = plugin.manifest.layer ?? "optional";
    const bucket = bucketMap[key];
    // 向后兼容："builtin" 统一归一化为 "optional"
    const normalizedDeclared = (declaredLayer as string) === "builtin" ? "optional" : declaredLayer;
    if (normalizedDeclared !== bucket) {
      layerMismatches.push({ key, declaredLayer, actualBucket: bucket });
    }
  }

  // 检查孤立目录（存在于 skills/ 但未注册）
  const registeredDirNames = new Set<string>();
  for (const [, plugin] of plugins) {
    // 提取目录名约定：identity.name 中的点分隔对应目录名的短横线
    const dirName = plugin.manifest.identity.name.replace(/\./g, "-");
    registeredDirNames.add(dirName);
  }
  // 特殊目录（非插件目录）
  const specialDirs = new Set(["builtin", "extension", "kernel", "registry.ts"]);
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const entries = fs.readdirSync(__dirname, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (specialDirs.has(entry.name)) continue;
      if (!registeredDirNames.has(entry.name)) {
        orphanedDirs.push(entry.name);
      }
    }
  } catch {
    // 目录扫描失败不影响核心流程
  }

  const ok = layerMismatches.length === 0 && orphanedDirs.length === 0;
  const parts: string[] = [`${plugins.size} plugins checked`];
  if (layerMismatches.length > 0) {
    parts.push(`${layerMismatches.length} layer mismatch(es)`);
  }
  if (orphanedDirs.length > 0) {
    parts.push(`${orphanedDirs.length} orphaned dir(s): ${orphanedDirs.join(", ")}`);
  }
  if (ok) parts.push("all consistent");

  return {
    ok,
    layerMismatches,
    orphanedDirs,
    summary: `[SkillLayerCheck] ${parts.join("; ")}`,
  };
}

/* ------------------------------------------------------------------ */
/*  内置 Skill Manifest 解析                                            */
/*                                                                      */
/*  注意：builtin manifests 仅控制"哪些内置插件要注册到 Skill Registry"， */
/*  不直接影响 Agent Loop 工具可见性。Agent Loop 读取的是                */
/*  tool_definitions 表（由 toolAutoDiscovery 模块负责写入）。           */
/* ------------------------------------------------------------------ */

export type SkillManifestRow = {
  skillKey: string;
  tier: "kernel" | "core" | "optional" | "extension";
  status: "enabled" | "disabled";
};

/** Manifest 驱动的 tier 映射 */
const _manifestTierLookup = new Map(
  manifestEntries.map(e => [e.key, e.tier as "kernel" | "core" | "optional" | "extension"]),
);

/** 从 manifest 构建内置 Skill manifests。 */
function buildBuiltinManifests(): SkillManifestRow[] {
  const rows: SkillManifestRow[] = [];
  for (const [key] of getAllAvailablePlugins()) {
    const tier = _manifestTierLookup.get(key) ?? "optional";
    rows.push({ skillKey: key, tier, status: "enabled" });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/*  兼容性导出（从代码 manifest 动态构建）                            */
/* ------------------------------------------------------------------ */

/** 从已加载的 manifests 中提取指定 tier 的 key 列表 */
function keysForTier(manifests: SkillManifestRow[], tier: string): string[] {
  return manifests.filter(m => m.tier === tier).map(m => m.skillKey);
}

/** 缓存的 manifest 列表，启动后可查询 */
let _cachedManifests: SkillManifestRow[] = [];

let _crossLayerContractsLoaded = false;

/** 兼容性导出：核心层 skill key 列表（动态构建） */
export function getCoreBuiltinSkillKeys(): readonly string[] {
  return keysForTier(_cachedManifests, "core");
}

/** 兼容性导出：可选层 skill key 列表（动态构建） */
export function getOptionalBuiltinSkillKeys(): readonly string[] {
  return keysForTier(_cachedManifests, "optional");
}

async function registerCrossLayerContractsOnce(): Promise<void> {
  if (_crossLayerContractsLoaded) return;
  const [
    pageRepo,
    pageModel,
    workbenchRepo,
    knowledgeRepo,
  ] = await Promise.all([
    import("./ui-page-config/modules/pageRepo"),
    import("./ui-page-config/modules/pageModel"),
    import("./workbench-manager/modules/workbenchRepo"),
    import("./knowledge-rag/modules/repo"),
  ]);

  registerPageConfigContract({
    getDraft: pageRepo.getDraft,
    getLatestReleased: pageRepo.getLatestReleased,
    publishFromDraft: pageRepo.publishFromDraft,
    rollbackToPreviousReleased: pageRepo.rollbackToPreviousReleased,
    cloneReleasedVersion: pageRepo.cloneReleasedVersion,
    setPageVersionStatus: pageRepo.setPageVersionStatus,
    pageDraftSchema: pageModel.pageDraftSchema,
  });

  registerWorkbenchContract({
    getActiveVersion: workbenchRepo.getActiveVersion as any,
    getDraftVersion: workbenchRepo.getDraftVersion as any,
    getLatestReleasedVersion: workbenchRepo.getLatestReleasedVersion as any,
    getPreviousReleasedVersion: workbenchRepo.getPreviousReleasedVersion as any,
    publishFromDraft: workbenchRepo.publishFromDraft as any,
    rollbackActiveToPreviousReleased: workbenchRepo.rollbackActiveToPreviousReleased as any,
    setActiveVersion: workbenchRepo.setActiveVersion as any,
    clearActiveVersion: workbenchRepo.clearActiveVersion as any,
    getCanaryConfig: workbenchRepo.getCanaryConfig as any,
    setCanaryConfig: workbenchRepo.setCanaryConfig as any,
    clearCanaryConfig: workbenchRepo.clearCanaryConfig as any,
  });

  registerKnowledgeContract({
    searchChunksHybrid: knowledgeRepo.searchChunksHybrid,
  });
  _crossLayerContractsLoaded = true;
}

/* ------------------------------------------------------------------ */
/*  环境变量覆盖层解析                                                   */
/* ------------------------------------------------------------------ */

/** 解析 DISABLED_BUILTIN_SKILLS 环境变量，返回禁用的 skill key 集合 */
function parseEnvDisabledBuiltins(): Set<string> {
  const raw = process.env.DISABLED_BUILTIN_SKILLS || "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

/** 解析 ENABLED_EXTENSIONS 环境变量，返回额外启用的 extension skill key 集合 */
function parseEnvEnabledExtensions(manifests: SkillManifestRow[]): Set<string> {
  const raw = resolveString("ENABLED_EXTENSIONS").value;
  const enabled = new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
  // 只保留 manifests 中存在的 extension 层 skill
  const extKeys = new Set(manifests.filter(m => m.tier === "extension").map(m => m.skillKey));
  return new Set([...enabled].filter(k => extKeys.has(k)));
}

/**
 * 代码驱动的 Skill 初始化。
 *
 * 环境变量 DISABLED_BUILTIN_SKILLS / ENABLED_EXTENSIONS 作为额外覆盖层。
 */
export async function initBuiltinSkills(): Promise<void> {
  if (isBuiltinSkillRegistrySealed()) return;

  const manifests = buildBuiltinManifests();
  _cachedManifests = manifests;

  // ── 环境变量覆盖层 ──
  const envDisabled = parseEnvDisabledBuiltins();
  const envEnabledExt = parseEnvEnabledExtensions(manifests);

  // ── 按元数据注册 ──
  for (const m of manifests) {
    const plugin = getAllAvailablePlugins().get(m.skillKey);
    if (!plugin) {
      _logger.warn("unknown builtin skill_key, skipping", { skillKey: m.skillKey });
      continue;
    }

    // kernel / core — 始终注册
    if (m.tier === "kernel" || m.tier === "core") {
      registerBuiltinSkill(plugin);
      continue;
    }

    // optional — 环境变量覆盖
    if (m.tier === "optional") {
      if (m.status === "disabled" || envDisabled.has(m.skillKey)) {
        _logger.info("optional skill skipped", { skillKey: m.skillKey });
        continue;
      }
      registerBuiltinSkill(plugin);
      continue;
    }

    // extension — 环境变量覆盖
    if (m.tier === "extension") {
      if (m.status === "disabled" && !envEnabledExt.has(m.skillKey)) {
        continue;
      }
      if (m.status === "enabled" || envEnabledExt.has(m.skillKey)) {
        registerBuiltinSkill(plugin);
      }
      continue;
    }
  }

  // ── Cross-layer contract registration ─────────────────────────────
  // modules/ 通过 contract 接口间接调用 skills/ 实现，避免反向依赖
  await registerCrossLayerContractsOnce();

  // Seal the registry to prevent further registrations
  sealBuiltinSkillRegistry();
}

/**
 * Kernel entity tools — core platform operations, no HTTP routes.
 * Declared here so auto-discovery can register them as tool_definitions.
 */
const noopRoutes: FastifyPluginAsync = async () => {};
const entityKernel: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "entity.kernel", version: "1.0.0" },
    layer: "kernel",
    tools: [
      {
        name: "entity.list",
        displayName: { "zh-CN": "查询实体列表", "en-US": "List entity records" },
        description: { "zh-CN": "列出指定实体的数据记录，按更新时间倒序返回", "en-US": "List records of a given entity ordered by last update" },
        scope: "read",
        resourceType: "entity",
        action: "list",
        riskLevel: "low",
        inputSchema: { fields: { entityName: { type: "string", required: true }, limit: { type: "number" } } },
        outputSchema: { fields: { items: { type: "json" } } },
      },
      {
        name: "entity.create",
        displayName: { "zh-CN": "创建实体", "en-US": "Create entity" },
        description: { "zh-CN": "创建实体数据记录", "en-US": "Create an entity record" },
        scope: "write",
        resourceType: "entity",
        action: "create",
        idempotencyRequired: true,
        riskLevel: "high",
        approvalRequired: true,
        inputSchema: { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, payload: { type: "json", required: true } } },
        outputSchema: { fields: { recordId: { type: "string" }, idempotentHit: { type: "boolean" } } },
      },
      {
        name: "entity.update",
        displayName: { "zh-CN": "更新实体", "en-US": "Update entity" },
        description: { "zh-CN": "更新实体数据记录", "en-US": "Update an entity record" },
        scope: "write",
        resourceType: "entity",
        action: "update",
        idempotencyRequired: true,
        riskLevel: "high",
        approvalRequired: true,
        inputSchema: { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, id: { type: "string", required: true }, patch: { type: "json", required: true }, expectedRevision: { type: "number" } } },
        outputSchema: { fields: { recordId: { type: "string" }, idempotentHit: { type: "boolean" } } },
      },
      {
        name: "entity.delete",
        displayName: { "zh-CN": "删除实体", "en-US": "Delete entity" },
        description: { "zh-CN": "删除实体数据记录", "en-US": "Delete an entity record" },
        scope: "write",
        resourceType: "entity",
        action: "delete",
        idempotencyRequired: true,
        riskLevel: "high",
        approvalRequired: true,
        inputSchema: { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, id: { type: "string", required: true } } },
        outputSchema: { fields: { recordId: { type: "string" }, idempotentHit: { type: "boolean" }, deleted: { type: "boolean" } } },
      },
    ],
  },
  routes: noopRoutes,
};

/**
 * Tool Governance Kernel — 工具白名单管理工具，通过对话即可启用/停用工具。
 * Kernel 层：始终注册、始终自动启用，无需额外白名单配置。
 */
const toolGovernanceKernel: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "system.tool.governance", version: "1.0.0" },
    layer: "kernel",
    tools: [
      {
        name: "system.tool.list",
        displayName: { "zh-CN": "列出工具", "en-US": "List tools" },
        description: { "zh-CN": "列出所有已注册工具及其启用/禁用状态，支持按范围(tenant/space)过滤", "en-US": "List all registered tools with their enabled/disabled status, supports scope filtering" },
        scope: "read",
        resourceType: "governance",
        action: "tool.list",
        riskLevel: "low",
        inputSchema: { fields: { scopeType: { type: "string", description: "过滤范围: tenant 或 space，不传则返回全部" } } },
        outputSchema: { fields: { tools: { type: "array" }, rollouts: { type: "array" } } },
      },
      {
        name: "system.tool.enable",
        displayName: { "zh-CN": "启用工具", "en-US": "Enable tool" },
        description: { "zh-CN": "将指定工具加入白名单（启用），使 AI 可以调用该工具", "en-US": "Enable a tool (add to whitelist) so AI can invoke it" },
        scope: "write",
        resourceType: "governance",
        action: "tool.enable",
        riskLevel: "medium",
        idempotencyRequired: true,
        inputSchema: { fields: { toolRef: { type: "string", required: true, description: "工具引用，如 desktop.screen.capture@1" }, scopeType: { type: "string", description: "范围: tenant 或 space，默认 space" } } },
        outputSchema: { fields: { enabled: { type: "boolean" }, toolRef: { type: "string" }, previousEnabled: { type: "boolean" } } },
      },
      {
        name: "system.tool.disable",
        displayName: { "zh-CN": "禁用工具", "en-US": "Disable tool" },
        description: { "zh-CN": "将指定工具移出白名单（禁用），AI 将无法调用该工具", "en-US": "Disable a tool (remove from whitelist) so AI cannot invoke it" },
        scope: "write",
        resourceType: "governance",
        action: "tool.disable",
        riskLevel: "medium",
        idempotencyRequired: true,
        inputSchema: { fields: { toolRef: { type: "string", required: true, description: "工具引用，如 desktop.screen.capture@1" }, scopeType: { type: "string", description: "范围: tenant 或 space，默认 space" } } },
        outputSchema: { fields: { enabled: { type: "boolean" }, toolRef: { type: "string" }, previousEnabled: { type: "boolean" } } },
      },
    ],
  },
  routes: noopRoutes,
};
