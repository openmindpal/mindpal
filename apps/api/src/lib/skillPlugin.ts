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
import type {
  SkillLayer as _SkillLayer,
  SkillToolDeclaration as _SkillToolDeclaration,
  BuiltinSkillManifest,
} from "@mindpal/shared";

/* ------------------------------------------------------------------ */
/*  Re-export shared types under local names for backward compat       */
/* ------------------------------------------------------------------ */

export type SkillLayer = _SkillLayer;
export type SkillToolDeclaration = _SkillToolDeclaration;

/**
 * Built-in skill manifest — re-exported from @mindpal/shared.
 * Local alias `SkillManifestV2` kept for backward compatibility.
 */
export type SkillManifestV2 = BuiltinSkillManifest;

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
