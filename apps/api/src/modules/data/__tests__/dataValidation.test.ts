import { describe, it, expect } from "vitest";
import { applyWriteFieldRules, applyReadFieldRules } from "../fieldRules";
import { validateEntityPayload } from "../validate";
import type { PolicyDecision } from "@mindpal/shared";

const allow = (fr?: any): PolicyDecision => ({ decision: "allow", ...fr });

/* ── fieldRules ── */
describe("data/fieldRules", () => {
  describe("applyWriteFieldRules", () => {
    it("should pass-through when allow=['*'] and no deny", () => {
      const d = allow({ fieldRules: { write: { allow: ["*"] } } });
      const payload = { a: 1, b: 2, c: 3 };
      expect(applyWriteFieldRules(payload, d)).toBe(payload);
    });

    it("should throw FIELD_WRITE_FORBIDDEN for denied fields", () => {
      const d = allow({ fieldRules: { write: { deny: ["secret"] } } });
      try {
        applyWriteFieldRules({ name: "ok", secret: "bad" }, d);
        expect.unreachable("should throw");
      } catch (e: any) {
        expect(e.message).toBe("FIELD_WRITE_FORBIDDEN");
        expect(e.fields).toEqual(["secret"]);
      }
    });

    it("should throw when field not in allow list (non-wildcard)", () => {
      const d = allow({ fieldRules: { write: { allow: ["name", "email"] } } });
      try {
        applyWriteFieldRules({ name: "ok", phone: "bad" }, d);
        expect.unreachable("should throw");
      } catch (e: any) {
        expect(e.message).toBe("FIELD_WRITE_FORBIDDEN");
        expect(e.fields).toContain("phone");
      }
    });

    it("should pass when all fields in allow list", () => {
      const d = allow({ fieldRules: { write: { allow: ["name", "email"] } } });
      const payload = { name: "alice", email: "a@b.c" };
      expect(applyWriteFieldRules(payload, d)).toBe(payload);
    });

    it("should pass-through when no fieldRules at all", () => {
      const d = allow();
      const payload = { any: "field" };
      expect(applyWriteFieldRules(payload, d)).toBe(payload);
    });
  });

  describe("applyReadFieldRules", () => {
    it("should pass-through when allow=['*']", () => {
      const d = allow({ fieldRules: { read: { allow: ["*"] } } });
      const payload = { a: 1, b: 2 };
      expect(applyReadFieldRules(payload, d)).toBe(payload);
    });

    it("should filter out denied fields", () => {
      const d = allow({ fieldRules: { read: { deny: ["secret", "password"] } } });
      const result = applyReadFieldRules({ name: "alice", secret: "x", password: "y", age: 30 }, d);
      expect(result).toEqual({ name: "alice", age: 30 });
    });

    it("should only include allowed fields (non-wildcard)", () => {
      const d = allow({ fieldRules: { read: { allow: ["name", "email"] } } });
      const result = applyReadFieldRules({ name: "alice", email: "a@b", phone: "123" }, d);
      expect(result).toEqual({ name: "alice", email: "a@b" });
    });

    it("should return all when no fieldRules", () => {
      const d = allow();
      const payload = { a: 1, b: 2 };
      expect(applyReadFieldRules(payload, d)).toEqual(payload);
    });
  });
});

/* ── validate ── */
describe("data/validate", () => {
  const schema: any = {
    entities: {
      Task: {
        fields: {
          title: { type: "string", required: true },
          priority: { type: "number", required: false },
          done: { type: "boolean", required: false },
          dueDate: { type: "datetime", required: false },
          meta: { type: "json", required: false },
          ownerId: { type: "reference", required: false },
        },
      },
    },
  };

  describe("validateEntityPayload", () => {
    it("should pass for a valid payload", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: { title: "Do it", priority: 1 } });
      expect(result).toEqual({ ok: true });
    });

    it("should fail for unknown entity", () => {
      const result = validateEntityPayload({ schema, entityName: "Unknown", payload: {} });
      expect(result).toEqual({ ok: false, reason: expect.stringContaining("未知实体") });
    });

    it("should fail for non-object payload", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: "not an object" });
      expect(result).toEqual({ ok: false, reason: "payload 必须是对象" });
    });

    it("should fail for missing required field", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: { priority: 1 } });
      expect(result).toEqual({ ok: false, reason: expect.stringContaining("title") });
    });

    it("should fail for wrong type: string field with number", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: { title: 123 } });
      expect(result).toEqual({ ok: false, reason: expect.stringContaining("类型错误") });
    });

    it("should fail for wrong type: number field with string", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: { title: "ok", priority: "high" } });
      expect(result).toEqual({ ok: false, reason: expect.stringContaining("类型错误") });
    });

    it("should pass null/undefined values for non-required fields", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: { title: "ok", priority: null } });
      expect(result).toEqual({ ok: true });
    });

    it("should accept boolean fields", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: { title: "ok", done: true } });
      expect(result).toEqual({ ok: true });
    });

    it("should accept json fields with any value", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: { title: "ok", meta: { any: "thing" } } });
      expect(result).toEqual({ ok: true });
    });

    it("should accept reference fields with string value", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: { title: "ok", ownerId: "some-uuid" } });
      expect(result).toEqual({ ok: true });
    });

    it("should fail for NaN number", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: { title: "ok", priority: NaN } });
      expect(result).toEqual({ ok: false, reason: expect.stringContaining("类型错误") });
    });

    it("should fail for Infinity number", () => {
      const result = validateEntityPayload({ schema, entityName: "Task", payload: { title: "ok", priority: Infinity } });
      expect(result).toEqual({ ok: false, reason: expect.stringContaining("类型错误") });
    });
  });
});
