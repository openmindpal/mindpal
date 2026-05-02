/**
 * Tool Auto-Discovery — 控制面与数据面之间的「同步桥梁」。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 架构定位：
 *   - 控制面（skill_manifests / builtin-skills-manifest.json + 环境变量）
 *     决定"哪些 Skill 被启用"——由 registry.ts initBuiltinSkills() 消费。
 *   - 数据面（tool_definitions 表）
 *     决定"哪些工具可被 LLM 调用"——由 agentContext.discoverEnabledTools() 消费。
 *   - 本模块（toolAutoDiscovery）= 两者之间的同步桥梁：
 *     将控制面已启用的 Skill 插件 → 投射写入数据面 tool_definitions 表。
 * ═══════════════════════════════════════════════════════════════════
 *
 * 自动发现并注册来自三个来源的工具：
 * 1. 内置 Skill 插件（manifest.tools 声明）— 如 memory.read, entity.create
 * 2. 外部 Skill 包（skills/ 目录 manifest.json）— 如 collab.guard, sleep
 * 3. 内置 Skill 身份（无显式 tools 的插件）— 注册为 builtin_skill
 *
 * 对每个发现的工具，确保：
 * - tool_definitions 行存在
 * - tool_versions 行（v1, released）存在
 * - tool_active_versions 行存在（指向 @1）
 * - tool_rollouts 行存在（在 tenant 级别启用）
 *
 * 注意：本模块不判断"工具是否可被 LLM 调用"——该判断由
 * agentContext.discoverEnabledTools() 基于 tool_definitions + tool_rollouts 执行。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { getBuiltinSkills, isBuiltinSkillRegistrySealed, resolveSkillLayer } from "../../lib/skillPlugin";
import type { SkillLayer } from "../../lib/skillPlugin";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "toolAutoDiscovery" });

/* ------------------------------------------------------------------ */
/*  Fallback 常量（DB resource_type_profiles 不可用时的降级）                */
/*                                                                      */
/*  元数据驱动原则：                                                  */
/*   1. 优先从 manifest 声明中读取 category / priority / tags             */
/*   2. 其次从 DB resource_type_profiles 表中读取                        */
/*   3. fallback 仅提供无语义的安全默认值，不内置业务语义判断        */
/* ------------------------------------------------------------------ */

const FALLBACK_CATEGORY = "uncategorized";
const FALLBACK_PRIORITY = 5;
const FALLBACK_TAGS: string[] = [];

/* ------------------------------------------------------------------ */
/*  DB 驱动的 ResourceTypeProfile 缓存                                 */
/* ------------------------------------------------------------------ */

interface ResourceTypeProfile {
  resource_type: string;
  default_category: string;
  default_priority: number;
  default_tags: string[];
}

let _profileCache: Map<string, ResourceTypeProfile> | null = null;
let _profileCacheAt = 0;
const PROFILE_CACHE_TTL_MS = 60_000;

async function loadResourceTypeProfiles(pool: Pool): Promise<Map<string, ResourceTypeProfile>> {
  if (_profileCache && Date.now() - _profileCacheAt < PROFILE_CACHE_TTL_MS) {
    return _profileCache;
  }
  try {
    const { rows } = await pool.query(
      `SELECT resource_type, default_category, default_priority, default_tags
       FROM resource_type_profiles WHERE tenant_id = $1`,
      ["tenant_dev"],
    );
    _profileCache = new Map(
      rows.map((r: any) => [
        r.resource_type,
        {
          resource_type: r.resource_type,
          default_category: r.default_category,
          default_priority: r.default_priority,
          default_tags: r.default_tags ?? [],
        },
      ]),
    );
    _profileCacheAt = Date.now();
    return _profileCache;
  } catch {
    // DB 不可用时静默降级
    if (!_profileCache) _profileCache = new Map();
    return _profileCache;
  }
}

/* ------------------------------------------------------------------ */
/*  Helper: Infer category/priority/tags from resourceType             */
/* ------------------------------------------------------------------ */

function inferCategoryFromResourceType(
  resourceType: string,
  profiles?: Map<string, ResourceTypeProfile>,
): string {
  return profiles?.get(resourceType)?.default_category
    ?? FALLBACK_CATEGORY;
}

function inferPriorityFromResourceType(
  resourceType: string,
  profiles?: Map<string, ResourceTypeProfile>,
): number {
  return profiles?.get(resourceType)?.default_priority
    ?? FALLBACK_PRIORITY;
}

