/**
 * 端侧本地 Skill 清单定义（与云端 manifest.json 格式对齐）
 * @layer localSkill
 */
import * as crypto from "node:crypto";

/** 本地 Skill manifest 类型，与云端 skills/[name]/manifest.json 结构一致 */
export interface DeviceSkillManifest {
  identity: { name: string; version: string };
  displayName?: Record<string, string>;
  description?: Record<string, string>;
  category?: string;
  tags?: string[];
  contract: {
    scope: string;
    resourceType: string;
    action: string;
    riskLevel: "low" | "medium" | "high" | "critical";
    idempotencyRequired?: boolean;
    approvalRequired?: boolean;
  };
  io: {
    inputSchema?: { fields: Record<string, { type: string; required?: boolean }> };
    outputSchema?: { fields: Record<string, { type: string; required?: boolean }> };
  };
  engines?: Record<string, string>;
  /** 相对路径，如 "dist/index.js" */
  entry: string;
  /** HMAC-SHA256 签名（可选，渐进式安全） */
  signature?: string;
  /** 隔离级别，默认 "process" */
  isolation?: "process" | "vm" | "none";
}

/** Manifest 校验结果 */
export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

/** 校验 manifest 结构完整性 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["manifest must be a non-null object"] };
  }
  const m = raw as Record<string, unknown>;

  // identity
  const identity = m.identity as Record<string, unknown> | undefined;
  if (!identity || typeof identity !== "object") {
    errors.push("identity is required and must be an object");
  } else {
    if (typeof identity.name !== "string" || !identity.name) {
      errors.push("identity.name is required and must be a non-empty string");
    }
    if (typeof identity.version !== "string" || !identity.version) {
      errors.push("identity.version is required and must be a non-empty string");
    }
  }

  // contract
  const contract = m.contract as Record<string, unknown> | undefined;
  if (!contract || typeof contract !== "object") {
    errors.push("contract is required and must be an object");
  } else if (typeof contract.riskLevel !== "string" || !VALID_RISK_LEVELS.has(contract.riskLevel)) {
    errors.push(`contract.riskLevel must be one of: ${[...VALID_RISK_LEVELS].join(", ")}`);
  }

  // entry
  if (typeof m.entry !== "string" || !m.entry) {
    errors.push("entry is required and must be a non-empty string");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * manifest 签名校验（HMAC-SHA256，与 pluginSandbox.ts 对齐）
 * 对 `${identity.name}@${identity.version}:${entry}` 做 HMAC-SHA256
 */
export function verifyManifestSignature(
  manifest: DeviceSkillManifest,
  secretKey: string,
): { valid: boolean; reason?: string } {
  if (!manifest.signature) {
    return { valid: false, reason: "missing_signature" };
  }

  // 校验 hex 格式（SHA256 = 64 hex chars）
  if (!/^[0-9a-f]{64}$/i.test(manifest.signature)) {
    return { valid: false, reason: "invalid_signature_format" };
  }

  const payload = `${manifest.identity.name}@${manifest.identity.version}:${manifest.entry}`;
  const expected = crypto
    .createHmac("sha256", secretKey)
    .update(payload)
    .digest("hex");

  // 使用 timingSafeEqual 防时序攻击
  const valid = crypto.timingSafeEqual(
    Buffer.from(manifest.signature, "hex"),
    Buffer.from(expected, "hex"),
  );

  return valid ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}
