/**
 * Tool Auto-Discovery.
 *
 * Automatically discovers and registers tools from THREE sources:
 * 1. Built-in skill plugins (manifest.tools declarations) — e.g. memory.read, nl2ui.generate
 * 2. External skill packages (skills/ directory manifest.json) — e.g. collab.guard, sleep
 * 3. Built-in skill identity (any plugin without explicit tools) — registered as builtin_skill
 *
 * For each discovered tool, ensures:
 * - tool_definitions row exists
 * - tool_versions row (v1, released) exists
 * - tool_active_versions row exists (pointing to @1)
 * - tool_rollouts row exists (enabled at tenant level)
 *
 * 职责边界说明：
 *   本模块负责将“内置插件 + skills/ 目录外部包”→ 写入 tool_definitions 表。
 *   tool_definitions 是 Agent Loop (discoverEnabledTools) 的唯一工具注册表。
 *   内置 Skill 的启停由 registry.ts 的代码清单与环境变量控制，与本模块无直接关系。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { getBuiltinSkills, isBuiltinSkillRegistrySealed, resolveSkillLayer } from "../../lib/skillPlugin";
import type { SkillLayer } from "../../lib/skillPlugin";

/* ------------------------------------------------------------------ */
/*  Helper: Infer category/priority/tags from resourceType             */
/* ------------------------------------------------------------------ */

function inferCategoryFromResourceType(resourceType: string): string {
  const mapping: Record<string, string> = {
    model: "ai",
    embedding: "ai",
    knowledge: "ai",
    memory: "ai",
    intent: "ai",
    nl2ui: "ai",
    media: "ai",
    schema: "database",
    entity: "database",
    channel: "communication",
    federation: "integration",
    rbac: "governance",
    governance: "governance",
    agent_runtime: "governance",
    agent: "workflow",
    browser: "integration",
    desktop: "integration",
    skill: "governance",
    tool: "integration",
    workbench: "integration",
  };
  return mapping[resourceType] ?? "integration";
}

function inferPriorityFromResourceType(resourceType: string): number {
  const mapping: Record<string, number> = {
    model: 9,
    embedding: 8,
    knowledge: 8,
    memory: 8,
    intent: 9,
    nl2ui: 9,
    media: 7,
    schema: 9,
    entity: 8,
    channel: 7,
    federation: 7,
    rbac: 8,
    governance: 9,
    agent_runtime: 8,
    agent: 7,
    browser: 6,
    desktop: 6,
    skill: 7,
    tool: 6,
    workbench: 6,
  };
  return mapping[resourceType] ?? 5;
}

function inferTagsFromResourceType(resourceType: string, action: string): string[] {
  const baseTags: Record<string, string[]> = {
    model: ["llm", "model", "generation"],
    embedding: ["embedding", "vector", "ai"],
    knowledge: ["knowledge", "rag", "search"],
    memory: ["memory", "context", "recall"],
    intent: ["intent", "analysis", "nlp"],
    nl2ui: ["nl2ui", "page-generation", "frontend"],
    media: ["media", "multimodal", "vision"],
    schema: ["schema", "database", "ddl"],
    entity: ["entity", "data", "crud"],
    channel: ["channel", "im", "messaging"],
    federation: ["federation", "cross-tenant", "bridge"],
    rbac: ["rbac", "permission", "authorization"],
    governance: ["governance", "audit", "compliance"],
    agent_runtime: ["agent", "runtime", "orchestration"],
    agent: ["agent", "reflection", "learning"],
    browser: ["browser", "automation", "web"],
    desktop: ["desktop", "automation", "application"],
    skill: ["skill", "management"],
    tool: ["tool", "discovery"],
    workbench: ["workbench", "plugin"],
  };
  return [...(baseTags[resourceType] ?? ["tool"]), action];
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
  // 1. 失效文件系统扫描缓存，确保新包被发现
  invalidateToolDiscoveryCache();
  // 2. 重新执行发现 + 注册
  return autoDiscoverAndRegisterTools(pool);
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
    if (snapshot === _lastScanSnapshot) {
      return _lastScannedSkills.map(cloneDiscoveredTool);
    }
    _lastScanSnapshot = snapshot;
    _lastScannedSkills = skills.map(cloneDiscoveredTool);
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

function collectBuiltinSkillTools(seen: Set<string>): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];
  if (!isBuiltinSkillRegistrySealed()) {
    // Registry not yet initialized — this is a programming error if called after server startup.
    // During seed (before buildServer) this is expected; log and skip.
    console.warn("[tool-discovery] built-in skill registry not sealed yet — skipping builtin tools. " +
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
      const inferredCategory = inferCategoryFromResourceType(td.resourceType);
      const inferredPriority = inferPriorityFromResourceType(td.resourceType);
      const mergedTags = Array.from(new Set([...(td.tags ?? []), ...inferTagsFromResourceType(td.resourceType, td.action)]));
      
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
      const displayName = skillName.replace(/\./g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      tools.push({
        name: skillName,
        displayName: { "zh-CN": displayName, "en-US": displayName },
        description: null,
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
    // 1. Find all tenants
    const tenantRes = await pool.query("SELECT id FROM tenants ORDER BY id");
    if (!tenantRes.rowCount) return { registered: 0, skipped: 0 };
    const tenantIds = tenantRes.rows.map((r: any) => String(r.id));

    // 2. Collect tools from all sources (order: built-in manifest.tools > skills/ directory > skill identity fallback)
    const seen = new Set<string>();
    const allTools: DiscoveredTool[] = [];

    // Source A: Built-in skill plugin manifest.tools (e.g. entity.create, memory.read, nl2ui.generate)
    const builtinTools = collectBuiltinSkillTools(seen);
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
              INSERT INTO tool_definitions (tenant_id, name, display_name, description, scope, resource_type, action, idempotency_required, risk_level, approval_required, source_layer, category, priority, tags, extra_permissions)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
              ON CONFLICT (tenant_id, name) DO UPDATE
              SET display_name = COALESCE(tool_definitions.display_name, EXCLUDED.display_name),
                  description = COALESCE(tool_definitions.description, EXCLUDED.description),
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
          console.error(`[tool-discovery] failed to register tool "${tool.name}": ${err?.message ?? err}`);
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