function inferTagsFromResourceType(
  resourceType: string,
  action: string,
  profiles?: Map<string, ResourceTypeProfile>,
): string[] {
  const baseTags = profiles?.get(resourceType)?.default_tags
    ?? FALLBACK_TAGS;
  return baseTags.length > 0 ? [...baseTags, action] : [action];
}

/* ------------------------------------------------------------------ */
/*  Common tool shape                                                  */
/* ------------------------------------------------------------------ */

interface DiscoveredTool {
  name: string;
  displayName: Record<string, string> | null;
  description: Record<string, string> | null;
  scope: "read" | "write";
  resourceType: string;
  action: string;
  idempotencyRequired: boolean;
  riskLevel: "low" | "medium" | "high";
  approvalRequired: boolean;
  inputSchema: any;
  outputSchema: any;
  artifactRef: string | null;
  /** Source layer classification. */
  sourceLayer: SkillLayer;
  /** P2: Tool category (communication/file/database/ai/governance etc.) */
  category?: string;
  /** P2: Tool priority 1-10, higher = more important */
  priority?: number;
  /** P2: Tool tags array */
  tags?: string[];
  /** 额外权限声明 [{resourceType, action}] */
  extraPermissions?: Array<{ resourceType: string; action: string }>;
  /** 工具执行超时时间(毫秒) */
  executionTimeoutMs?: number;
}

type CachedManifestTool = {
  signature: string;
  tool: DiscoveredTool | null;
};

/* ------------------------------------------------------------------ */
/*  Skill directory scanning                                           */
/* ------------------------------------------------------------------ */

function getSkillRoots(): string[] {
  const raw = String(process.env.SKILL_PACKAGE_ROOTS ?? "");
  const parts = raw.split(/[;,]/g).map((x) => x.trim()).filter(Boolean);
  const reg = String(process.env.SKILL_REGISTRY_DIR ?? "").trim();
  const registryRoot = path.resolve(reg || path.resolve(process.cwd(), ".data", "skill-registry"));
  if (parts.length) return Array.from(new Set([...parts.map((p) => path.resolve(p)), registryRoot]));
  const defaults = [path.resolve(process.cwd(), "skills"), path.resolve(process.cwd(), "..", "..", "skills")];
  const bases: string[] = [];
  for (const d of defaults) {
    try { require("node:fs").statSync(d); bases.push(d); } catch { /* skip */ }
  }
  return Array.from(new Set([...(bases.length ? bases : [defaults[0]]), registryRoot]));
}

/* Reuse DiscoveredTool for directory scanning (same shape) */

const _manifestToolCache = new Map<string, CachedManifestTool>();
let _scanSkillDirectoriesInFlight: Promise<DiscoveredTool[]> | null = null;
let _lastScanSnapshot = "";
let _lastScannedSkills: DiscoveredTool[] = [];

/** 发现版本戳：每次 rescan 完成时递增，用于缓存一致性检测 */
let _discoveryVersion = 0;
/** 当 scanSkillDirectories 缓存生成时的版本号 */
let _cacheVersion = 0;
/** rescan 异步锁：防止并发 rescan 导致缓存混乱 */
let _rescanLock: Promise<{ registered: number; skipped: number }> | null = null;

function cloneDiscoveredTool(tool: DiscoveredTool): DiscoveredTool {
  return {
    ...tool,
    displayName: tool.displayName ? { ...tool.displayName } : null,
    description: tool.description ? { ...tool.description } : null,
  };
}

export function invalidateToolDiscoveryCache(): void {
  _manifestToolCache.clear();
  _scanSkillDirectoriesInFlight = null;
  _lastScanSnapshot = "";
  _lastScannedSkills = [];
  _profileCache = null;
  _profileCacheAt = 0;
  // 不递增 _discoveryVersion（由 rescan 完成后递增）
  // 但清理缓存版本标记，迫使下次扫描重新检查
  _cacheVersion = -1;
}

/**
 * 运行期热扫描入口：重新扫描 skills/ 目录 + 重新注册工具到 DB。
 * 由定时器或手动端点调用，完成后自动失效相关缓存。
 *
 * 与 autoDiscoverAndRegisterTools 的区别：
 *   - autoDiscoverAndRegisterTools 是“启动时”一次性调用
 *   - rescanAndRegisterTools 是“运行期”可重复调用的版本，
 *     先失效文件缓存再扫描，确保新包被发现
 */
