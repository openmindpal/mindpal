/**
 * Skill Manifest Conformance Tests
 *
 * Validates manifest schema enforcement and naming conventions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { validateManifest, skillLayerRegistry, BUILTIN_SKILL_LAYERS } from '../src/skill-manifest';
import type { ManifestValidationResult, ExternalSkillManifest } from '../src/skill-manifest';

describe('Skill Manifest — validateManifest valid cases', () => {
  it('accepts a valid manifest with all required fields', () => {
    const manifest = {
      identity: { name: 'org.example.skill', version: '1.0.0' },
      entry: './dist/index.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts name with multiple dot-separated segments', () => {
    const manifest = {
      identity: { name: 'com.mindpal.skills.echo', version: '2.1.3' },
      entry: 'main.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });

  it('accepts semver with pre-release and build metadata', () => {
    const manifest = {
      identity: { name: 'io.openslin.test', version: '1.0.0-beta.1+build.42' },
      entry: 'index.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });
});

describe('Skill Manifest — validateManifest name validation', () => {
  it('rejects single-segment name (no dot separator)', () => {
    const manifest = {
      identity: { name: 'echo', version: '1.0.0' },
      entry: 'index.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('pattern'))).toBe(true);
  });

  it('rejects name starting with uppercase', () => {
    const manifest = {
      identity: { name: 'Org.example', version: '1.0.0' },
      entry: 'index.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
  });

  it('rejects name with special characters', () => {
    const manifest = {
      identity: { name: 'org.exam-ple', version: '1.0.0' },
      entry: 'index.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
  });

  it('rejects name with segment starting with digit', () => {
    const manifest = {
      identity: { name: 'org.1example', version: '1.0.0' },
      entry: 'index.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
  });

  it('rejects empty name', () => {
    const manifest = {
      identity: { name: '', version: '1.0.0' },
      entry: 'index.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('identity.name'))).toBe(true);
  });
});

describe('Skill Manifest — validateManifest version validation', () => {
  it('rejects non-semver version', () => {
    const manifest = {
      identity: { name: 'org.test', version: 'latest' },
      entry: 'index.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('semver'))).toBe(true);
  });

  it('rejects two-part version', () => {
    const manifest = {
      identity: { name: 'org.test', version: '1.0' },
      entry: 'index.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
  });

  it('rejects empty version', () => {
    const manifest = {
      identity: { name: 'org.test', version: '' },
      entry: 'index.js',
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
  });
});

describe('Skill Manifest — validateManifest missing fields', () => {
  it('rejects null input', () => {
    const result = validateManifest(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('non-null object');
  });

  it('rejects undefined input', () => {
    const result = validateManifest(undefined);
    expect(result.valid).toBe(false);
  });

  it('rejects array input', () => {
    const result = validateManifest([]);
    expect(result.valid).toBe(false);
  });

  it('reports missing identity field', () => {
    const result = validateManifest({ entry: 'index.js' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('identity'))).toBe(true);
  });

  it('reports missing entry field', () => {
    const manifest = { identity: { name: 'org.test', version: '1.0.0' } };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('entry'))).toBe(true);
  });

  it('reports missing identity.name and identity.version together', () => {
    const manifest = { identity: {}, entry: 'index.js' };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects identity as array', () => {
    const result = validateManifest({ identity: [], entry: 'index.js' });
    expect(result.valid).toBe(false);
  });
});

describe('Skill Manifest — ManifestValidationResult structure', () => {
  it('result has valid boolean and errors array', () => {
    const result = validateManifest({});
    expect(typeof result.valid).toBe('boolean');
    expect(Array.isArray(result.errors)).toBe(true);
  });
});

/* ================================================================== */
/*  Registry CRUD Tests                                                */
/* ================================================================== */

describe('Skill Manifest — skillLayerRegistry CRUD', () => {
  afterEach(() => { skillLayerRegistry.reset(); });

  it('has all builtin skill layers', () => {
    for (const entry of BUILTIN_SKILL_LAYERS) {
      expect(skillLayerRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom layer', () => {
    skillLayerRegistry.register({ id: 'experimental', category: 'skill.layer', builtIn: false });
    expect(skillLayerRegistry.has('experimental')).toBe(true);
  });

  it('get returns registered entry', () => {
    const entry = skillLayerRegistry.get('kernel');
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('skill.layer');
    expect(entry!.metadata?.priority).toBe(0);
  });

  it('list returns all entries', () => {
    const all = skillLayerRegistry.list();
    expect(all.length).toBeGreaterThanOrEqual(BUILTIN_SKILL_LAYERS.length);
  });

  it('unregister custom entry succeeds', () => {
    skillLayerRegistry.register({ id: 'temp_layer', category: 'skill.layer', builtIn: false });
    expect(skillLayerRegistry.unregister('temp_layer')).toBe(true);
    expect(skillLayerRegistry.has('temp_layer')).toBe(false);
  });

  it('unregister builtIn entry fails', () => {
    expect(skillLayerRegistry.unregister('kernel')).toBe(false);
    expect(skillLayerRegistry.has('kernel')).toBe(true);
  });

  it('reset restores initial state', () => {
    skillLayerRegistry.register({ id: 'custom_layer', category: 'skill.layer', builtIn: false });
    skillLayerRegistry.reset();
    expect(skillLayerRegistry.has('custom_layer')).toBe(false);
    expect(skillLayerRegistry.has('kernel')).toBe(true);
  });
});
