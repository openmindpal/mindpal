/**
 * P1-3 验证：Memory OS — 冲突仲裁、蒸馏升级链、差异化衰减策略
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ─── 共用 mock pool ─── */
function mockPool(queryResults: Record<string, any> = {}) {
  return {
    query: vi.fn(async (sql: string, _params?: any[]) => {
      for (const [key, val] of Object.entries(queryResults)) {
        if (sql.includes(key)) return val;
      }
      return { rows: [], rowCount: 0 };
    }),
  } as any;
}

/* ================================================================== */
/*  冲突仲裁协议                                                       */
/* ================================================================== */

import { arbitrateMemoryConflict, type ArbitrationStrategy, type MemoryEntryRow } from "../modules/memory/repo";

function makeMemEntry(overrides: Partial<MemoryEntryRow> = {}): MemoryEntryRow {
  return {
    id: "mem-new",
    tenantId: "t1",
    spaceId: "s1",
    ownerSubjectId: "user1",
    scope: "user",
    type: "fact",
    title: null,
    contentText: "新记忆内容",
    contentDigest: "abc",
    expiresAt: null,
    retentionDays: null,
    writePolicy: "confirmed",
    sourceRef: null,
    writeProof: null,
    sourceTrust: 1,
    factVersion: 1,
    confidence: 0.8,
    salience: 0.5,
    conflictMarker: null,
    resolutionStatus: null,
    memoryClass: "semantic",
    accessCount: 0,
    lastAccessedAt: null,
    decayScore: 1.0,
    decayUpdatedAt: new Date().toISOString(),
    distilledFrom: null,
    distilledTo: null,
    distillationGeneration: 0,
    ...overrides,
  } as MemoryEntryRow;
}

describe("arbitrateMemoryConflict", () => {
  it("置信度差距大时使用 confidence_priority 策略", async () => {
    const pool = mockPool({
      "UPDATE memory_entries": { rows: [], rowCount: 1 },
      "INSERT INTO memory_arbitration_log": { rows: [], rowCount: 1 },
    });
    const result = await arbitrateMemoryConflict({
      pool,
      tenantId: "t1",
      spaceId: "s1",
      newMemory: makeMemEntry({ id: "new-1", confidence: 0.9 }),
      conflictMemories: [
        { id: "old-1", confidence: 0.4, createdAt: new Date().toISOString(), contentText: "旧内容", title: null },
      ],
    });
    expect(result.strategy).toBe("confidence_priority");
    expect(result.winnerMemoryId).toBeDefined();
    expect(result.needsUserConfirmation).toBe(false);
  });

  it("单一冲突且置信度接近使用 time_priority 策略", async () => {
    const pool = mockPool({
      "UPDATE memory_entries": { rows: [], rowCount: 1 },
      "INSERT INTO memory_arbitration_log": { rows: [], rowCount: 1 },
    });
    const result = await arbitrateMemoryConflict({
      pool,
      tenantId: "t1",
      spaceId: "s1",
      newMemory: makeMemEntry({ id: "new-1", confidence: 0.7 }),
      conflictMemories: [
        { id: "old-1", confidence: 0.75, createdAt: new Date().toISOString(), contentText: "旧内容", title: null },
      ],
    });
    expect(result.strategy).toBe("time_priority");
    expect(result.winnerMemoryId).toBe("new-1");
  });

  it("多重冲突(>=3)标记需要用户确认", async () => {
    const pool = mockPool({
      "UPDATE memory_entries": { rows: [], rowCount: 1 },
      "INSERT INTO memory_arbitration_log": { rows: [], rowCount: 1 },
    });
    const conflicts = Array.from({ length: 3 }, (_, i) => ({
      id: `old-${i}`, confidence: 0.7, createdAt: new Date().toISOString(), contentText: `旧${i}`, title: null,
    }));
    const result = await arbitrateMemoryConflict({
      pool,
      tenantId: "t1",
      spaceId: "s1",
      newMemory: makeMemEntry({ id: "new-1", confidence: 0.72 }),
      conflictMemories: conflicts,
    });
    expect(result.strategy).toBe("user_confirmed");
    expect(result.needsUserConfirmation).toBe(true);
  });

  it("显式指定策略时使用指定策略", async () => {
    const pool = mockPool({
      "UPDATE memory_entries": { rows: [], rowCount: 1 },
      "INSERT INTO memory_arbitration_log": { rows: [], rowCount: 1 },
      "INSERT INTO memory_entries": { rows: [{ id: "merged-1" }], rowCount: 1 },
    });
    const result = await arbitrateMemoryConflict({
      pool,
      tenantId: "t1",
      spaceId: "s1",
      newMemory: makeMemEntry({ id: "new-1" }),
      conflictMemories: [
        { id: "old-1", confidence: 0.5, createdAt: new Date().toISOString(), contentText: "旧", title: null },
      ],
      strategy: "time_priority",
    });
    expect(result.strategy).toBe("time_priority");
  });
});