export async function rescanAndRegisterTools(pool: Pool): Promise<{ registered: number; skipped: number }> {
  // 防止并发 rescan：若已有 rescan 进行中，等待其完成
  if (_rescanLock) return _rescanLock;
  _rescanLock = (async () => {
    try {
      invalidateToolDiscoveryCache();
      const result = await autoDiscoverAndRegisterTools(pool);
      _discoveryVersion++;  // rescan 完成后递增版本戳
      return result;
    } finally {
      _rescanLock = null;
    }
  })();
  return _rescanLock;
}

async function scanSkillDirectories(): Promise<DiscoveredTool[]> {
  if (_scanSkillDirectoriesInFlight) return _scanSkillDirectoriesInFlight;
  _scanSkillDirectoriesInFlight = (async () => {
    const roots = getSkillRoots();
    const skills: DiscoveredTool[] = [];
    const seen = new Set<string>();
    const snapshotParts: string[] = [];

    for (const root of roots) {
      let entries: string[];
      try {
        entries = await fs.readdir(root);
      } catch {
        snapshotParts.push(`${root}:missing`);
        continue;
      }
      entries.sort((a, b) => a.localeCompare(b));
      for (const entry of entries) {
        const manifestPath = path.join(root, entry, "manifest.json");
        let signature = "missing";
        let cached: CachedManifestTool | undefined;
        try {
          const stat = await fs.stat(manifestPath);
          if (!stat.isFile()) {
            snapshotParts.push(`${manifestPath}:not-file`);
            continue;
          }
          signature = `${stat.mtimeMs}:${stat.size}`;
          snapshotParts.push(`${manifestPath}:${signature}`);
          cached = _manifestToolCache.get(manifestPath);
          if (!cached || cached.signature !== signature) {
            const raw = await fs.readFile(manifestPath, "utf8");
            const manifest = JSON.parse(raw);
            const name = String(manifest?.identity?.name ?? "").trim();
            if (!name) {
              cached = { signature, tool: null };
            } else {
              const contract = manifest?.contract ?? {};
              const io = manifest?.io ?? {};
              const scope = contract.scope === "write" ? "write" : "read";
              const riskLevel = ["low", "medium", "high"].includes(contract.riskLevel) ? contract.riskLevel : "low";
              cached = {
                signature,
                tool: {
                  name,
                  displayName: manifest.displayName ?? null,
                  description: manifest.description ?? null,
                  scope: scope as "read" | "write",
                  resourceType: String(contract.resourceType ?? "tool"),
                  action: String(contract.action ?? "execute"),
                  idempotencyRequired: Boolean(contract.idempotencyRequired),
                  riskLevel: riskLevel as "low" | "medium" | "high",
                  approvalRequired: Boolean(contract.approvalRequired),
                  inputSchema: io.inputSchema ?? null,
                  outputSchema: io.outputSchema ?? null,
                  artifactRef: path.join(root, entry),
                  sourceLayer: "extension" as SkillLayer,
                  category: manifest.category ?? undefined,
                  priority: manifest.priority ?? undefined,
                  tags: Array.isArray(manifest.tags) ? manifest.tags : undefined,
                  executionTimeoutMs: manifest.executionTimeoutMs ?? contract.executionTimeoutMs ?? undefined,
                },
              };
            }
            _manifestToolCache.set(manifestPath, cached);
          }
        } catch {
          snapshotParts.push(`${manifestPath}:${signature}`);
          _manifestToolCache.delete(manifestPath);
          continue;
        }
        if (!cached?.tool || seen.has(cached.tool.name)) continue;
        seen.add(cached.tool.name);
        skills.push(cloneDiscoveredTool(cached.tool));
      }
    }

    const snapshot = snapshotParts.join("|");
    // 如果版本戳已变（有新的 rescan 完成），则缓存无效
    if (_cacheVersion !== _discoveryVersion) {
      _lastScanSnapshot = "";
      _lastScannedSkills = [];
    }
    if (snapshot === _lastScanSnapshot) {
      return _lastScannedSkills.map(cloneDiscoveredTool);
    }
    _lastScanSnapshot = snapshot;
    _lastScannedSkills = skills.map(cloneDiscoveredTool);
    _cacheVersion = _discoveryVersion;
    return skills;
  })();
  try {
    return await _scanSkillDirectoriesInFlight;
  } finally {
    _scanSkillDirectoriesInFlight = null;
  }
}

/* ------------------------------------------------------------------ */
/*  Collect from built-in skill plugin registry (manifest.tools)       */
/* ------------------------------------------------------------------ */

