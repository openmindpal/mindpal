import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseDateValue,
  fmtDateTime,
  fmtDate,
  fmtTime,
  fmtShortDateTime,
  dateValueToMs,
} from "../fmtDateTime";
import { LRUCache } from "../lruCache";
import { toRecord, toDisplayText, stringField, numberField } from "../viewData";

/* ═══════════ fmtDateTime.ts ═══════════ */
describe("web/fmtDateTime", () => {
  describe("parseDateValue", () => {
    it("should parse ISO string", () => {
      const d = parseDateValue("2024-06-15T12:30:00Z");
      expect(d).toBeInstanceOf(Date);
      expect(d!.toISOString()).toBe("2024-06-15T12:30:00.000Z");
    });

    it("should parse epoch seconds (< 1e11)", () => {
      const d = parseDateValue(1718451000); // ~2024-06-15
      expect(d).toBeInstanceOf(Date);
      expect(d!.getFullYear()).toBe(2024);
    });

    it("should parse epoch ms (>= 1e11)", () => {
      const ms = 1718451000000;
      const d = parseDateValue(ms);
      expect(d).toBeInstanceOf(Date);
      expect(d!.getTime()).toBe(ms);
    });

    it("should parse Date object", () => {
      const now = new Date();
      expect(parseDateValue(now)).toBe(now);
    });

    it("should return null for invalid Date", () => {
      expect(parseDateValue(new Date("invalid"))).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(parseDateValue("")).toBeNull();
      expect(parseDateValue("  ")).toBeNull();
    });

    it("should return null for non-date types", () => {
      expect(parseDateValue(null)).toBeNull();
      expect(parseDateValue(undefined)).toBeNull();
      expect(parseDateValue({})).toBeNull();
    });

    it("should return null for NaN/Infinity", () => {
      expect(parseDateValue(NaN)).toBeNull();
      expect(parseDateValue(Infinity)).toBeNull();
    });

    it("should parse space-separated datetime", () => {
      const d = parseDateValue("2024-06-15 12:30:00");
      expect(d).toBeInstanceOf(Date);
    });

    it("should parse numeric string", () => {
      const d = parseDateValue("1718451000");
      expect(d).toBeInstanceOf(Date);
    });

    it("should parse timezone offset format", () => {
      const d = parseDateValue("2024-06-15T12:30:00+08:00");
      expect(d).toBeInstanceOf(Date);
    });
  });

  describe("fmtDateTime", () => {
    // Use a UTC date to avoid timezone issues
    const isoDate = "2024-06-15T08:30:45Z";

    it("should format zh-CN as YYYY-MM-DD HH:mm:ss", () => {
      const result = fmtDateTime(isoDate, "zh-CN");
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("should format en-US as MM/DD/YYYY, HH:mm:ss AM/PM", () => {
      const result = fmtDateTime(isoDate, "en-US");
      expect(result).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2} [AP]M$/);
    });

    it("should return — for invalid input", () => {
      expect(fmtDateTime(null, "zh-CN")).toBe("—");
    });
  });

  describe("fmtDate", () => {
    it("should format zh-CN date only", () => {
      const result = fmtDate("2024-01-05T00:00:00Z", "zh-CN");
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("should format en-US date only", () => {
      const result = fmtDate("2024-01-05T00:00:00Z", "en-US");
      expect(result).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    });
  });

  describe("fmtTime", () => {
    it("should format zh-CN 24h time", () => {
      const result = fmtTime("2024-01-05T14:30:00Z", "zh-CN");
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it("should format en-US 12h time", () => {
      const result = fmtTime("2024-01-05T14:30:00Z", "en-US");
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2} [AP]M$/);
    });
  });

  describe("fmtShortDateTime", () => {
    it("should return short format for zh-CN", () => {
      const result = fmtShortDateTime("2024-06-15T08:30:00Z", "zh-CN");
      expect(result).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it("should return short format for en-US with AM/PM", () => {
      const result = fmtShortDateTime("2024-06-15T14:30:00Z", "en-US");
      expect(result).toMatch(/[AP]M$/);
    });

    it("should return — for invalid", () => {
      expect(fmtShortDateTime(undefined, "zh-CN")).toBe("—");
    });
  });

  describe("dateValueToMs", () => {
    it("should return ms for valid date", () => {
      const ms = dateValueToMs("2024-06-15T00:00:00Z");
      expect(ms).toBe(new Date("2024-06-15T00:00:00Z").getTime());
    });

    it("should return null for invalid", () => {
      expect(dateValueToMs(null)).toBeNull();
    });
  });
});

/* ═══════════ lruCache.ts ═══════════ */
describe("web/lruCache", () => {
  it("should set and get a value", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60000 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("should return undefined for missing key", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60000 });
    expect(cache.get("x")).toBeUndefined();
  });

  it("should evict oldest entry when maxSize exceeded", () => {
    const cache = new LRUCache<string, number>({ maxSize: 2, ttlMs: 60000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // should evict "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("should expire entries after TTL", () => {
    vi.useFakeTimers();
    try {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 });
      cache.set("a", 1);
      vi.advanceTimersByTime(1001);
      expect(cache.get("a")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should promote entry on get (LRU)", () => {
    const cache = new LRUCache<string, number>({ maxSize: 2, ttlMs: 60000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // promote "a"
    cache.set("c", 3); // should evict "b" (least recently used)
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("has() should return true for existing key", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60000 });
    cache.set("a", 1);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("delete() should remove entry", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60000 });
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
  });

  it("clear() should remove all entries", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("size should reflect current entry count", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60000 });
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    expect(cache.size).toBe(1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
  });

  it("purgeExpired() should remove expired entries", () => {
    vi.useFakeTimers();
    try {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 1000 });
      cache.set("a", 1);
      cache.set("b", 2);
      vi.advanceTimersByTime(500);
      cache.set("c", 3);
      vi.advanceTimersByTime(600); // a,b expired; c still alive
      const purged = cache.purgeExpired();
      expect(purged).toBe(2);
      expect(cache.get("c")).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("set() should overwrite existing entry", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10, ttlMs: 60000 });
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.get("a")).toBe(2);
    expect(cache.size).toBe(1);
  });
});

