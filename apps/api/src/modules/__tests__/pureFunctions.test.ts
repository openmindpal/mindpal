import { describe, it, expect } from "vitest";
import { channelConversationId } from "../../skills/channel-gateway/modules/conversationId";
import { newOAuthStateValue } from "../oauth/oauthStateRepo";
import { validateConnectorConfig } from "../connectors/connectorConfigRepo";
import { toSessionContextListItem, type SessionContextListRow } from "../memory/sessionContextRepo";

/* ── channelConversationId ── */
describe("channels/conversationId", () => {
  it("should produce a deterministic ID for the same input", () => {
    const params = { provider: "slack", workspaceId: "ws1", channelChatId: "ch1" };
    const id1 = channelConversationId(params);
    const id2 = channelConversationId(params);
    expect(id1).toBe(id2);
  });

  it("should include provider prefix", () => {
    const id = channelConversationId({ provider: "slack", workspaceId: "ws1", channelChatId: "ch1" });
    expect(id).toMatch(/^ch:slack:/);
  });

  it("should sanitize special chars in provider", () => {
    const id = channelConversationId({ provider: "ms:teams/v2", workspaceId: "ws", channelChatId: "c" });
    // Format is ch:PROVIDER:HASH — colons and slashes in provider name are replaced with underscores
    const parts = id.split(":");
    expect(parts[0]).toBe("ch");
    expect(parts[1]).toBe("ms_teams_v2");
    expect(parts[1]).not.toMatch(/[:/]/);
  });

  it("should include threadId in hash when provided", () => {
    const base = channelConversationId({ provider: "slack", workspaceId: "ws", channelChatId: "ch" });
    const withThread = channelConversationId({ provider: "slack", workspaceId: "ws", channelChatId: "ch", threadId: "t1" });
    expect(base).not.toBe(withThread);
  });

  it("should treat null threadId same as no threadId", () => {
    const a = channelConversationId({ provider: "p", workspaceId: "w", channelChatId: "c", threadId: null });
    const b = channelConversationId({ provider: "p", workspaceId: "w", channelChatId: "c" });
    expect(a).toBe(b);
  });

  it("should produce hash of expected length (24 hex chars)", () => {
    const id = channelConversationId({ provider: "p", workspaceId: "w", channelChatId: "c" });
    const hash = id.split(":").pop()!;
    expect(hash).toHaveLength(24);
  });
});

/* ── newOAuthStateValue ── */
describe("oauth/oauthStateRepo", () => {
  describe("newOAuthStateValue", () => {
    it("should return a non-empty base64url string", () => {
      const value = newOAuthStateValue();
      expect(value.length).toBeGreaterThan(0);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("should produce unique values each call", () => {
      const values = new Set(Array.from({ length: 20 }, () => newOAuthStateValue()));
      expect(values.size).toBe(20);
    });
  });
});

/* ── validateConnectorConfig ── */
describe("connectors/connectorConfigRepo", () => {
  describe("validateConnectorConfig", () => {
    it("should pass when all required fields present", () => {
      const config = { host: "smtp.example.com", port: 465, username: "u" };
      const schema = { required: ["host", "port"] };
      expect(validateConnectorConfig(config, schema)).toEqual({ ok: true });
    });

    it("should fail when a required field is missing", () => {
      const config = { host: "smtp.example.com" };
      const schema = { required: ["host", "port"] };
      const result = validateConnectorConfig(config, schema);
      expect(result.ok).toBe(false);
      expect((result as any).reason).toContain("port");
    });

    it("should fail when a required field is null", () => {
      const config = { host: null, port: 465 };
      const schema = { required: ["host"] };
      const result = validateConnectorConfig(config as any, schema);
      expect(result.ok).toBe(false);
    });

    it("should pass when no required fields in schema", () => {
      const config = {};
      const schema = { properties: { host: { type: "string" } } };
      expect(validateConnectorConfig(config, schema)).toEqual({ ok: true });
    });

    it("should pass when required is not an array", () => {
      const config = {};
      const schema = { required: "not-an-array" };
      expect(validateConnectorConfig(config, schema as any)).toEqual({ ok: true });
    });
  });
});

/* ── toSessionContextListItem ── */
describe("memory/sessionContextRepo", () => {
  describe("toSessionContextListItem", () => {
    it("should compute messageCount and preview from messages", () => {
      const row: SessionContextListRow = {
        sessionId: "s1",
        context: { v: 2, messages: [{ role: "user", content: "Hello there" }, { role: "assistant", content: "Hi!" }] },
        expiresAt: null,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      };
      const item = toSessionContextListItem(row);
      expect(item.sessionId).toBe("s1");
      expect(item.retainedMessageCount).toBe(2);
      expect(item.messageCount).toBe(2);
      expect(item.isTrimmed).toBe(false);
      expect(item.preview).toBe("Hello there");
    });

    it("should detect trimmed conversations via totalTurnCount", () => {
      const row: SessionContextListRow = {
        sessionId: "s2",
        context: {
          v: 2,
          messages: [{ role: "user", content: "Latest msg" }],
          totalTurnCount: 50,
          summary: "Earlier discussion about project planning",
        },
        expiresAt: null,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      };
      const item = toSessionContextListItem(row);
      expect(item.isTrimmed).toBe(true);
      expect(item.messageCount).toBe(50);
      expect(item.retainedMessageCount).toBe(1);
      // When trimmed, preview should prefer summary
      expect(item.preview).toContain("project planning");
    });

    it("should handle empty messages", () => {
      const row: SessionContextListRow = {
        sessionId: "s3",
        context: { v: 2, messages: [] },
        expiresAt: null,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      };
      const item = toSessionContextListItem(row);
      expect(item.retainedMessageCount).toBe(0);
      expect(item.preview).toBe("");
    });
  });
});
