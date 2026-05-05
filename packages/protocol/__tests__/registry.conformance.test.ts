/**
 * Registry Infrastructure Conformance Tests
 *
 * Validates the core createRegistry, builtInEntry, TypeRegistry, RegistryEntry APIs.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry, builtInEntry, registryIds } from '../src/registry';
import type { TypeRegistry, RegistryEntry, ValidationResult } from '../src/registry';

describe('Registry — createRegistry basic CRUD', () => {
  it('creates empty registry when no defaults', () => {
    const reg = createRegistry();
    expect(reg.size()).toBe(0);
    expect(reg.list()).toHaveLength(0);
    expect(reg.ids()).toHaveLength(0);
  });

  it('creates registry with default entries', () => {
    const reg = createRegistry([
      builtInEntry('a', 'cat1'),
      builtInEntry('b', 'cat1'),
    ]);
    expect(reg.size()).toBe(2);
    expect(reg.has('a')).toBe(true);
    expect(reg.has('b')).toBe(true);
  });

  it('register adds new entry', () => {
    const reg = createRegistry();
    reg.register({ id: 'custom1', category: 'test' });
    expect(reg.has('custom1')).toBe(true);
    expect(reg.get('custom1')?.category).toBe('test');
  });

  it('register throws on duplicate id', () => {
    const reg = createRegistry([builtInEntry('a', 'cat')]);
    expect(() => reg.register({ id: 'a', category: 'cat' })).toThrow('validation failed');
  });

  it('register throws on empty id', () => {
    const reg = createRegistry();
    expect(() => reg.register({ id: '', category: 'cat' })).toThrow('entry.id must be a non-empty string');
  });

  it('register throws on empty category', () => {
    const reg = createRegistry();
    expect(() => reg.register({ id: 'ok', category: '' })).toThrow('entry.category must be a non-empty string');
  });

  it('get returns entry or undefined', () => {
    const reg = createRegistry([builtInEntry('x', 'cat')]);
    expect(reg.get('x')).toBeDefined();
    expect(reg.get('x')!.id).toBe('x');
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('has checks existence', () => {
    const reg = createRegistry([builtInEntry('y', 'cat')]);
    expect(reg.has('y')).toBe(true);
    expect(reg.has('z')).toBe(false);
  });

  it('list returns all entries', () => {
    const reg = createRegistry([
      builtInEntry('a', 'cat1'),
      builtInEntry('b', 'cat2'),
    ]);
    expect(reg.list()).toHaveLength(2);
  });

  it('list filters by category', () => {
    const reg = createRegistry([
      builtInEntry('a', 'cat1'),
      builtInEntry('b', 'cat2'),
      builtInEntry('c', 'cat1'),
    ]);
    expect(reg.list('cat1')).toHaveLength(2);
    expect(reg.list('cat2')).toHaveLength(1);
    expect(reg.list('unknown')).toHaveLength(0);
  });

  it('unregister removes custom entry', () => {
    const reg = createRegistry();
    reg.register({ id: 'temp', category: 'test', builtIn: false });
    expect(reg.has('temp')).toBe(true);
    const result = reg.unregister('temp');
    expect(result).toBe(true);
    expect(reg.has('temp')).toBe(false);
  });

  it('unregister returns false for builtIn entry', () => {
    const reg = createRegistry([builtInEntry('core', 'cat')]);
    const result = reg.unregister('core');
    expect(result).toBe(false);
    expect(reg.has('core')).toBe(true);
  });

  it('unregister returns false for non-existent entry', () => {
    const reg = createRegistry();
    expect(reg.unregister('nothing')).toBe(false);
  });

  it('reset removes custom entries but keeps builtIn', () => {
    const reg = createRegistry([builtInEntry('builtin1', 'cat')]);
    reg.register({ id: 'custom1', category: 'cat', builtIn: false });
    reg.register({ id: 'custom2', category: 'cat', builtIn: false });
    expect(reg.size()).toBe(3);
    reg.reset();
    expect(reg.size()).toBe(1);
    expect(reg.has('builtin1')).toBe(true);
    expect(reg.has('custom1')).toBe(false);
    expect(reg.has('custom2')).toBe(false);
  });

  it('validate returns valid for a correct new entry', () => {
    const reg = createRegistry([builtInEntry('x', 'cat')]);
    const result = reg.validate({ id: 'new-entry', category: 'cat' });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('validate returns errors for empty id', () => {
    const reg = createRegistry();
    const result = reg.validate({ id: '', category: 'cat' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('entry.id must be a non-empty string');
  });

  it('validate returns errors for empty category', () => {
    const reg = createRegistry();
    const result = reg.validate({ id: 'ok', category: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('entry.category must be a non-empty string');
  });

  it('validate returns errors for duplicate id', () => {
    const reg = createRegistry([builtInEntry('x', 'cat')]);
    const result = reg.validate({ id: 'x', category: 'cat' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('entry.id "x" is already registered');
  });

  it('validate returns multiple errors when both id and category are invalid', () => {
    const reg = createRegistry();
    const result = reg.validate({ id: '', category: '' });
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBe(2);
  });

  it('ids returns all registered ids', () => {
    const reg = createRegistry([builtInEntry('a', 'c'), builtInEntry('b', 'c')]);
    const ids = reg.ids();
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('registerAll adds multiple entries', () => {
    const reg = createRegistry();
    reg.registerAll([
      { id: 'x', category: 'test' },
      { id: 'y', category: 'test' },
    ]);
    expect(reg.size()).toBe(2);
  });
});

describe('Registry — builtInEntry helper', () => {
  it('creates entry with builtIn=true', () => {
    const entry = builtInEntry('test', 'category');
    expect(entry.id).toBe('test');
    expect(entry.category).toBe('category');
    expect(entry.builtIn).toBe(true);
  });

  it('supports value parameter', () => {
    const entry = builtInEntry('code', 'errors', -32001);
    expect(entry.value).toBe(-32001);
  });

  it('supports metadata parameter', () => {
    const entry = builtInEntry('item', 'cat', undefined, { priority: 1 });
    expect(entry.metadata).toEqual({ priority: 1 });
  });
});

describe('Registry — registryIds helper', () => {
  it('returns ids array from registry', () => {
    const reg = createRegistry([builtInEntry('a', 'c'), builtInEntry('b', 'c')]);
    const ids = registryIds(reg);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });
});

describe('Registry — Custom Extension Use Case', () => {
  it('developer can register custom types and use them', () => {
    const reg = createRegistry<number>([
      builtInEntry('builtin_error', 'errors', -32001),
    ]);
    // Custom extension
    reg.register({ id: 'custom_error', category: 'errors', value: -33001, builtIn: false });
    expect(reg.has('custom_error')).toBe(true);
    expect(reg.get('custom_error')!.value).toBe(-33001);
    // Cannot remove builtIn
    expect(reg.unregister('builtin_error')).toBe(false);
    // Can remove custom
    expect(reg.unregister('custom_error')).toBe(true);
  });

  it('defaults entries are marked builtIn=true when not explicitly set', () => {
    const reg = createRegistry([{ id: 'auto', category: 'test' }]);
    expect(reg.get('auto')!.builtIn).toBe(true);
  });
});
