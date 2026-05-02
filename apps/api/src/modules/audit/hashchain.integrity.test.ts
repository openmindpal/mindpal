/**
 * P1-2: 审计 Hash Chain 完整性验证增强测试
 * 
 * 验证点：
 * 1. prev_hash 链接关系正确性
 * 2. event_hash 数据完整性（重新计算并比对）
 * 3. 篡改检测能力
 * 4. 详细错误日志记录
 */

import { describe, expect, it, vi } from "vitest";
import { canonicalize, stableStringify, sha256Hex, computeEventHash } from "@mindpal/shared";

// ─── Tests ───────────────────────────────────────────────────────────────

describe("P1-2: Audit Hash Chain Integrity Verification", () => {
  
  describe("Hash Chain Linkage", () => {
    it("应该正确验证 prev_hash 链接关系", () => {
      const events = [
        { eventId: "ev-1", prevHash: null, data: { action: "create" } },
        { eventId: "ev-2", prevHash: null, data: { action: "read" } },
        { eventId: "ev-3", prevHash: null, data: { action: "update" } },
      ];

      // 计算 hash chain
      let prevHash: string | null = null;
      for (const ev of events) {
        const normalized = { timestamp: new Date().toISOString(), ...ev.data };
        const hash = computeEventHash({ prevHash, normalized });
        (ev as any).prevHash = prevHash;
        (ev as any).eventHash = hash;
        prevHash = hash;
      }

      // 验证链接关系
      expect(events[0].prevHash).toBeNull();
      expect(events[1].prevHash).toBe((events[0] as any).eventHash);
      expect(events[2].prevHash).toBe((events[1] as any).eventHash);
    });

    it("应该检测到断裂的 prev_hash 链接", () => {
      const ev1 = { action: "create" };
      const ev2 = { action: "read" };
      
      const hash1 = computeEventHash({ prevHash: null, normalized: ev1 });
      const hash2 = computeEventHash({ prevHash: hash1, normalized: ev2 });
      
      // 模拟篡改：修改 ev2 的 prev_hash
      const tamperedPrevHash = "tampered-hash";
      
      expect(tamperedPrevHash).not.toBe(hash1);
      expect(computeEventHash({ prevHash: tamperedPrevHash, normalized: ev2 })).not.toBe(hash2);
    });
  });

  describe("Event Hash Integrity", () => {
    it("应该正确计算并验证 event_hash", () => {
      const normalized = {
        timestamp: "2024-01-01T00:00:00.000Z",
        subjectId: "user-123",
        tenantId: "tenant-456",
        resourceType: "entity",
        action: "create",
        result: "success",
        traceId: "trace-789",
      };

      const hash = computeEventHash({ prevHash: null, normalized });
      
      expect(hash).toBeDefined();
      expect(hash.length).toBe(64); // SHA-256 hex length
      
      // 重新计算应该得到相同结果
      const hash2 = computeEventHash({ prevHash: null, normalized });
      expect(hash).toBe(hash2);
    });

    it("应该检测到数据篡改", () => {
      const original = {
        timestamp: "2024-01-01T00:00:00.000Z",
        action: "create",
        result: "success",
      };

      const tampered = {
        ...original,
        result: "denied", // 篡改结果
      };

      const hash1 = computeEventHash({ prevHash: null, normalized: original });
      const hash2 = computeEventHash({ prevHash: null, normalized: tampered });

      expect(hash1).not.toBe(hash2);
    });

    it("应该对字段顺序不敏感（规范化后一致）", () => {
      const a = { b: 1, a: 2, c: 3 };
      const b = { c: 3, b: 1, a: 2 };

      const hash1 = computeEventHash({ prevHash: null, normalized: a });
      const hash2 = computeEventHash({ prevHash: null, normalized: b });

      expect(hash1).toBe(hash2);
    });

    it("应该对数组顺序敏感", () => {
      const a = { items: [1, 2, 3] };
      const b = { items: [3, 2, 1] };

      const hash1 = computeEventHash({ prevHash: null, normalized: a });
      const hash2 = computeEventHash({ prevHash: null, normalized: b });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("Tampering Detection", () => {
    it("应该检测到时间戳篡改", () => {
      const original = {
        timestamp: "2024-01-01T00:00:00.000Z",
        action: "create",
      };

      const tampered = {
        ...original,
        timestamp: "2024-01-02T00:00:00.000Z", // 修改时间
      };

      const hash1 = computeEventHash({ prevHash: null, normalized: original });
      const hash2 = computeEventHash({ prevHash: null, normalized: tampered });

      expect(hash1).not.toBe(hash2);
    });

    it("应该检测到主体 ID 篡改", () => {
      const original = {
        timestamp: "2024-01-01T00:00:00.000Z",
        subjectId: "user-123",
        action: "delete",
      };

      const tampered = {
        ...original,
        subjectId: "user-999", // 冒充其他用户
      };

      const hash1 = computeEventHash({ prevHash: null, normalized: original });
      const hash2 = computeEventHash({ prevHash: null, normalized: tampered });

      expect(hash1).not.toBe(hash2);
    });

    it("应该检测到操作类型篡改", () => {
      const original = {
        timestamp: "2024-01-01T00:00:00.000Z",
        action: "read",
        result: "success",
      };

      const tampered = {
        ...original,
        action: "delete", // 将读操作改为删除
      };

      const hash1 = computeEventHash({ prevHash: null, normalized: original });
      const hash2 = computeEventHash({ prevHash: null, normalized: tampered });

      expect(hash1).not.toBe(hash2);
    });

    it("应该检测到策略决策篡改", () => {
      const original = {
        timestamp: "2024-01-01T00:00:00.000Z",
        action: "write",
        policyDecision: { allowed: false, reason: "insufficient_permissions" },
      };

      const tampered = {
        ...original,
        policyDecision: { allowed: true }, // 篡改为允许
      };

      const hash1 = computeEventHash({ prevHash: null, normalized: original });
      const hash2 = computeEventHash({ prevHash: null, normalized: tampered });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("Edge Cases", () => {
    it("空 prev_hash 应该被正确处理", () => {
      const normalized = { action: "first_event" };
      
      const hash1 = computeEventHash({ prevHash: null, normalized });
      const hash2 = computeEventHash({ prevHash: null, normalized });

      expect(hash1).toBe(hash2);
    });

    it("null 和 undefined 字段应该被正确处理", () => {
      const a = { field: null };
      const b = { field: undefined };

      const hash1 = computeEventHash({ prevHash: null, normalized: a });
      const hash2 = computeEventHash({ prevHash: null, normalized: b });

      // null 和 undefined 在 JSON.stringify 中表现不同
      expect(hash1).not.toBe(hash2);
    });

    it("嵌套对象应该被正确规范化", () => {
      const nested = {
        policy: {
          decision: {
            allowed: true,
            conditions: { role: "admin" },
          },
        },
      };

      const hash1 = computeEventHash({ prevHash: null, normalized: nested });
      const hash2 = computeEventHash({ prevHash: null, normalized: nested });

      expect(hash1).toBe(hash2);
    });

    it("长文本字段不应该影响 hash 计算", () => {
      const longText = "A".repeat(10000);
      const normalized = {
        action: "create",
        description: longText,
      };

      const hash = computeEventHash({ prevHash: null, normalized });
      
      expect(hash).toBeDefined();
      expect(hash.length).toBe(64);
    });
  });

  describe("Performance", () => {
    it("应该在合理时间内计算 hash", () => {
      const normalized = {
        timestamp: new Date().toISOString(),
        subjectId: "user-123",
        tenantId: "tenant-456",
        resourceType: "entity",
        action: "create",
        result: "success",
        traceId: "trace-789",
        requestId: "req-001",
        runId: "run-001",
        stepId: "step-001",
        policyDecision: { allowed: true },
        inputDigest: { keyCount: 5, keys: ["a", "b", "c"] },
        outputDigest: { keyCount: 3, keys: ["x", "y", "z"] },
      };

      const iterations = 1000;
      const start = Date.now();
      
      for (let i = 0; i < iterations; i++) {
        computeEventHash({ prevHash: null, normalized });
      }
      
      const duration = Date.now() - start;
      const avgTime = duration / iterations;

      expect(avgTime).toBeLessThan(1); // 平均每次 < 1ms
      console.log(`Hash computation: ${avgTime.toFixed(3)}ms per operation (${iterations} iterations)`);
    });
  });

  describe("Verification Workflow", () => {
    it("应该能够验证完整的 hash chain", () => {
      // 生成一系列事件
      const events: Array<{ normalized: any; storedHash: string; storedPrevHash: string | null }> = [];
      let prevHash: string | null = null;

      for (let i = 0; i < 5; i++) {
        const normalized = {
          timestamp: `2024-01-0${i + 1}T00:00:00.000Z`,
          action: `action_${i}`,
          result: "success",
        };

        const hash = computeEventHash({ prevHash, normalized });
        events.push({ normalized, storedHash: hash, storedPrevHash: prevHash });
        prevHash = hash;
      }

      // 验证整个链
      let verificationPrevHash: string | null = null;
      let allValid = true;
      const failures: Array<{ index: number; reason: string }> = [];

      for (let i = 0; i < events.length; i++) {
        const ev = events[i];

        // 检查 prev_hash
        if (ev.storedPrevHash !== verificationPrevHash) {
          allValid = false;
          failures.push({ index: i, reason: "prev_hash_mismatch" });
        }

        // 重新计算并验证 event_hash
        const computedHash = computeEventHash({ prevHash: ev.storedPrevHash, normalized: ev.normalized });
        if (computedHash !== ev.storedHash) {
          allValid = false;
          failures.push({ index: i, reason: "event_hash_integrity_failed" });
        }

        verificationPrevHash = ev.storedHash;
      }

      expect(allValid).toBe(true);
      expect(failures.length).toBe(0);
    });

    it("应该能够检测到链中的篡改事件", () => {
      // 生成一系列事件
      const events: Array<{ normalized: any; storedHash: string; storedPrevHash: string | null }> = [];
      let prevHash: string | null = null;

      for (let i = 0; i < 5; i++) {
        const normalized = {
          timestamp: `2024-01-0${i + 1}T00:00:00.000Z`,
          action: `action_${i}`,
          result: "success",
        };

        const hash = computeEventHash({ prevHash, normalized });
        events.push({ normalized, storedHash: hash, storedPrevHash: prevHash });
        prevHash = hash;
      }

      // 篡改第 3 个事件
      events[2].normalized.result = "denied";

      // 验证整个链
      let verificationPrevHash: string | null = null;
      const failures: Array<{ index: number; reason: string }> = [];

      for (let i = 0; i < events.length; i++) {
        const ev = events[i];

        // 重新计算并验证 event_hash
        const computedHash = computeEventHash({ prevHash: ev.storedPrevHash, normalized: ev.normalized });
        if (computedHash !== ev.storedHash) {
          failures.push({ index: i, reason: "event_hash_integrity_failed" });
        }

        verificationPrevHash = ev.storedHash;
      }

      expect(failures.length).toBeGreaterThan(0);
      expect(failures.some(f => f.index === 2)).toBe(true); // 应该检测到第 3 个事件的篡改
    });
  });
});
