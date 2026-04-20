/**
 * Built-in Skill Route Contract.
 *
 * Defines the interface that every "built-in Skill" must implement
 * so the Skill Route Loader in server.ts can discover and register
 * them automatically – replacing the hardcoded scoped.register() calls.
 *
 * Third-party dynamic Skills run in sandboxed processes and do NOT use
 * this interface; they go through the Skill Runtime (apps/runner/).
 */
import type { FastifyPluginAsync } from "fastify";

/* ------------------------------------------------------------------ */
/*  Skill Layer — three-tier classification                            */
/* ------------------------------------------------------------------ */

/**
 * kernel       — Core platform tool declarations (entity CRUD etc.), no HTTP routes.
 *                Always auto-enabled. Part of the OS minimum viable kernel.
 * core         — Essential platform capabilities, always registered, cannot be disabled.
 *                (orchestrator, model-gateway, knowledge, memory, safety …).
 * optional     — Default-enabled platform capabilities, can be disabled via env.
 *                (nl2ui, device-runtime, collab-runtime, yjs-collab …).
 * extension    — Upper-layer capabilities loaded on demand via explicit configuration.
 *                (analytics, media-pipeline, replay-viewer, ai-event-reasoning …).
 *
 * NOTE: Legacy value "builtin" is mapped to "optional" by resolveSkillLayer().
 */
export type SkillLayer = "kernel" | "core" | "optional" | "extension";

/* ------------------------------------------------------------------ */
/*  Skill Manifest v2 (built-in variant)                               */
/* ------------------------------------------------------------------ */

export interface SkillManifestV2 {
  /** Unique skill identity. */
  identity: {
    /** Dot-separated name, e.g. "nl2ui.generator" */
    name: string;
    /** Semver version. */
    version: string;
  };

  /**
   * i18n display name for this skill.
   * Used when the skill is registered as a tool without explicit tools declarations.
   */
  displayName?: Record<string, string>;

  /**
   * i18n description for this skill.
   * Used when the skill is registered as a tool without explicit tools declarations.
   */
  description?: Record<string, string>;

  /**
   * Classification layer for this skill.
   * Determines auto-enable policy, startup behaviour and governance defaults.
   * @default "builtin"
   */
  layer?: SkillLayer;

  /** HTTP route prefixes this skill owns, e.g. ["/nl2ui", "/ui"]. */
  routes?: string[];

  /** Frontend page routes, e.g. ["/gov/models", "/settings/models"]. */
  frontend?: string[];

  /**
   * Core primitives this skill depends on.
   * e.g. ["schemas", "entities", "tools", "audit", "rbac"]
   */
  dependencies?: string[];

  /**
   * Other built-in skills this skill depends on.
   * e.g. ["nl2ui.generator"]
   */
  skillDependencies?: string[];

  /**
   * Tool operations this skill provides.
   * Auto-discovery reads these to register tool_definitions.
   */
  tools?: SkillToolDeclaration[];
}

/** Tool declaration within a skill manifest. */
export interface SkillToolDeclaration {
  name: string;
  displayName?: Record<string, string>;
  description?: Record<string, string>;
  scope: "read" | "write";
  resourceType: string;
  action: string;
  idempotencyRequired?: boolean;
  riskLevel?: "low" | "medium" | "high";
  approvalRequired?: boolean;
  category?: string;
  priority?: number;
  tags?: string[];
  inputSchema?: any;
  outputSchema?: any;
  /**
   * P1-5b: 声明工具所需的 secret scope
   * - 列出工具运行时可能访问的 connector 类型
   * - 运行时根据此声明限制 secretDomain.connectorInstanceIds
   * - 示例: ["mail.imap", "mail.exchange", "oauth.google"]
   */
  requiredSecretScopes?: string[];
  /**
   * 额外权限声明：工具执行前需动态检查的附加权限。
   * 每条声明包含 resourceType 和 action，由执行内核自动调用 requirePermission。
   * 示例: [{ resourceType: "memory", action: "read" }]
   */
  extraPermissions?: Array<{ resourceType: string; action: string }>;
}

/* ------------------------------------------------------------------ */
/*  Built-in Skill Plugin Contract                                     */
/* ------------------------------------------------------------------ */

export interface BuiltinSkillPlugin {
  /** Manifest describing this skill's identity and routes. */
  manifest: SkillManifestV2;

  /** Fastify plugin that registers all HTTP routes for this skill. */
  routes: FastifyPluginAsync;
}

