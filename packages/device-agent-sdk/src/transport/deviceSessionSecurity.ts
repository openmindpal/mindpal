/**
 * Device Session Security — ECDH 握手、签名/验签、消息加解密
 *
 * 从 websocketClient.ts 拆出，集中管理设备安全会话生命周期。
 */

import { safeLog, safeError } from '../kernel/log';
import {
  type DeviceSecurityPolicy,
  type HandshakeSecurityExt,
  type HandshakeAckSecurityExt,
  type DeviceSessionState,
  type SecureDeviceMessage,
  DEFAULT_SECURITY_POLICY,
  generateNonce,
  generateECDHKeyPair,
  deriveSessionKeys,
  signHandshake,
  verifyHandshake,
  createSecureMessage,
  decryptSecureMessage,
  isSessionExpired,
  shouldRotateKey,
} from '@mindpal/shared';

// ── 类型重导出（供 websocketClient 使用） ──────────────────────

export type {
  DeviceSecurityPolicy,
  HandshakeSecurityExt,
  HandshakeAckSecurityExt,
  DeviceSessionState,
  SecureDeviceMessage,
};

export {
  DEFAULT_SECURITY_POLICY,
  generateNonce,
  generateECDHKeyPair,
  deriveSessionKeys,
  signHandshake,
  verifyHandshake,
  createSecureMessage,
  decryptSecureMessage,
  isSessionExpired,
  shouldRotateKey,
};

// ── 安全会话管理器 ────────────────────────────────────────────

export class DeviceSecuritySession {
  ephemeralPrivateKey: string | null = null;
  deviceSession: DeviceSessionState | null = null;
  securityPolicy: DeviceSecurityPolicy | null = null;
  tokenRefreshTimer: NodeJS.Timeout | null = null;

  /**
   * 构建握手安全扩展（附加到 ProtocolHandshake 上）
   * @returns securityExt 对象，或 null（降级 V1）
   */
  buildSecurityExt(
    handshakeType: string,
    protocolVersion: string,
    deviceToken: string,
  ): HandshakeSecurityExt | null {
    try {
      const keyPair = generateECDHKeyPair();
      this.ephemeralPrivateKey = keyPair.privateKey;

      const nonce = generateNonce();
      const timestamp = Date.now();

      const secExtData: Record<string, unknown> = {
        nonce,
        timestamp,
        ephemeralPubKey: keyPair.publicKey,
      };
      const hmac = signHandshake(
        { ...secExtData, type: handshakeType, protocolVersion },
        deviceToken,
      );

      return { nonce, timestamp, ephemeralPubKey: keyPair.publicKey, hmac };
    } catch (err: any) {
      safeLog(`[DeviceSessionSecurity] V2 安全扩展生成失败，降级 V1: ${err?.message}`);
      this.ephemeralPrivateKey = null;
      return null;
    }
  }

  /**
   * 处理服务端握手 ACK 中的安全扩展，建立安全会话
   */
  handleSecurityAck(
    secExt: HandshakeAckSecurityExt,
    deviceToken: string,
    deviceId: string,
    onReHandshake: () => void,
  ): void {
    try {
      const { hmac, ...dataWithoutHmac } = secExt;
      const hmacValid = verifyHandshake(
        dataWithoutHmac as unknown as Record<string, unknown>,
        hmac,
        deviceToken,
      );
      if (!hmacValid) {
        safeError('[DeviceSessionSecurity] V2 服务端 HMAC 校验失败，降级 V1');
        this.ephemeralPrivateKey = null;
        return;
      }

      if (secExt.serverEphemeralPubKey && this.ephemeralPrivateKey) {
        const salt = `${secExt.sessionId}:${secExt.serverNonce}`;
        const { sessionKey, hmacKey } = deriveSessionKeys(
          this.ephemeralPrivateKey,
          secExt.serverEphemeralPubKey,
          salt,
        );

        const policy = secExt.securityPolicy ?? DEFAULT_SECURITY_POLICY;
        this.securityPolicy = policy;

        this.deviceSession = {
          sessionId: secExt.sessionId,
          deviceId,
          tenantId: '',
          authLevel: policy.authLevel,
          sessionKey,
          hmacKey,
          messageCounter: 0,
          replayWindow: new Set(),
          createdAt: Date.now(),
          expiresAt: Date.now() + policy.sessionTtlMs,
        };

        safeLog(`[DeviceSessionSecurity] V2 安全会话已建立: session=${secExt.sessionId} auth=${policy.authLevel}`);

        if (secExt.tokenRefreshAt) {
          const delay = secExt.tokenRefreshAt - Date.now();
          if (delay > 0) {
            if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = setTimeout(() => {
              safeLog('[DeviceSessionSecurity] Token 轮换时间到达，触发重新握手');
              onReHandshake();
            }, delay);
          }
        }
      } else {
        safeLog('[DeviceSessionSecurity] V2 ACK 缺少 serverEphemeralPubKey，降级 V1');
      }
    } catch (err: any) {
      safeError(`[DeviceSessionSecurity] V2 安全ACK处理失败: ${err?.message}`);
    } finally {
      this.ephemeralPrivateKey = null;
    }
  }

  /**
   * 发送安全消息：有活跃会话时加密，否则明文回退
   */
  wrapSecurePayload(payload: Record<string, unknown>): Record<string, unknown> {
    if (this.deviceSession && !isSessionExpired(this.deviceSession)) {
      if (this.securityPolicy && shouldRotateKey(this.deviceSession, this.securityPolicy)) {
        return payload; // 调用方需触发 re-handshake
      }
      return createSecureMessage(payload, this.deviceSession) as unknown as Record<string, unknown>;
    }
    return payload;
  }

  /**
   * 检查是否需要密钥轮换
   */
  needsKeyRotation(): boolean {
    return !!(
      this.deviceSession &&
      !isSessionExpired(this.deviceSession) &&
      this.securityPolicy &&
      shouldRotateKey(this.deviceSession, this.securityPolicy)
    );
  }

  /**
   * 解密安全消息
   */
  decryptMessage(msg: SecureDeviceMessage): Record<string, unknown> | null {
    if (!this.deviceSession) {
      safeError('[DeviceSessionSecurity] 收到安全消息但无活跃会话');
      return null;
    }
    if (isSessionExpired(this.deviceSession)) {
      safeError('[DeviceSessionSecurity] 会话已过期，丢弃安全消息');
      this.deviceSession = null;
      return null;
    }
    const result = decryptSecureMessage(msg, this.deviceSession);
    if (!result) {
      safeError(`[DeviceSessionSecurity] 安全消息解密/验证失败: seq=${msg.seq}`);
    }
    return result;
  }

  /**
   * 重置安全会话状态
   */
  reset(): void {
    this.deviceSession = null;
    this.securityPolicy = null;
    this.ephemeralPrivateKey = null;
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }
}
