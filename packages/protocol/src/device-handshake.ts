/**
 * deviceHandshakeSecurity — 设备握手安全协议类型定义
 *
 * 为设备代理 ↔ 服务端提供 V2 安全增强握手的协议层类型：
 * - 安全策略类型（元数据驱动）
 * - 握手安全扩展类型
 * - 会话类型
 * - 安全消息包装类型
 *
 * 注意：加密/签名/解密等运行时函数依赖 Node.js crypto 模块，
 * 不包含在协议层中。请使用 @mindpal/shared/deviceHandshakeSecurity 获取完整实现。
 */

import { createRegistry, builtInEntry, type RegistryEntry } from './registry.js';

// ── 安全策略类型（元数据驱动） ──────────────────────────────

/** authLevel 注册表 */
export type AuthLevel = string;

export const BUILTIN_AUTH_LEVELS: RegistryEntry[] = [
  builtInEntry('token', 'device.auth'),
  builtInEntry('token+ecdh', 'device.auth'),
  builtInEntry('cert+ecdh', 'device.auth'),
];

export const authLevelRegistry = createRegistry(BUILTIN_AUTH_LEVELS);

/** 服务端下发的安全策略（元数据驱动，类似 multimodalPolicy） */
export interface DeviceSecurityPolicy {
  format: "deviceSecurity.v1";
  authLevel: string;
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

/**
 * 设备会话状态接口（协议层定义）。
 *
 * 注意：运行时实现中 sessionKey/hmacKey 为 Buffer，replayWindow 为 Set<number>。
 * 协议层使用宽松类型以保持零 Node.js 依赖。
 */
export interface DeviceSessionState {
  sessionId: string;
  deviceId: string;
  tenantId: string;
  authLevel: string;
  sessionKey: unknown;     // 运行时为 Buffer（AES-256 密钥）
  hmacKey: unknown;        // 运行时为 Buffer（HMAC 密钥）
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

// ── 安全策略模板库 ────────────────────────────────────────

export interface SecurityPolicyProfile {
  name: string;
  policy: DeviceSecurityPolicy;
  description?: string;
  appliesTo?: string[];  // 适用的设备类型
}

export const BUILTIN_SECURITY_PROFILES: RegistryEntry<SecurityPolicyProfile>[] = [
  builtInEntry('default', 'device.security_profile', {
    name: 'default',
    policy: DEFAULT_SECURITY_POLICY,
    description: 'Default security policy for general devices',
  }),
];

export const securityProfileRegistry = createRegistry<SecurityPolicyProfile>(BUILTIN_SECURITY_PROFILES);