/* ═══════════ viewData.ts ═══════════ */
describe("web/viewData", () => {
  describe("toRecord", () => {
    it("should return object as-is", () => {
      const obj = { a: 1 };
      expect(toRecord(obj)).toBe(obj);
    });

    it("should return null for array", () => {
      expect(toRecord([1, 2])).toBeNull();
    });

    it("should return null for null/undefined", () => {
      expect(toRecord(null)).toBeNull();
      expect(toRecord(undefined)).toBeNull();
    });

    it("should return null for primitives", () => {
      expect(toRecord("str")).toBeNull();
      expect(toRecord(42)).toBeNull();
    });
  });

  describe("toDisplayText", () => {
    it("should return empty string for null/undefined", () => {
      expect(toDisplayText(null)).toBe("");
      expect(toDisplayText(undefined)).toBe("");
    });

    it("should convert string/number/boolean to string", () => {
      expect(toDisplayText("hello")).toBe("hello");
      expect(toDisplayText(42)).toBe("42");
      expect(toDisplayText(true)).toBe("true");
    });

    it("should convert Date to ISO string", () => {
      const d = new Date("2024-01-01T00:00:00Z");
      expect(toDisplayText(d)).toBe(d.toISOString());
    });

    it("should JSON.stringify objects", () => {
      expect(toDisplayText({ a: 1 })).toBe('{"a":1}');
    });
  });

  describe("stringField", () => {
    it("should return string value", () => {
      expect(stringField({ name: "alice" }, "name")).toBe("alice");
    });

    it("should return undefined for non-string", () => {
      expect(stringField({ age: 30 }, "age")).toBeUndefined();
    });
  });

  describe("numberField", () => {
    it("should return number value", () => {
      expect(numberField({ age: 30 }, "age")).toBe(30);
    });

    it("should return undefined for non-number", () => {
      expect(numberField({ name: "alice" }, "name")).toBeUndefined();
    });
  });
});
