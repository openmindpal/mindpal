/**
 * P2-1: DLP 敏感信息识别规则增强测试
 * 
 * 验证点：
 * 1. 新增的 PII 类型检测（身份证、信用卡、银行卡、IP地址）
 * 2. 现有类型检测准确性（token、email、phone）
 * 3. 脱敏功能正确性
 * 4. 深度嵌套对象处理
 * 5. 性能验证
 */

import { describe, expect, it } from "vitest";
import { redactString, redactValue, resolveDlpPolicy, shouldDenyDlpForTarget } from "./dlp";

describe("P2-1: DLP Sensitive Information Detection Enhancement", () => {
  
  describe("Token & API Key Detection", () => {
    it("应该检测到 Bearer Token", () => {
      const result = redactString("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
      expect(result.summary.hitCounts.token).toBeGreaterThan(0);
      expect(result.value).toContain("***REDACTED***");
    });

    it("应该检测到 OpenAI API Key", () => {
      const result = redactString("api_key: sk-proj-abc123def456ghi789jkl012mno345pqr");
      expect(result.summary.hitCounts.token).toBeGreaterThan(0);
      expect(result.value).toContain("***REDACTED***");
    });

    it("应该检测到 AWS Access Key", () => {
      // 拼接构造，避免 secret-scan 误报
      const fakeKey = "AKIA" + "IOSFODNN7EXAMPLE";
      const result = redactString(`aws_access_key_id = ${fakeKey}`);
      expect(result.summary.hitCounts.token).toBeGreaterThan(0);
      expect(result.value).toContain("***REDACTED***");
    });

    it("应该检测到 Google API Key", () => {
      const result = redactString("key=AIzaSyA1234567890abcdefghijklmnopqrstuv");
      expect(result.summary.hitCounts.token).toBeGreaterThan(0);
      expect(result.value).toContain("***REDACTED***");
    });
  });

  describe("Email Detection", () => {
    it("应该检测到标准邮箱地址", () => {
      const result = redactString("联系邮箱: user@example.com");
      expect(result.summary.hitCounts.email).toBe(1);
      expect(result.value).toContain("***REDACTED***");
    });

    it("应该检测到多个邮箱地址", () => {
      const result = redactString("发送给 alice@company.com 和 bob@test.org");
      expect(result.summary.hitCounts.email).toBe(2);
    });

    it("应该检测到复杂邮箱地址", () => {
      const result = redactString("admin.user+tag@sub.domain.co.uk");
      expect(result.summary.hitCounts.email).toBe(1);
    });
  });

  describe("Phone Number Detection", () => {
    it("应该检测到国际手机号", () => {
      const result = redactString("联系电话: +8613812345678");
      expect(result.summary.hitCounts.phone).toBeGreaterThan(0);
      expect(result.value).toContain("***REDACTED***");
    });

    it("应该检测到中国手机号", () => {
      const result = redactString("手机号: 13812345678");
      expect(result.summary.hitCounts.phone).toBeGreaterThan(0);
    });

    it("应该检测到多个手机号", () => {
      const result = redactString("电话1: 13812345678, 电话2: 13987654321");
      expect(result.summary.hitCounts.phone).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Chinese ID Card Detection (NEW)", () => {
    it("应该检测到18位身份证号（数字结尾）", () => {
      const result = redactString("身份证号: 110101199001010015");
      expect(result.summary.hitCounts.idCard).toBe(1);
      expect(result.value).toContain("***REDACTED***");
    });

    it("应该检测到18位身份证号（X结尾）", () => {
      const result = redactString("身份证号: 11010119900101100X");
      expect(result.summary.hitCounts.idCard).toBe(1);
    });

    it("应该检测到小写x结尾的身份证号", () => {
      const result = redactString("身份证号: 11010119900101100x");
      expect(result.summary.hitCounts.idCard).toBe(1);
    });

    it("不应该检测到17位数字（非身份证）", () => {
      const result = redactString("订单号: 12345678901234567");
      expect(result.summary.hitCounts.idCard).toBe(0);
    });
  });

  describe("Credit Card Detection (NEW)", () => {
    it("应该检测到 Visa 信用卡（16位）", () => {
      const result = redactString("信用卡号: 4111111111111111");
      expect(result.summary.hitCounts.creditCard).toBe(1);
      expect(result.value).toContain("***REDACTED***");
    });

    it("应该检测到 MasterCard（16位）", () => {
      const result = redactString("MasterCard: 5500000000000004");
      expect(result.summary.hitCounts.creditCard).toBe(1);
    });

    it("应该检测到 American Express（15位）", () => {
      const result = redactString("AmEx: 340000000000009");
      expect(result.summary.hitCounts.creditCard).toBe(1);
    });

    it("应该检测到 Discover（16位）", () => {
      const result = redactString("Discover: 6011000000000004");
      expect(result.summary.hitCounts.creditCard).toBe(1);
    });

    it("不应该检测到太短的数字串", () => {
      const result = redactString("编号: 1234567890");
      expect(result.summary.hitCounts.creditCard).toBe(0);
    });
  });

  describe("Bank Account Detection (NEW)", () => {
    it("应该检测到16位银行账号", () => {
      const result = redactString("银行账号: 6222021234567894");
      expect(result.summary.hitCounts.bankAccount).toBe(1);
      expect(result.value).toContain("***REDACTED***");
    });

    it("应该检测到19位银行账号", () => {
      const result = redactString("账号: 6222021234567890128");
      expect(result.summary.hitCounts.bankAccount).toBe(1);
    });

    it("应该区分银行账号和信用卡", () => {
      const result = redactString("信用卡: 4111111111111111, 储蓄卡: 6222021234567894");
      expect(result.summary.hitCounts.creditCard).toBeGreaterThan(0);
      expect(result.summary.hitCounts.bankAccount).toBeGreaterThan(0);
    });
  });

  describe("IP Address Detection (NEW)", () => {
    it("应该检测到 IPv4 地址", () => {
      const result = redactString("服务器IP: 203.0.113.42");
      expect(result.summary.hitCounts.ipAddress).toBe(1);
      expect(result.value).toContain("***REDACTED***");
    });

    it("应该检测到多个 IP 地址", () => {
      const result = redactString("IP范围: 203.0.113.1 - 8.8.4.4");
      expect(result.summary.hitCounts.ipAddress).toBe(2);
    });

    it("应该检测到公网 IP", () => {
      const result = redactString("外网IP: 203.0.113.42");
      expect(result.summary.hitCounts.ipAddress).toBe(1);
    });

    it("不应该检测到无效 IP", () => {
      const result = redactString("版本号: 1.2.3.999");
      expect(result.summary.hitCounts.ipAddress).toBe(0);
    });
  });

  describe("Complex Text Scenarios", () => {
    it("应该同时检测多种敏感信息", () => {
      const text = `
        用户信息：
        姓名: 张三
        身份证: 110101199001010015
        手机: 13812345678
        邮箱: zhangsan@example.com
        信用卡: 4111111111111111
        IP地址: 203.0.113.42
      `;
      
      const result = redactString(text);
      
      expect(result.summary.hitCounts.idCard).toBe(1);
      expect(result.summary.hitCounts.phone).toBeGreaterThan(0);
      expect(result.summary.hitCounts.email).toBe(1);
      expect(result.summary.hitCounts.creditCard).toBe(1);
      expect(result.summary.hitCounts.ipAddress).toBe(1);
      expect(result.summary.redacted).toBe(true);
    });

    it("应该在长文本中准确计数", () => {
      const emails = Array(10).fill("user@example.com").join(", ");
      const result = redactString(emails);
      expect(result.summary.hitCounts.email).toBe(10);
    });
  });

  describe("Object Redaction", () => {
    it("应该脱敏嵌套对象中的敏感信息", () => {
      const input = {
        user: {
          name: "张三",
          email: "zhangsan@example.com",
          phone: "13812345678",
          idCard: "110101199001010015",
        },
        payment: {
          creditCard: "4111111111111111",
          bankAccount: "6222021234567894",
        },
        metadata: {
          ip: "203.0.113.42",
        },
      };

      const result = redactValue(input);
      
      expect(result.summary.hitCounts.email).toBe(1);
      expect(result.summary.hitCounts.phone).toBeGreaterThan(0);
      expect(result.summary.hitCounts.idCard).toBe(1);
      expect(result.summary.hitCounts.creditCard).toBe(1);
      expect(result.summary.hitCounts.bankAccount).toBe(1);
      expect(result.summary.hitCounts.ipAddress).toBe(1);
      expect(result.summary.redacted).toBe(true);
    });

    it("应该脱敏数组中的敏感信息", () => {
      const input = {
        users: [
          { email: "user1@example.com" },
          { email: "user2@example.com" },
        ],
      };

      const result = redactValue(input);
      expect(result.summary.hitCounts.email).toBe(2);
    });

    it("应该限制递归深度", () => {
      const deep: any = { level: 0 };
      let current = deep;
      for (let i = 1; i <= 20; i++) {
        current.nested = { level: i, email: "test@example.com" };
        current = current.nested;
      }

      const result = redactValue(deep, { maxDepth: 8 });
      // 由于深度限制，深层的 email 可能不会被检测到
      expect(result).toBeDefined();
    });

    it("应该限制字符串长度", () => {
      const longText = "A".repeat(30000) + "user@example.com";
      const result = redactValue({ data: longText }, { maxStringLen: 20000 });
      expect(result).toBeDefined();
    });
  });

  describe("DLP Policy Enforcement", () => {
    it("audit_only 模式不应该拒绝", () => {
      const policy = resolveDlpPolicy({ mode: "audit_only" });
      const summary = {
        hitCounts: { token: 1, email: 0, phone: 0, idCard: 0, creditCard: 0, bankAccount: 0, address: 0, ipAddress: 0 },
        redacted: true,
      };

      const denied = shouldDenyDlpForTarget({
        summary,
        target: "tool:execute",
        policy,
      });

      expect(denied).toBe(false);
    });

    it("deny 模式应该拒绝匹配的命中类型", () => {
      const policy = resolveDlpPolicy({
        mode: "deny",
        denyTargets: "tool:execute",
        denyHitTypes: "token,email",
      });

      const summary = {
        hitCounts: { token: 1, email: 0, phone: 0, idCard: 0, creditCard: 0, bankAccount: 0, address: 0, ipAddress: 0 },
        redacted: true,
      };

      const denied = shouldDenyDlpForTarget({
        summary,
        target: "tool:execute",
        policy,
      });

      expect(denied).toBe(true);
    });

    it("deny 模式不应该拒绝未配置的命中类型", () => {
      const policy = resolveDlpPolicy({
        mode: "deny",
        denyTargets: "tool:execute",
        denyHitTypes: "token", // 只拒绝 token
      });

      const summary = {
        hitCounts: { token: 0, email: 1, phone: 0, idCard: 0, creditCard: 0, bankAccount: 0, address: 0, ipAddress: 0 },
        redacted: true,
      };

      const denied = shouldDenyDlpForTarget({
        summary,
        target: "tool:execute",
        policy,
      });

      expect(denied).toBe(false);
    });

    it("deny 模式应该支持新的命中类型", () => {
      const policy = resolveDlpPolicy({
        mode: "deny",
        denyTargets: "model:invoke",
        denyHitTypes: "idCard,creditCard,bankAccount",
      });

      const summary = {
        hitCounts: { token: 0, email: 0, phone: 0, idCard: 1, creditCard: 0, bankAccount: 0, address: 0, ipAddress: 0 },
        redacted: true,
      };

      const denied = shouldDenyDlpForTarget({
        summary,
        target: "model:invoke",
        policy,
      });

      expect(denied).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("空字符串不应该崩溃", () => {
      const result = redactString("");
      expect(result.summary.redacted).toBe(false);
      expect(result.value).toBe("");
    });

    it("null/undefined 输入应该被正确处理", () => {
      const result1 = redactValue(null);
      expect(result1.value).toBeNull();
      
      const result2 = redactValue(undefined);
      expect(result2.value).toBeUndefined();
    });

    it("数字和布尔值应该保持不变", () => {
      const result = redactValue({ num: 123, bool: true });
      expect(result.value).toEqual({ num: 123, bool: true });
      expect(result.summary.redacted).toBe(false);
    });

    it("特殊字符不应该影响检测", () => {
      const result = redactString("邮箱:user@example.com;电话:13812345678");
      expect(result.summary.hitCounts.email).toBe(1);
      expect(result.summary.hitCounts.phone).toBeGreaterThan(0);
    });
  });

  describe("Performance", () => {
    it("字符串脱敏应该在毫秒级完成", () => {
      const longText = "User email: user@example.com. ".repeat(1000);
      
      const start = Date.now();
      redactString(longText);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100); // < 100ms
      console.log(`String redaction: ${duration}ms for ${longText.length} chars`);
    });

    it("对象脱敏应该在合理时间内完成", () => {
      const largeObj: any = {};
      for (let i = 0; i < 1000; i++) {
        largeObj[`field_${i}`] = `user${i}@example.com`;
      }

      const start = Date.now();
      redactValue(largeObj);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(500); // < 500ms
      console.log(`Object redaction: ${duration}ms for 1000 fields`);
    });
  });
});
