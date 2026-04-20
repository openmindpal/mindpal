import { describe, it, expect } from "vitest";
import { ensureSchemaI18nFallback } from "../i18n";
import { buildEffectiveEntitySchema } from "../effectiveSchema";
import type { PolicyDecision } from "@openslin/shared";

/* ── i18n ── */
describe("metadata/i18n", () => {
  describe("ensureSchemaI18nFallback", () => {
    it("should fill zh-CN from first value when missing", () => {
      const schema: any = {
        displayName: { "en-US": "CRM" },
        description: { "en-US": "Customer management" },
        entities: {
          Contact: {
            displayName: { "en-US": "Contact" },
            description: { "en-US": "A contact" },
            fields: {
              name: {
                displayName: { "en-US": "Name" },
                description: { "en-US": "Full name" },
              },
            },
          },
        },
      };
      const result = ensureSchemaI18nFallback(schema);
      expect(result.displayName!["zh-CN"]).toBe("CRM");
      expect(result.description!["zh-CN"]).toBe("Customer management");
      expect(result.entities!.Contact.displayName!["zh-CN"]).toBe("Contact");
      expect(result.entities!.Contact.fields!.name.displayName!["zh-CN"]).toBe("Name");
    });

    it("should not overwrite existing zh-CN", () => {
      const schema: any = {
        displayName: { "en-US": "CRM", "zh-CN": "客户管理" },
        entities: {},
      };
      const result = ensureSchemaI18nFallback(schema);
      expect(result.displayName!["zh-CN"]).toBe("客户管理");
    });

    it("should handle undefined displayName/description gracefully", () => {
      const schema: any = { entities: { A: { fields: { f: {} } } } };
      expect(() => ensureSchemaI18nFallback(schema)).not.toThrow();
    });

    it("should handle empty schema", () => {
      const schema: any = {};
      expect(() => ensureSchemaI18nFallback(schema)).not.toThrow();
    });
  });
});

/* ── effectiveSchema ── */
describe("metadata/effectiveSchema", () => {
  const schema: any = {
    name: "test-schema",
    version: "1.0",
    entities: {
      Task: {
        displayName: { "zh-CN": "任务" },
        description: { "zh-CN": "任务实体" },
        fields: {
          title: { type: "string", required: true },
          secret: { type: "string" },
          priority: { type: "number" },
          status: { type: "string" },
        },
      },
    },
  };

  describe("buildEffectiveEntitySchema", () => {
    it("should return null for unknown entity", () => {
      const decision: PolicyDecision = { decision: "allow" };
      expect(buildEffectiveEntitySchema({ schema, entityName: "Unknown", decision })).toBeNull();
    });

    it("should include all fields when no rules", () => {
      const decision: PolicyDecision = { decision: "allow" };
      const result = buildEffectiveEntitySchema({ schema, entityName: "Task", decision });
      expect(Object.keys(result!.fields)).toEqual(["title", "secret", "priority", "status"]);
    });

    it("should exclude read-denied fields", () => {
      const decision: PolicyDecision = { decision: "allow", fieldRules: { read: { deny: ["secret"] } } };
      const result = buildEffectiveEntitySchema({ schema, entityName: "Task", decision });
      expect(result!.fields).not.toHaveProperty("secret");
      expect(result!.fields).toHaveProperty("title");
    });

    it("should only include read-allowed fields", () => {
      const decision: PolicyDecision = { decision: "allow", fieldRules: { read: { allow: ["title", "priority"] } } };
      const result = buildEffectiveEntitySchema({ schema, entityName: "Task", decision });
      expect(Object.keys(result!.fields)).toEqual(["title", "priority"]);
    });

    it("should mark write-denied fields as not writable", () => {
      const decision: PolicyDecision = { decision: "allow", fieldRules: { write: { deny: ["priority"] } } };
      const result = buildEffectiveEntitySchema({ schema, entityName: "Task", decision });
      expect((result!.fields.priority as any).extensions["io.openslin.access"].writable).toBe(false);
      expect((result!.fields.title as any).extensions["io.openslin.access"].writable).toBe(true);
    });

    it("should support write allow list", () => {
      const decision: PolicyDecision = { decision: "allow", fieldRules: { write: { allow: ["title"] } } };
      const result = buildEffectiveEntitySchema({ schema, entityName: "Task", decision });
      expect((result!.fields.title as any).extensions["io.openslin.access"].writable).toBe(true);
      expect((result!.fields.secret as any).extensions["io.openslin.access"].writable).toBe(false);
    });

    it("should mark all writable with wildcard", () => {
      const decision: PolicyDecision = { decision: "allow", fieldRules: { write: { allow: ["*"] } } };
      const result = buildEffectiveEntitySchema({ schema, entityName: "Task", decision });
      for (const f of Object.values(result!.fields)) {
        expect((f as any).extensions["io.openslin.access"].writable).toBe(true);
      }
    });

    it("should include conditional access annotations", () => {
      const decision: PolicyDecision = {
        decision: "allow",
        conditionalFieldRules: [
          { condition: { op: "eq", field: "role", value: "admin" }, fieldRules: { read: { deny: ["secret"] } } },
        ],
      };
      const result = buildEffectiveEntitySchema({ schema, entityName: "Task", decision });
      // secret field should have conditionalAccess because the conditional rule denies it
      expect((result!.fields.secret as any).extensions["io.openslin.access"].conditionalAccess).toBeDefined();
      expect((result!.fields.secret as any).extensions["io.openslin.access"].conditionalAccess[0].readable).toBe(false);
    });

    it("should return schema metadata", () => {
      const decision: PolicyDecision = { decision: "allow" };
      const result = buildEffectiveEntitySchema({ schema, entityName: "Task", decision });
      expect(result!.schemaName).toBe("test-schema");
      expect(result!.schemaVersion).toBe("1.0");
      expect(result!.entityName).toBe("Task");
    });
  });
});
