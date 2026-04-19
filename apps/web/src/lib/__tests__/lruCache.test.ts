import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LRUCache } from "../lruCache";

describe("web/LRUCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("basic get/set operations", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60_000 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.size).toBe(1);
  });

  it("get returns undefined for missing key", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60_000 });
    expect(cache.get("missing")).toBeUndefined();
  });

  it("TTL expiration — get returns undefined after ttl", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1_000 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);

    vi.advanceTimersByTime(1_001);
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts least-recently-used entry when capacity exceeded", () => {
    const cache = new LRUCache<string, number>({ maxSize: 2, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // should evict "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("get promotes entry to MRU — accessed entry survives eviction", () => {
    const cache = new LRUCache<string, number>({ maxSize: 2, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);

    // Access "a" to promote it to MRU
    cache.get("a");

    // Insert "c" — should evict "b" (LRU), not "a"
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("purgeExpired removes all expired entries and returns count", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1_000 });
    cache.set("a", 1);
    cache.set("b", 2);

    vi.advanceTimersByTime(500);
    cache.set("c", 3); // added later, not yet expired after next advance

    vi.advanceTimersByTime(600); // total 1100ms: a,b expired; c at 600ms — not expired

    const purged = cache.purgeExpired();
    expect(purged).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("maxSize=1 — always keeps only the latest entry", () => {
    const cache = new LRUCache<string, number>({ maxSize: 1, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.size).toBe(1);
  });

  it("set same key repeatedly updates value without growing size", () => {
    const cache = new LRUCache<string, number>({ maxSize: 5, ttlMs: 60_000 });
    cache.set("x", 1);
    cache.set("x", 2);
    cache.set("x", 3);

    expect(cache.size).toBe(1);
    expect(cache.get("x")).toBe(3);
  });

  it("has() returns true for existing key and false for expired/missing", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1_000 });
    cache.set("a", 1);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(cache.has("a")).toBe(false);
  });

  it("delete removes entry", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60_000 });
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("clear removes all entries", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
