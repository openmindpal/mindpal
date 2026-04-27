/**
 * deviceHandshakeSecurity — 设备握手安全共享模块
 *
 * 为设备代理 ↔ 服务端提供 V2 安全增强握手能力：
 * - ECDH P-256 密钥交换 → HKDF-SHA256 会话密钥派生
 * - AES-256-GCM 端到端加密（复用 columnEncryption 模式）
 * - HMAC-SHA256 签名 / 验证（复用 pluginSandbox timingSafeEqual 模式）
 * - 序号 + 滑动窗口防重放
 * - 元数据驱动安全策略（服务端通过握手ACK下发）
 *
 * 设计要点：
 * 1. 零新依赖，全部 Node.js 原生 crypto
 * 2. 向后兼容：V1 握手不变，V2 为安全扩展
 * 3. 轻量化单文件，最小化类型定义
 */
import * as crypto from "node:crypto";

// ── 安全策略类型（元数据驱动） ──────────────────────────────

/** 服务端下发的安全策略（元数据驱动，类似 multimodalPolicy） */
export interface DeviceSecurityPolicy {
  format: "deviceSecurity.v1";
  authLevel: "token" | "token+ecdh" | "cert+ecdh";
  requireNonce: boolean;
  sessionTtlMs: number;
  keyRotationIntervalMs: number;
  replayWindowSize: number;
}

export const DEFAULT_SECURITY_POLICY: DeviceSecurityPolicy = {
  format: "deviceSecurity.v1",
  authLevel: "token+ecdh",
  requireNonce: true,
  sessionTtlMs: 3_600_000,          // 1 小时
  keyRotationIntervalMs: 1_800_000,  // 30 分钟
  replayWindowSize: 256,
};

// ── 握手安全扩展类型 ────────────────────────────────────────

/** 设备端握手安全扩展（附加在现有 handshake 上） */
export interface HandshakeSecurityExt {
  nonce: string;              // 32 字节 hex 随机数
  timestamp: number;          // Unix 毫秒
  ephemeralPubKey?: string;   // ECDH P-256 公钥（base64）
  deviceCert?: string;        // PEM 证书（可选，cert+ecdh 级别）
  hmac: string;               // 对整个握手的 HMAC-SHA256
}

/** 服务端 ACK 安全扩展 */
export interface HandshakeAckSecurityExt {
  sessionId: string;
  serverNonce: string;
  serverEphemeralPubKey?: string;
  securityPolicy: DeviceSecurityPolicy;
  tokenRefreshAt?: number;    // Token 轮换时间点
  hmac: string;
}

// ── 会话类型 ────────────────────────────────────────────────

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

// ── 安全消息包装类型 ────────────────────────────────────────

export interface SecureDeviceMessage {
  type: "secure.message";
  sessionId: string;
  seq: number;    // 防重放序号
  ts: number;     // 时间戳
  enc: string;    // AES-256-GCM 密文（base64）
  iv: string;     // 12 字节 IV（base64）
  tag: string;    // GCM 认证标签（base64）
  hmac: string;   // 对 seq+ts+enc 的 HMAC-SHA256
}

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

// ── 安全消息（AES-256-GCM，复用 columnEncryption 模式） ──

/** 加密并包装安全消息 */
export function createSecureMessage(
  payload: Record<string, unknown>,
  session: DeviceSessionState,
): SecureDeviceMessage {
  const seq = ++session.messageCounter;
  const ts = Date.now();

  // AES-256-GCM 加密
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", session.sessionKey, iv);
  const plainBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();

  const enc = ct.toString("base64");
  const ivB64 = iv.toString("base64");
  const tagB64 = tag.toString("base64");

  // HMAC 覆盖 seq + ts + enc
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
  // 重放检测
  if (!checkReplay(msg.seq, session)) return null;

  // HMAC 验证
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

  // AES-256-GCM 解密
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
  // 超过窗口大小时清理最旧的条目
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
