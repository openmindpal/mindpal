/**
 * Working Memory Skill - Entry Point
 * 
 * Provides high-speed layered working memory for real-time agent decisions.
 * This skill is designed for transient data that does NOT persist to long-term storage.
 * Use 'promote' command to graduate important entries to long-term memory.
 */

import { WorkingMemoryStore, MemoryEntry, SetOptions, ScanOptions } from './store';

// --- Types ---

export interface WorkingMemoryInput {
  command: 'set' | 'get' | 'getMany' | 'scan' | 'delete' | 'flush' | 'promote' | 'stats';
  namespace: string;
  key?: string;
  value?: unknown;
  keys?: string[];
  options?: {
    ttlMs?: number;
    tags?: string[];
    importance?: number;
    prefix?: string;
    minImportance?: number;
    targetType?: 'episodic' | 'semantic' | 'procedural';
  };
}

export interface WorkingMemoryOutput {
  ok: boolean;
  data?: unknown;
  stats?: {
    l1Size: number;
    l1Hits: number;
    l1Misses: number;
    l2Hits: number;
    l2Misses: number;
  };
  error?: string;
}

// --- Singleton store ---

let store: WorkingMemoryStore | null = null;

async function getStore(): Promise<WorkingMemoryStore> {
  if (!store) {
    store = new WorkingMemoryStore();
    await store.init();
  }
  return store;
}

// --- Main execute ---

export async function execute(request: { input: WorkingMemoryInput }): Promise<WorkingMemoryOutput> {
  const { command, namespace, key, value, keys, options } = request.input;

  try {
    const s = await getStore();

    switch (command) {
      case 'set': {
        if (!key) return { ok: false, error: 'Missing required field: key' };
        if (value === undefined) return { ok: false, error: 'Missing required field: value' };
        const setOpts: SetOptions = {
          ttlMs: options?.ttlMs,
          tags: options?.tags,
          importance: options?.importance,
        };
        await s.set(namespace, key, value, setOpts);
        return { ok: true };
      }

      case 'get': {
        if (!key) return { ok: false, error: 'Missing required field: key' };
        const result = await s.get(namespace, key);
        return { ok: true, data: result };
      }

      case 'getMany': {
        if (!keys || keys.length === 0) return { ok: false, error: 'Missing required field: keys' };
        const results = await s.getMany(namespace, keys);
        return { ok: true, data: results };
      }

      case 'scan': {
        const scanOpts: ScanOptions = {
          tags: options?.tags,
          prefix: options?.prefix,
          minImportance: options?.minImportance,
        };
        const entries = await s.scan(namespace, scanOpts);
        return { ok: true, data: entries };
      }

      case 'delete': {
        if (!key) return { ok: false, error: 'Missing required field: key' };
        const deleted = await s.delete(namespace, key);
        return { ok: true, data: { deleted } };
      }

      case 'flush': {
        const count = await s.flush(namespace);
        return { ok: true, data: { flushed: count } };
      }

      case 'promote': {
        if (!key) return { ok: false, error: 'Missing required field: key' };
        const targetType = options?.targetType || 'episodic';
        const result = await s.promote(namespace, key, targetType);
        return { ok: true, data: result };
      }

      case 'stats': {
        const stats = s.getStats();
        return { ok: true, stats };
      }

      default:
        return { ok: false, error: `Unknown command: ${command}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Shutdown hook */
export async function shutdown(): Promise<void> {
  if (store) {
    await store.dispose();
    store = null;
  }
}