/** Resolve the effective layer — defaults to "optional" when omitted. Legacy "builtin" maps to "optional". */
export function resolveSkillLayer(plugin: BuiltinSkillPlugin): SkillLayer {
  const raw = plugin.manifest.layer ?? "optional";
  // 向后兼容：旧的 "builtin" 统一归一化为 "optional"
  if ((raw as string) === "builtin") return "optional";
  return raw;
}

/* ------------------------------------------------------------------ */
/*  Skill Registry (populated at startup)                              */
/* ------------------------------------------------------------------ */

const _registry = new Map<string, BuiltinSkillPlugin>();
let _registrySealed = false;

export function registerBuiltinSkill(plugin: BuiltinSkillPlugin): void {
  if (_registrySealed) {
    throw new Error(`Cannot register skill after registry is sealed: ${plugin.manifest.identity.name}`);
  }
  const name = plugin.manifest.identity.name;
  if (_registry.has(name)) {
    throw new Error(`Duplicate built-in skill registration: ${name}`);
  }
  _registry.set(name, plugin);
}

/**
 * Seal the registry — no further registrations allowed.
 * Call after all skills are registered to enforce startup-time determinism.
 */
export function sealBuiltinSkillRegistry(): void {
  _registrySealed = true;
}

/** Whether the registry has been sealed (init complete). */
export function isBuiltinSkillRegistrySealed(): boolean {
  return _registrySealed;
}

export function getBuiltinSkills(): ReadonlyMap<string, BuiltinSkillPlugin> {
  return _registry;
}

export function getBuiltinSkill(name: string): BuiltinSkillPlugin | undefined {
  return _registry.get(name);
}

/**
 * Validate that all skill dependencies are satisfied.
 * Call after all skills have been registered.
 */
export function validateSkillDependencies(): string[] {
  const errors: string[] = [];
  for (const [name, plugin] of _registry) {
    for (const dep of plugin.manifest.skillDependencies ?? []) {
      if (!_registry.has(dep)) {
        errors.push(`Skill "${name}" depends on "${dep}" which is not registered.`);
      }
    }
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/*  Startup Consistency Check                                          */
/* ------------------------------------------------------------------ */

export interface StartupCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    totalSkills: number;
    kernelCount: number;
    coreCount: number;
    optionalCount: number;
    extensionCount: number;
    sealed: boolean;
  };
}

/**
 * Run a comprehensive consistency check of the skill registry.
 * Should be called after initBuiltinSkills() and seal, before serving requests.
 *
 * Checks:
 *  1. Registry is sealed
 *  2. All skill dependencies are satisfied
 *  3. At least one kernel skill exists
 *  4. Layer assignments are valid
 *  5. No skill name conflicts with route prefixes of another skill
 */
export function runStartupConsistencyCheck(): StartupCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Registry sealed?
  if (!_registrySealed) {
    errors.push("Registry is NOT sealed — initBuiltinSkills() may not have been called.");
  }

  // 2. Dependency check
  const depErrors = validateSkillDependencies();
  errors.push(...depErrors);

  // 3. Layer counts
  let kernelCount = 0;
  let coreCount = 0;
  let optionalCount = 0;
  let extensionCount = 0;
  const validLayers: Set<string> = new Set(["kernel", "core", "optional", "extension", "builtin"]);

  for (const [name, plugin] of _registry) {
    const layer = resolveSkillLayer(plugin);
    if (!validLayers.has(layer)) {
      errors.push(`Skill "${name}" has invalid layer "${layer}".`);
    }
    if (layer === "kernel") kernelCount++;
    else if (layer === "core") coreCount++;
    else if (layer === "optional") optionalCount++;
    else if (layer === "extension") extensionCount++;
  }

  if (kernelCount === 0) {
    errors.push("No kernel-layer skill registered — entity operations will be unavailable.");
  }

  // 4. Duplicate route prefix detection
  const routePrefixMap = new Map<string, string>();
  for (const [name, plugin] of _registry) {
    for (const prefix of plugin.manifest.routes ?? []) {
      const existing = routePrefixMap.get(prefix);
      if (existing && existing !== name) {
        warnings.push(`Route prefix "${prefix}" claimed by both "${existing}" and "${name}".`);
      } else {
        routePrefixMap.set(prefix, name);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      totalSkills: _registry.size,
      kernelCount,
      coreCount,
      optionalCount,
      extensionCount,
      sealed: _registrySealed,
    },
  };
}
