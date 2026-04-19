/**
 * Test helpers — typed mock factories for Pool & Queue.
 * Replaces `{} as any` with minimal but type-safe stubs.
 */
import type { Pool } from "pg";

/** Minimal Pool mock that satisfies the Pool interface at runtime. */
export function mockPool(overrides?: Partial<Pool>): Pool {
  return {
    query: async () => ({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] }), release: () => {} }) as any,
    end: async () => {},
    on: () => ({} as any),
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    ...overrides,
  } as Pool;
}

/** Minimal Queue mock matching WorkflowQueue shape. */
export function mockQueue(overrides?: Record<string, unknown>): Record<string, unknown> & { enqueue: (...args: unknown[]) => Promise<void> } {
  return {
    enqueue: async () => {},
    ...overrides,
  };
}
