import { describe, it, expect } from "vitest";
import { encryptJson, decryptJson, type EncryptedPayload } from "../crypto";

const TEST_KEY = "test-master-key-for-aes-256-gcm";

describe("secrets/crypto", () => {
  describe("encryptJson + decryptJson roundtrip", () => {
    it("should roundtrip a simple object", () => {
      const payload = { user: "alice", token: "secret-123" };
      const encrypted = encryptJson(TEST_KEY, payload);
      expect(encrypted.alg).toBe("A256GCM");
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.tag).toBeTruthy();
      expect(encrypted.ct).toBeTruthy();
      const decrypted = decryptJson(TEST_KEY, encrypted);
      expect(decrypted).toEqual(payload);
    });

    it("should roundtrip a string payload", () => {
      const payload = "hello world";
      const encrypted = encryptJson(TEST_KEY, payload);
      const decrypted = decryptJson(TEST_KEY, encrypted);
      expect(decrypted).toBe(payload);
    });

    it("should roundtrip a number payload", () => {
      const encrypted = encryptJson(TEST_KEY, 42);
      expect(decryptJson(TEST_KEY, encrypted)).toBe(42);
    });

    it("should roundtrip a boolean payload", () => {
      const encrypted = encryptJson(TEST_KEY, true);
      expect(decryptJson(TEST_KEY, encrypted)).toBe(true);
    });

    it("should roundtrip null → empty object (null coalesced to {})", () => {
      const encrypted = encryptJson(TEST_KEY, null);
      expect(decryptJson(TEST_KEY, encrypted)).toEqual({});
    });

    it("should roundtrip undefined → empty object", () => {
      const encrypted = encryptJson(TEST_KEY, undefined);
      expect(decryptJson(TEST_KEY, encrypted)).toEqual({});
    });

    it("should roundtrip an array payload", () => {
      const payload = [1, "two", { three: 3 }];
      const encrypted = encryptJson(TEST_KEY, payload);
      expect(decryptJson(TEST_KEY, encrypted)).toEqual(payload);
    });

    it("should roundtrip a nested object", () => {
      const payload = { a: { b: { c: [1, 2, 3] } } };
      const encrypted = encryptJson(TEST_KEY, payload);
      expect(decryptJson(TEST_KEY, encrypted)).toEqual(payload);
    });

    it("should roundtrip Unicode content", () => {
      const payload = { name: "灵智MindPal", desc: "智能体系统" };
      const encrypted = encryptJson(TEST_KEY, payload);
      expect(decryptJson(TEST_KEY, encrypted)).toEqual(payload);
    });
  });

  describe("encryptJson output format", () => {
    it("should produce base64-encoded iv, tag, ct", () => {
      const encrypted = encryptJson(TEST_KEY, { k: "v" });
      // base64 regex: only base64 chars
      const b64 = /^[A-Za-z0-9+/=]+$/;
      expect(encrypted.iv).toMatch(b64);
      expect(encrypted.tag).toMatch(b64);
      expect(encrypted.ct).toMatch(b64);
    });

    it("should produce unique IVs for each call", () => {
      const e1 = encryptJson(TEST_KEY, { a: 1 });
      const e2 = encryptJson(TEST_KEY, { a: 1 });
      expect(e1.iv).not.toBe(e2.iv);
    });
  });

  describe("decryptJson with wrong key", () => {
    it("should throw on wrong key", () => {
      const encrypted = encryptJson(TEST_KEY, { secret: "data" });
      expect(() => decryptJson("wrong-key-xxx", encrypted)).toThrow();
    });

    it("should throw on tampered ciphertext", () => {
      const encrypted = encryptJson(TEST_KEY, { secret: "data" });
      const tampered: EncryptedPayload = { ...encrypted, ct: "dGFtcGVyZWQ=" };
      expect(() => decryptJson(TEST_KEY, tampered)).toThrow();
    });

    it("should throw on tampered tag", () => {
      const encrypted = encryptJson(TEST_KEY, { secret: "data" });
      const tampered: EncryptedPayload = { ...encrypted, tag: "AAAAAAAAAAAAAAAAAAAAAA==" };
      expect(() => decryptJson(TEST_KEY, tampered)).toThrow();
    });
  });
});