function collectBuiltinSkillTools(seen: Set<string>, profiles?: Map<string, ResourceTypeProfile>): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];
  if (!isBuiltinSkillRegistrySealed()) {
    // Registry not yet initialized — this is a programming error if called after server startup.
    // During seed (before buildServer) this is expected; log and skip.
        _logger.warn("built-in skill registry not sealed yet — skipping builtin tools. " +
      "If this happens during server startup, it indicates a startup-ordering bug.");
    return tools;
  }
  const builtinSkills = getBuiltinSkills();
  for (const [skillName, skill] of builtinSkills) {
    const layer = resolveSkillLayer(skill);
    // 1. Register explicit tool declarations from manifest.tools
    const declared = skill.manifest.tools ?? [];
    for (const td of declared) {
      if (!td.name || seen.has(td.name)) continue;
      seen.add(td.name);
      
      // P2: Auto-infer category/priority from resourceType for built-in tools
      const inferredCategory = inferCategoryFromResourceType(td.resourceType, profiles);
      const inferredPriority = inferPriorityFromResourceType(td.resourceType, profiles);
      const mergedTags = Array.from(new Set([...(td.tags ?? []), ...inferTagsFromResourceType(td.resourceType, td.action, profiles)]));
      
      tools.push({
        name: td.name,
        displayName: td.displayName ?? null,
        description: td.description ?? null,
        scope: td.scope,
        resourceType: td.resourceType,
        action: td.action,
        idempotencyRequired: td.idempotencyRequired ?? false,
        riskLevel: td.riskLevel ?? "low",
        approvalRequired: td.approvalRequired ?? false,
        inputSchema: td.inputSchema ?? null,
        outputSchema: td.outputSchema ?? null,
        artifactRef: null,
        sourceLayer: layer,
        category: td.category ?? inferredCategory,
        priority: td.priority ?? inferredPriority,
        tags: mergedTags,
        extraPermissions: td.extraPermissions ?? undefined,
      });
    }
    // 2. If no explicit tools and skill itself not yet registered, register the skill identity
    if (!declared.length && !seen.has(skillName)) {
      seen.add(skillName);
      const manifestDisplayName = skill.manifest.displayName;
      const manifestDescription = skill.manifest.description;
      const fallbackName = skillName.replace(/\./g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      tools.push({
        name: skillName,
        displayName: manifestDisplayName ?? { "zh-CN": fallbackName, "en-US": fallbackName },
        description: manifestDescription ?? null,
        scope: "read",
        resourceType: "builtin_skill",
        action: "invoke",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: null,
        outputSchema: null,
        artifactRef: null,
        sourceLayer: layer,
      });
    }
  }
  return tools;
}

/* ------------------------------------------------------------------ */
/*  Auto-registration                                                  */
/* ------------------------------------------------------------------ */

let _discoveryInFlight: Promise<{ registered: number; skipped: number }> | null = null;

