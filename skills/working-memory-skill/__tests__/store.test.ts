import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkingMemoryStore } from '../src/store';
import { TTL_PRESETS, autoTtl, remainingTtl, isNoExpiry } from '../src/ttl';

describe('TTL Management', () => {
  it('autoTtl returns IMPORTANT for high importance', () => {
    expect(autoTtl(0.9)).toBe(TTL_PRESETS.IMPORTANT);
    expect(autoTtl(0.8)).toBe(TTL_PRESETS.IMPORTANT);
  });

  it('autoTtl returns EPISODE for medium importance', () => {
    expect(autoTtl(0.6)).toBe(TTL_PRESETS.EPISODE);
    expect(autoTtl(0.5)).toBe(TTL_PRESETS.EPISODE);
  });

  it('autoTtl returns CONTEXT for low-medium importance', () => {
    expect(autoTtl(0.4)).toBe(TTL_PRESETS.CONTEXT);
    expect(autoTtl(0.3)).toBe(TTL_PRESETS.CONTEXT);
  });

  it('autoTtl returns SENSOR for low importance', () => {
    expect(autoTtl(0.1)).toBe(TTL_PRESETS.SENSOR);
    expect(autoTtl(0)).toBe(TTL_PRESETS.SENSOR);
  });

  it('isNoExpiry correctly identifies zero TTL', () => {
    expect(isNoExpiry(0)).toBe(true);
    expect(isNoExpiry(-1)).toBe(true);
    expect(isNoExpiry(1000)).toBe(false);
  });

  it('remainingTtl calculates correctly', () => {
    const now = Date.now();
    expect(remainingTtl(now - 1000, 2000)).toBeGreaterThan(0);
    expect(remainingTtl(now - 3000, 2000)).toBe(0);
    expect(remainingTtl(now, 0)).toBe(-1); // no expiry
  });
});

describe('WorkingMemoryStore (L1 only - no Redis)', () => {
  let store: WorkingMemoryStore;

  beforeEach(async () => {
    store = new WorkingMemoryStore('redis://invalid:1'); // Force Redis failure
    await store.init();
  });

  afterEach(async () => {
    await store.dispose();
  });

  it('set and get basic value', async () => {
    await store.set('ns1', 'key1', { hello: 'world' });
    const result = await store.get('ns1', 'key1');
    expect(result).toEqual({ hello: 'world' });
  });

  it('get returns null for missing key', async () => {
    const result = await store.get('ns1', 'missing');
    expect(result).toBeNull();
  });

  it('getMany returns multiple values', async () => {
    await store.set('ns1', 'a', 1);
    await store.set('ns1', 'b', 2);
    await store.set('ns1', 'c', 3);
    const result = await store.getMany('ns1', ['a', 'b', 'missing']);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('delete removes entry', async () => {
    await store.set('ns1', 'key1', 'value');
    const deleted = await store.delete('ns1', 'key1');
    expect(deleted).toBe(true);
    expect(await store.get('ns1', 'key1')).toBeNull();
  });

  it('flush clears namespace', async () => {
    await store.set('ns1', 'a', 1);
    await store.set('ns1', 'b', 2);
    await store.set('ns2', 'c', 3);
    const count = await store.flush('ns1');
    expect(count).toBe(2);
    expect(await store.get('ns1', 'a')).toBeNull();
    expect(await store.get('ns2', 'c')).toBe(3); // ns2 untouched
  });

  it('scan by prefix', async () => {
    await store.set('ns1', 'pose_0', { x: 0 });
    await store.set('ns1', 'pose_1', { x: 1 });
    await store.set('ns1', 'frame_0', { img: 'a' });
    const results = await store.scan('ns1', { prefix: 'pose_' });
    expect(results).toHaveLength(2);
  });

  it('scan by tags', async () => {
    await store.set('ns1', 'a', 1, { tags: ['sensor'] });
    await store.set('ns1', 'b', 2, { tags: ['decision'] });
    await store.set('ns1', 'c', 3, { tags: ['sensor', 'important'] });
    const results = await store.scan('ns1', { tags: ['sensor'] });
    expect(results).toHaveLength(2);
  });

  it('scan by minImportance', async () => {
    await store.set('ns1', 'a', 1, { importance: 0.2 });
    await store.set('ns1', 'b', 2, { importance: 0.7 });
    await store.set('ns1', 'c', 3, { importance: 0.9 });
    const results = await store.scan('ns1', { minImportance: 0.5 });
    expect(results).toHaveLength(2);
  });

  it('promote returns entry and removes from store', async () => {
    await store.set('ns1', 'key1', { data: 'important' }, { importance: 0.9 });
    const result = await store.promote('ns1', 'key1', 'episodic');
    expect(result.promoted).toBe(true);
    expect(result.entry?.value).toEqual({ data: 'important' });
    expect(await store.get('ns1', 'key1')).toBeNull();
  });

  it('TTL expiration works in L1', async () => {
    vi.useFakeTimers();
    await store.set('ns1', 'temp', 'value', { ttlMs: 100 });
    expect(await store.get('ns1', 'temp')).toBe('value');
    
    vi.advanceTimersByTime(150);
    expect(await store.get('ns1', 'temp')).toBeNull();
    vi.useRealTimers();
  });

  it('stats tracks hits and misses', async () => {
    await store.set('ns1', 'key1', 'value');
    await store.get('ns1', 'key1'); // hit
    await store.get('ns1', 'missing'); // miss
    
    const stats = store.getStats();
    expect(stats.l1Hits).toBe(1);
    expect(stats.l1Misses).toBe(1);
    expect(stats.totalSets).toBe(1);
    expect(stats.totalGets).toBe(2);
  });
});