/* ================================================================== */
/*  detectMemoryConflicts                                               */
/* ================================================================== */

import { detectMemoryConflicts } from "../modules/memory/repo";

describe("detectMemoryConflicts", () => {
  it("无候选时返回无冲突", async () => {
    const pool = mockPool({});
    const result = await detectMemoryConflicts({
      pool,
      tenantId: "t1",
      spaceId: "s1",
      subjectId: "user1",
      type: "fact",
      contentText: "测试内容",
    });
    expect(result.hasConflicts).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });
});

/* ================================================================== */
/*  差异化衰减策略验证                                                   */
/* ================================================================== */

describe("差异化衰减策略逻辑验证", () => {
  // 直接验证衰减公式逻辑（不依赖 DB）
  function computeDecay(memClass: string, ageDays: number, accessCount: number, confidence: number): number {
    switch (memClass) {
      case "episodic": {
        const halfLifeDays = 7;
        const accessSlowdown = 1 + accessCount * 0.1;
        return Math.exp(-0.693 * ageDays / (halfLifeDays * accessSlowdown));
      }
      case "semantic": {
        const halfLifeDays = 90;
        const confidenceBonus = confidence * 0.3;
        return Math.max(0, 1 - (ageDays / (halfLifeDays * 2)) * (1 - confidenceBonus));
      }
      case "procedural": {
        const halfLifeDays = 365;
        let score = Math.exp(-0.693 * ageDays / halfLifeDays);
        score = Math.max(0.1, score);
        return score;
      }
      default:
        return 1;
    }
  }

  it("episodic 衰减最快：7天后约半衰", () => {
    const score = computeDecay("episodic", 7, 0, 0.5);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it("episodic 访问可延缓衰减", () => {
    const noAccess = computeDecay("episodic", 14, 0, 0.5);
    const withAccess = computeDecay("episodic", 14, 10, 0.5);
    expect(withAccess).toBeGreaterThan(noAccess);
  });

  it("semantic 衰减比 episodic 慢", () => {
    const episodic = computeDecay("episodic", 30, 0, 0.5);
    const semantic = computeDecay("semantic", 30, 0, 0.5);
    expect(semantic).toBeGreaterThan(episodic);
  });

  it("semantic 高置信度衰减更慢", () => {
    const lowConf = computeDecay("semantic", 60, 0, 0.3);
    const highConf = computeDecay("semantic", 60, 0, 0.9);
    expect(highConf).toBeGreaterThan(lowConf);
  });

  it("procedural 几乎不衰减：365天后约半衰", () => {
    const score = computeDecay("procedural", 365, 0, 0.5);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it("procedural 最低保留 0.1", () => {
    const score = computeDecay("procedural", 3650, 0, 0.5);
    expect(score).toBeGreaterThanOrEqual(0.1);
  });

  it("衰减速率排序：episodic > semantic > procedural", () => {
    const age = 30;
    const e = computeDecay("episodic", age, 0, 0.5);
    const s = computeDecay("semantic", age, 0, 0.5);
    const p = computeDecay("procedural", age, 0, 0.5);
    expect(p).toBeGreaterThan(s);
    expect(s).toBeGreaterThan(e);
  });
});