export async function autoDiscoverAndRegisterTools(pool: Pool): Promise<{ registered: number; skipped: number }> {
  if (_discoveryInFlight) return _discoveryInFlight;
  _discoveryInFlight = (async () => {
    // 0. Load resource type profiles from DB (fallback to empty if DB unavailable)
    const profiles = await loadResourceTypeProfiles(pool);

    // 1. Find all tenants
    const tenantRes = await pool.query("SELECT id FROM tenants ORDER BY id");
    if (!tenantRes.rowCount) return { registered: 0, skipped: 0 };
    const tenantIds = tenantRes.rows.map((r: any) => String(r.id));

    // 2. Collect tools from all sources (order: built-in manifest.tools > skills/ directory > skill identity fallback)
    const seen = new Set<string>();
    const allTools: DiscoveredTool[] = [];

    // Source A: Built-in skill plugin manifest.tools (e.g. entity.create, memory.read)
    const builtinTools = collectBuiltinSkillTools(seen, profiles);
    allTools.push(...builtinTools);

    // Source B: External skill packages from skills/ directories (e.g. collab.guard, sleep, math.add)
    const scannedSkills = await scanSkillDirectories();
    for (const sk of scannedSkills) {
      if (seen.has(sk.name)) continue;
      seen.add(sk.name);
      allTools.push(sk);
    }

    let registered = 0;
    let skipped = 0;

    for (const tenantId of tenantIds) {
      // Get all spaces for this tenant (for rollout enabling)
      const spaceRes = await pool.query("SELECT id FROM spaces WHERE tenant_id = $1 ORDER BY id", [tenantId]);
      const spaceIds = spaceRes.rows.map((r: any) => String(r.id));

      for (const tool of allTools) {
        try {
          // Upsert tool_definitions
          await pool.query(
            `
              INSERT INTO tool_definitions (tenant_id, name, display_name, description, scope, resource_type, action, idempotency_required, risk_level, approval_required, source_layer, category, priority, tags, extra_permissions, execution_timeout_ms)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
              ON CONFLICT (tenant_id, name) DO UPDATE
              SET display_name = COALESCE(EXCLUDED.display_name, tool_definitions.display_name),
                  description = COALESCE(EXCLUDED.description, tool_definitions.description),
                  scope = COALESCE(tool_definitions.scope, EXCLUDED.scope),
                  resource_type = COALESCE(tool_definitions.resource_type, EXCLUDED.resource_type),
                  action = COALESCE(tool_definitions.action, EXCLUDED.action),
                  idempotency_required = COALESCE(tool_definitions.idempotency_required, EXCLUDED.idempotency_required),
                  risk_level = EXCLUDED.risk_level,
                  approval_required = EXCLUDED.approval_required,
                  source_layer = COALESCE(EXCLUDED.source_layer, tool_definitions.source_layer),
                  category = COALESCE(EXCLUDED.category, tool_definitions.category),
                  priority = COALESCE(EXCLUDED.priority, tool_definitions.priority),
                  tags = COALESCE(EXCLUDED.tags, tool_definitions.tags),
                  extra_permissions = COALESCE(EXCLUDED.extra_permissions, tool_definitions.extra_permissions),
                  execution_timeout_ms = COALESCE(EXCLUDED.execution_timeout_ms, tool_definitions.execution_timeout_ms),
                  updated_at = now()
            `,
            [
              tenantId,
              tool.name,
              tool.displayName ? JSON.stringify(tool.displayName) : null,
              tool.description ? JSON.stringify(tool.description) : null,
              tool.scope,
              tool.resourceType,
              tool.action,
              tool.idempotencyRequired,
              tool.riskLevel,
              tool.approvalRequired,
              tool.sourceLayer,
              tool.category ?? "uncategorized",
              tool.priority ?? 5,
              tool.tags ?? [],
              tool.extraPermissions ? JSON.stringify(tool.extraPermissions) : null,
              tool.executionTimeoutMs ?? null,
            ],
          );

          // Upsert tool_versions (version 1)
          const toolRef = `${tool.name}@1`;
          await pool.query(
            `
              INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, input_schema, output_schema, artifact_ref)
              VALUES ($1, $2, 1, $3, 'released', $4, $5, $6)
              ON CONFLICT (tenant_id, name, version) DO UPDATE
              SET input_schema = COALESCE(tool_versions.input_schema, EXCLUDED.input_schema),
                  output_schema = COALESCE(tool_versions.output_schema, EXCLUDED.output_schema),
                  artifact_ref = COALESCE(EXCLUDED.artifact_ref, tool_versions.artifact_ref)
            `,
            [tenantId, tool.name, toolRef, tool.inputSchema, tool.outputSchema, tool.artifactRef],
          );

          // Upsert tool_active_versions
          await pool.query(
            `
              INSERT INTO tool_active_versions (tenant_id, name, active_tool_ref)
              VALUES ($1, $2, $3)
              ON CONFLICT (tenant_id, name) DO NOTHING
            `,
            [tenantId, tool.name, toolRef],
          );

          // Upsert tool_rollouts — auto-enable for all registered skills.
          // Extension skills are only discovered when they pass the enablement gate
          // (DEFAULT_EXTENSIONS / ENABLED_EXTENSIONS), so auto-enabling is safe.
          // Governance can still disable individual tools post-registration.
          await pool.query(
            `
              INSERT INTO tool_rollouts (tenant_id, scope_type, scope_id, tool_ref, enabled)
              VALUES ($1, 'tenant', $1, $2, true)
              ON CONFLICT (tenant_id, scope_type, scope_id, tool_ref) DO NOTHING
            `,
            [tenantId, toolRef],
          );
          for (const spaceId of spaceIds) {
            await pool.query(
              `
                INSERT INTO tool_rollouts (tenant_id, scope_type, scope_id, tool_ref, enabled)
                VALUES ($1, 'space', $2, $3, true)
                ON CONFLICT (tenant_id, scope_type, scope_id, tool_ref) DO NOTHING
              `,
              [tenantId, spaceId, toolRef],
            );
          }

          registered++;
        } catch (err: any) {
                    _logger.error(`failed to register tool "${tool.name}"`, { err: err?.message ?? err });
          skipped++;
        }
      }
    }

    return { registered, skipped };
  })();
  try {
    return await _discoveryInFlight;
  } finally {
    _discoveryInFlight = null;
  }
}
