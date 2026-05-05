/**
 * Skill Manifest — shared type definitions and runtime validation.
 *
 * Two manifest variants:
 *   - BuiltinSkillManifest  : built-in skill plugins registered inside the API process.
 *   - ExternalSkillManifest : standalone skills under skills/ with manifest.json.
 */

import { createRegistry, builtInEntry, type RegistryEntry } from './registry.js';

/* ------------------------------------------------------------------ */
/*  Skill Layer                                                        */
/* ------------------------------------------------------------------ */

export type SkillLayer = string;

export const BUILTIN_SKILL_LAYERS: RegistryEntry[] = [
  builtInEntry('kernel', 'skill.layer', undefined, { priority: 0, description: '运行时内核层' }),
  builtInEntry('core', 'skill.layer', undefined, { priority: 1, description: '核心能力层' }),
  builtInEntry('optional', 'skill.layer', undefined, { priority: 2, description: '可选能力层' }),
  builtInEntry('extension', 'skill.layer', undefined, { priority: 3, description: '扩展能力层/沙箱Skill层' }),
];

export const skillLayerRegistry = createRegistry(BUILTIN_SKILL_LAYERS);

/* ------------------------------------------------------------------ */
/*  Tool declaration (shared by both manifest types)                    */
/* ------------------------------------------------------------------ */

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
  requiredSecretScopes?: string[];
  extraPermissions?: Array<{ resourceType: string; action: string }>;
}

/* ------------------------------------------------------------------ */
/*  Built-in Skill Manifest (API-internal plugin registration)         */
/* ------------------------------------------------------------------ */

export interface BuiltinSkillManifest {
  identity: {
    name: string;
    version: string;
  };
  displayName?: Record<string, string>;
  description?: Record<string, string>;
  layer?: SkillLayer;
  routes?: string[];
  frontend?: string[];
  dependencies?: string[];
  skillDependencies?: string[];
  tools?: SkillToolDeclaration[];
}

/* ------------------------------------------------------------------ */
/*  External Skill Manifest (skills/xxx/manifest.json)                 */
/* ------------------------------------------------------------------ */

export interface ExternalSkillManifest {
  identity: {
    name: string;
    version: string;
  };
  displayName?: Record<string, string>;
  description?: Record<string, string>;
  category?: string;
  priority?: number;
  tags?: string[];
  dependencies?: string[];
  contract?: {
    scope?: string;
    resourceType?: string;
    action?: string;
    idempotencyRequired?: boolean;
    riskLevel?: string;
    approvalRequired?: boolean;
  };
  io?: {
    input?: any;
    output?: any;
    inputSchema?: any;
    outputSchema?: any;
  };
  entry: string;
  engines?: {
    node?: string;
    runtime?: string;
  };
  executionTimeoutMs?: number;
}

/* ------------------------------------------------------------------ */
/*  Runtime validation for ExternalSkillManifest                       */
/* ------------------------------------------------------------------ */

/** Regex: at least two dot-separated segments, each starting with a lowercase letter. */
const NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/** Loose semver check: major.minor.patch with optional pre-release / build metadata. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a raw parsed manifest object (typically from manifest.json).
 * Returns structured error list. An empty errors array means the manifest is valid.
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, errors: ["manifest must be a non-null object"] };
  }

  const obj = raw as Record<string, unknown>;

  // ── identity ──────────────────────────────────────────────────────
  if (!obj.identity || typeof obj.identity !== "object" || Array.isArray(obj.identity)) {
    errors.push("missing or invalid required field: identity");
  } else {
    const id = obj.identity as Record<string, unknown>;

    if (typeof id.name !== "string" || !id.name) {
      errors.push("missing required field: identity.name");
    } else if (!NAME_PATTERN.test(id.name)) {
      errors.push(
        `identity.name "${id.name}" does not match required pattern (at least two dot-separated lowercase segments)`,
      );
    }

    if (typeof id.version !== "string" || !id.version) {
      errors.push("missing required field: identity.version");
    } else if (!SEMVER_PATTERN.test(id.version)) {
      errors.push(`identity.version "${id.version}" does not look like a valid semver string`);
    }
  }

  // ── entry ─────────────────────────────────────────────────────────
  if (typeof obj.entry !== "string" || !obj.entry) {
    errors.push("missing required field: entry");
  }

  return { valid: errors.length === 0, errors };
}
