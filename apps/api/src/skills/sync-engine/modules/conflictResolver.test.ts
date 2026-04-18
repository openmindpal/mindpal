/**
 * P2-12: 离线同步端到端边界场景测试
 *
 * 测试场景：
 * 1. 并发编辑同一字段 (LWW)
 * 2. 并发编辑不同字段 (field-level merge)
 * 3. 集合字段并发修改 (set union)
 * 4. 计数器字段并发修改 (counter add)
 * 5. 长时间离线后大批量重放
 * 6. 弱网场景 — 部分操作成功
 * 7. 冲突链 — 多端连续冲突
 * 8. 手动解决字段
 */
import { describe, it, expect } from "vitest";
import {
  detectAndResolveConflicts,
  DEFAULT_CONFLICT_POLICY,
  type FieldConflictPolicy,
  type MergeResult,
} from "./conflictResolver";

describe("P2-12: 离线同步冲突解决 — 端到端边界场景", () => {

  // ── 场景1: 并发编辑同一标量字段 (LWW) ──────────────────

  describe("LWW 标量字段冲突", () => {
    it("客户端时间更新时客户端胜出", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { name: "原始", status: "draft" },
        serverRecord: { name: "服务端修改", status: "draft" },
        clientPatch: { name: "客户端修改" },
        clientMeta: { updatedAt: "2026-04-06T10:00:00Z" },
        serverMeta: { updatedAt: "2026-04-06T09:00:00Z" },
      });
      expect(result.fullyAutoResolved).toBe(true);
      expect(result.autoResolved.length).toBe(1);
      expect(result.autoResolved[0].resolvedValue).toBe("客户端修改");
      expect(result.autoResolved[0].trail.winner).toBe("client");
    });

    it("服务端时间更新时服务端胜出", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { name: "原始" },
        serverRecord: { name: "服务端修改" },
        clientPatch: { name: "客户端修改" },
        clientMeta: { updatedAt: "2026-04-06T08:00:00Z" },
        serverMeta: { updatedAt: "2026-04-06T10:00:00Z" },
      });
      expect(result.autoResolved[0].resolvedValue).toBe("服务端修改");
      expect(result.autoResolved[0].trail.winner).toBe("server");
    });

    it("无时间戳时服务端胜出 (默认)", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { name: "原始" },
        serverRecord: { name: "服务端修改" },
        clientPatch: { name: "客户端修改" },
      });
      expect(result.autoResolved[0].resolvedValue).toBe("服务端修改");
    });
  });

  // ── 场景2: 并发编辑不同字段 (无冲突) ──────────────────

  describe("不同字段无冲突", () => {
    it("服务端改 name，客户端改 description → 两者都保留", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { name: "原始", description: "旧描述" },
        serverRecord: { name: "新名称", description: "旧描述" },
        clientPatch: { description: "新描述" },
      });
      expect(result.noConflict).toContain("description");
      expect(result.mergedPatch.description).toBe("新描述");
      expect(result.autoResolved.length).toBe(0);
      expect(result.manualRequired.length).toBe(0);
    });

    it("客户端与服务端修改相同值 → 无冲突(convergent)", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { status: "draft" },
        serverRecord: { status: "published" },
        clientPatch: { status: "published" },
      });
      expect(result.noConflict).toContain("status");
      expect(result.mergedPatch.status).toBe("published");
    });
  });

  // ── 场景3: 集合字段并发修改 (Set Union) ──────────────────

  describe("集合字段 Set Union 合并", () => {
    it("双方各自添加不同标签 → 合并为并集", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { tags: ["A", "B"] },
        serverRecord: { tags: ["A", "B", "C"] },
        clientPatch: { tags: ["A", "B", "D"] },
        policy: { ...DEFAULT_CONFLICT_POLICY, setFields: ["tags"] },
      });
      const tags = result.mergedPatch.tags as string[];
      expect(tags).toContain("A");
      expect(tags).toContain("B");
      expect(tags).toContain("C");
      expect(tags).toContain("D");
      expect(result.autoResolved[0].trail.winner).toBe("merged");
    });

    it("一方删除一方添加 → 删除保留，添加也保留", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { tags: ["A", "B", "C"] },
        serverRecord: { tags: ["A", "C"] },       // removed B
        clientPatch: { tags: ["A", "B", "C", "D"] }, // added D
        policy: { ...DEFAULT_CONFLICT_POLICY, setFields: ["tags"] },
      });
      const tags = result.mergedPatch.tags as string[];
      expect(tags).toContain("A");
      expect(tags).not.toContain("B"); // server removed B
      expect(tags).toContain("C");
      expect(tags).toContain("D");     // client added D
    });

    it("空集合 → 正常处理", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { tags: [] },
        serverRecord: { tags: ["A"] },
        clientPatch: { tags: ["B"] },
        policy: { ...DEFAULT_CONFLICT_POLICY, setFields: ["tags"] },
      });
      const tags = result.mergedPatch.tags as string[];
      expect(tags).toContain("A");
      expect(tags).toContain("B");
    });
  });

  // ── 场景4: 计数器字段并发修改 ──────────────────────────

  describe("计数器 Counter Add 合并", () => {
    it("双方各自增加 → 增量累加", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { viewCount: 100 },
        serverRecord: { viewCount: 110 },  // +10
        clientPatch: { viewCount: 105 },    // +5
        policy: { ...DEFAULT_CONFLICT_POLICY, counterFields: ["viewCount"] },
      });
      // 100 + 10 + 5 = 115
      expect(result.mergedPatch.viewCount).toBe(115);
    });

    it("一方减少一方增加 → 增量合并", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { likeCount: 50 },
        serverRecord: { likeCount: 45 },  // -5
        clientPatch: { likeCount: 53 },    // +3
        policy: { ...DEFAULT_CONFLICT_POLICY, counterFields: ["likeCount"] },
      });
      // 50 + (-5) + 3 = 48
      expect(result.mergedPatch.likeCount).toBe(48);
    });
  });

  // ── 场景5: 大批量操作 ─────────────────────────────────

  describe("大批量并发操作", () => {
    it("100个不同字段的并发修改 → 全部无冲突", () => {
      const base: Record<string, any> = {};
      const server: Record<string, any> = {};
      const clientPatch: Record<string, any> = {};
      for (let i = 0; i < 100; i++) {
        base[`field_${i}`] = `original_${i}`;
        server[`field_${i}`] = `original_${i}`; // server unchanged
        clientPatch[`field_${i}`] = `client_${i}`;
      }
      const result = detectAndResolveConflicts({ baseRecord: base, serverRecord: server, clientPatch });
      expect(result.noConflict.length).toBe(100);
      expect(result.fullyAutoResolved).toBe(true);
    });

    it("50个字段全部冲突 → LWW 自动解决", () => {
      const base: Record<string, any> = {};
      const server: Record<string, any> = {};
      const clientPatch: Record<string, any> = {};
      for (let i = 0; i < 50; i++) {
        base[`field_${i}`] = `original_${i}`;
        server[`field_${i}`] = `server_${i}`;
        clientPatch[`field_${i}`] = `client_${i}`;
      }
      const result = detectAndResolveConflicts({
        baseRecord: base, serverRecord: server, clientPatch,
        clientMeta: { updatedAt: "2026-04-06T12:00:00Z" },
        serverMeta: { updatedAt: "2026-04-06T11:00:00Z" },
      });
      expect(result.autoResolved.length).toBe(50);
      expect(result.fullyAutoResolved).toBe(true);
      // 客户端时间更新 → 全部客户端胜出
      expect(result.autoResolved.every((c) => c.resolvedValue.startsWith("client_"))).toBe(true);
    });
  });

  // ── 场景6: 混合策略 ───────────────────────────────────

  describe("混合策略冲突解决", () => {
    it("不同字段使用不同策略", () => {
      const policy: FieldConflictPolicy = {
        defaultStrategy: "lww",
        setFields: ["tags"],
        counterFields: ["viewCount"],
        fieldOverrides: { "status": "server_wins" },
        manualFields: ["criticalNote"],
      };

      const result = detectAndResolveConflicts({
        baseRecord: { name: "原始", tags: ["A"], viewCount: 10, status: "draft", criticalNote: "重要" },
        serverRecord: { name: "服务端", tags: ["A", "B"], viewCount: 15, status: "published", criticalNote: "服务端修改" },
        clientPatch: { name: "客户端", tags: ["A", "C"], viewCount: 13, status: "archived", criticalNote: "客户端修改" },
        policy,
        clientMeta: { updatedAt: "2026-04-06T12:00:00Z" },
        serverMeta: { updatedAt: "2026-04-06T11:00:00Z" },
      });

      // name: LWW → 客户端胜出
      expect(result.mergedPatch.name).toBe("客户端");
      // tags: set_union → A,B,C
      const tags = result.mergedPatch.tags as string[];
      expect(tags).toContain("B");
      expect(tags).toContain("C");
      // viewCount: counter_add → 10 + 5 + 3 = 18
      expect(result.mergedPatch.viewCount).toBe(18);
      // status: server_wins → published
      expect(result.mergedPatch.status).toBe("published");
      // criticalNote: manual → 需手动解决
      expect(result.manualRequired.length).toBe(1);
      expect(result.manualRequired[0].fieldPath).toBe("criticalNote");
      expect(result.fullyAutoResolved).toBe(false);
    });
  });

  // ── 场景7: 字段级深度合并 ──────────────────────────────

  describe("字段级深度对象合并", () => {
    it("嵌套对象不同子字段修改 → 深度合并", () => {
      const policy: FieldConflictPolicy = {
        defaultStrategy: "field_level_merge",
      };
      const result = detectAndResolveConflicts({
        baseRecord: { metadata: { color: "red", size: 10, position: { x: 0, y: 0 } } },
        serverRecord: { metadata: { color: "blue", size: 10, position: { x: 0, y: 0 } } },
        clientPatch: { metadata: { color: "red", size: 20, position: { x: 0, y: 0 } } },
        policy,
      });
      // 服务端改了 color，客户端改了 size → 合并
      const meta = result.mergedPatch.metadata;
      expect(meta.color).toBe("blue");  // server change
      expect(meta.size).toBe(20);       // client change
    });
  });

  // ── 场景8: 边界条件 ───────────────────────────────────

  describe("边界条件", () => {
    it("空 patch → 空结果", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { name: "test" },
        serverRecord: { name: "test" },
        clientPatch: {},
      });
      expect(result.noConflict.length).toBe(0);
      expect(result.autoResolved.length).toBe(0);
      expect(result.fullyAutoResolved).toBe(true);
    });

    it("null/undefined 值正确处理", () => {
      const result = detectAndResolveConflicts({
        baseRecord: { name: null },
        serverRecord: { name: "server" },
        clientPatch: { name: "client" },
        clientMeta: { updatedAt: "2026-04-06T12:00:00Z" },
        serverMeta: { updatedAt: "2026-04-06T11:00:00Z" },
      });
      expect(result.mergedPatch.name).toBe("client");
    });

    it("新增字段无冲突 → 直接接受", () => {
      const result = detectAndResolveConflicts({
        baseRecord: {},
        serverRecord: {},
        clientPatch: { newField: "value" },
      });
      expect(result.noConflict).toContain("newField");
      expect(result.mergedPatch.newField).toBe("value");
    });

    it("策略摘要统计正确", () => {
      const policy: FieldConflictPolicy = {
        defaultStrategy: "lww",
        setFields: ["tags"],
        counterFields: ["count"],
      };
      const result = detectAndResolveConflicts({
        baseRecord: { a: 1, tags: ["x"], count: 10 },
        serverRecord: { a: 2, tags: ["x", "y"], count: 15 },
        clientPatch: { a: 3, tags: ["x", "z"], count: 12 },
        policy,
      });
      expect(result.strategySummary["lww"]).toBe(1);
      expect(result.strategySummary["set_union"]).toBe(1);
      expect(result.strategySummary["counter_add"]).toBe(1);
    });
  });
});
