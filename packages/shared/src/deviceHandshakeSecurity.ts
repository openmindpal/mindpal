/**
 * Device Handshake Security Protocol (S17)
 * Re-exported from @mindpal/protocol - the single source of truth.
 *
 * Additional runtime crypto functions (generateNonce, validateNonce, generateECDHKeyPair,
 * deriveSessionKeys, signHandshake, verifyHandshake, createSecureMessage, decryptSecureMessage,
 * checkReplay, isSessionExpired, shouldRotateKey) remain here as they depend on Node.js crypto.
 */

// Re-export protocol-layer types and constants
export {
  DEFAULT_SECURITY_POLICY,
} from '@mindpal/protocol';

export type {
  DeviceSecurityPolicy,
  HandshakeSecurityExt,
  HandshakeAckSecurityExt,
  SecureDeviceMessage,
} from '@mindpal/protocol';

// ── Runtime DeviceSessionState with Buffer types (more specific than protocol's unknown) ──

import type { DeviceSecurityPolicy } from '@mindpal/protocol';

export interface DeviceSessionState {
  sessionId: string;
  deviceId: string;
  tenantId: string;
  authLevel: DeviceSecurityPolicy["authLevel"];
  sessionKey: Buffer;     // AES-256 密钥（ECDH 派生）
  hmacKey: Buffer;        // HMAC 密钥（ECDH 派生）
  messageCounter: number;
  replayWindow: Set<number>;
  createdAt: number;
  expiresAt: number;
}

// ── Runtime crypto functions (depend on Node.js crypto) ──

import * as crypto from "node:crypto";
import { DEFAULT_SECURITY_POLICY } from '@mindpal/protocol';
import type { SecureDeviceMessage } from '@mindpal/protocol';

// ── Nonce ────────────────────────────────────────────────────

/** 生成 32 字节 hex 随机数 */
export function generateNonce(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** 校验 nonce 格式 + 时间戳在窗口内 */
export function validateNonce(
  nonce: string,
  timestamp: number,
  maxAgeMs = 30_000,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(nonce)) return false;
  const age = Math.abs(Date.now() - timestamp);
  return age <= maxAgeMs;
}

// ── ECDH 密钥交换 ───────────────────────────────────────────

/** 生成 P-256 ECDH 密钥对（base64 编码） */
export function generateECDHKeyPair(): { publicKey: string; privateKey: string } {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64"),
    privateKey: ecdh.getPrivateKey().toString("base64"),
  };
}

/** ECDH 共享密钥 → HKDF-SHA256 派生 sessionKey + hmacKey */
export function deriveSessionKeys(
  myPrivateKey: string,
  peerPublicKey: string,
  salt: string,
): { sessionKey: Buffer; hmacKey: Buffer } {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(myPrivateKey, "base64"));
  const sharedSecret = ecdh.computeSecret(Buffer.from(peerPublicKey, "base64"));
  const derived = crypto.hkdfSync(
    "sha256",
    sharedSecret,
    Buffer.from(salt, "utf8"),
    "mindpal-device-session",
    64,
  );
  const buf = Buffer.from(derived);
  return {
    sessionKey: buf.subarray(0, 32),
    hmacKey: buf.subarray(32, 64),
  };
}

// ── HMAC 签名 / 验证 ───────────────────────────────────────

/** 递归排序对象键，确保序列化确定性 */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val) && !Buffer.isBuffer(val)) {
      sorted[key] = sortKeys(val as Record<string, unknown>);
    } else {
      sorted[key] = val;
    }
  }
  return sorted;
}

/** 对握手数据计算 HMAC-SHA256（hex） */
export function signHandshake(data: Record<string, unknown>, key: string): string {
  const payload = JSON.stringify(sortKeys(data));
  return crypto.createHmac("sha256", key).update(payload).digest("hex");
}

/** 验证握手 HMAC（timingSafeEqual 防时序攻击） */
export function verifyHandshake(
  data: Record<string, unknown>,
  hmac: string,
  key: string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(hmac)) return false;
  const expected = signHandshake(data, key);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmac, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
}

// ── 安全消息（AES-256-GCM） ──

/** 加密并包装安全消息 */
export function createSecureMessage(
  payload: Record<string, unknown>,
  session: DeviceSessionState,
): SecureDeviceMessage {
  const seq = ++session.messageCounter;
  const ts = Date.now();

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", session.sessionKey, iv);
  const plainBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();

  const enc = ct.toString("base64");
  const ivB64 = iv.toString("base64");
  const tagB64 = tag.toString("base64");

  const hmacPayload = `${seq}:${ts}:${enc}`;
  const hmac = crypto.createHmac("sha256", session.hmacKey).update(hmacPayload).digest("hex");

  return {
    type: "secure.message",
    sessionId: session.sessionId,
    seq,
    ts,
    enc,
    iv: ivB64,
    tag: tagB64,
    hmac,
  };
}

/** 解密安全消息，验证失败返回 null */
export function decryptSecureMessage(
  msg: SecureDeviceMessage,
  session: DeviceSessionState,
): Record<string, unknown> | null {
  if (!checkReplay(msg.seq, session)) return null;

  const hmacPayload = `${msg.seq}:${msg.ts}:${msg.enc}`;
  const expected = crypto.createHmac("sha256", session.hmacKey).update(hmacPayload).digest("hex");
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(msg.hmac, "hex"),
      Buffer.from(expected, "hex"),
    );
    if (!valid) return null;
  } catch {
    return null;
  }

  try {
    const iv = Buffer.from(msg.iv, "base64");
    const tag = Buffer.from(msg.tag, "base64");
    const ct = Buffer.from(msg.enc, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", session.sessionKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}

// ── 重放检测 ────────────────────────────────────────────────

/** 检查并记录消息序号，返回 true = 合法（非重放） */
export function checkReplay(seq: number, session: DeviceSessionState): boolean {
  if (session.replayWindow.has(seq)) return false;
  session.replayWindow.add(seq);
  if (session.replayWindow.size > (DEFAULT_SECURITY_POLICY.replayWindowSize * 2)) {
    const entries = Array.from(session.replayWindow).sort((a, b) => a - b);
    const trimCount = entries.length - DEFAULT_SECURITY_POLICY.replayWindowSize;
    for (let i = 0; i < trimCount; i++) {
      session.replayWindow.delete(entries[i]);
    }
  }
  return true;
}

// ── 会话工具 ────────────────────────────────────────────────

/** 会话是否已过期 */
export function isSessionExpired(session: DeviceSessionState): boolean {
  return Date.now() >= session.expiresAt;
}

/** 是否需要轮换密钥 */
export function shouldRotateKey(
  session: DeviceSessionState,
  policy: DeviceSecurityPolicy,
): boolean {
  const elapsed = Date.now() - session.createdAt;
  return elapsed >= policy.keyRotationIntervalMs;
}
