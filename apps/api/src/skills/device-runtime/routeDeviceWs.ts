/**
 * Device Agent WebSocket Endpoint — /device-agent/ws
 *
 * 实现：
 * - WebSocket upgrade，复用 authentication plugin 的 Device token 鉴权
 * - 连接建立后注册到 deviceWsRegistry
 * - 处理客户端消息：heartbeat / status_update / task_result
 * - 服务端主动推送：task_pending（由 routeDeviceExecutions 在创建执行时触发）
 */
import type { FastifyPluginAsync } from "fastify";
import {
  StructuredLogger,
  PROTOCOL_VERSIONS,
  DEVICE_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  negotiateVersion,
  isVersionCompatible,
  type ProtocolHandshake,
  type ProtocolHandshakeAck,
  type DeviceMultimodalQuery,
  type DeviceMultimodalCapabilities,
  validateNonce,
  generateNonce,
  generateECDHKeyPair,
  deriveSessionKeys,
  signHandshake,
  verifyHandshake,
  createSecureMessage,
  decryptSecureMessage,
  isSessionExpired,
  shouldRotateKey,
  DEFAULT_SECURITY_POLICY,
  type HandshakeSecurityExt,
  type HandshakeAckSecurityExt,
  type DeviceSessionState,
  type SecureDeviceMessage,
} from "@openslin/shared";
import * as crypto from "node:crypto";

const _logger = new StructuredLogger({ module: "api:deviceWs" });
import {
  registerDeviceConnection,
  unregisterDeviceConnection,
  touchDeviceHeartbeat,
  startHeartbeatCleanup,
  startCrossNodeSubscriber,
  setRegistryRedis,
} from "./deviceWsRegistry";
import { subscribeDeviceChannels, type DeviceMessage } from "./modules/deviceMessageBus";
import {
  sendD2DMessage,
  processDeliveryReceipt,
  getPendingD2DMessages,
  ackPendingD2DMessages,
  subscribeTopic,
  unsubscribeTopic,
  subscribeD2DChannels,
  dynamicSubscribeTopicChannel,
  dynamicUnsubscribeTopicChannel,
  type D2DEnvelope,
} from "./modules/crossDeviceBus";
import { processDeviceQuery } from "./deviceMultimodalHandler";

function requireDeviceFromReq(req: any) {
  const device = req.ctx?.device;
  if (!device) return null;
  return device as {
    deviceId: string;
    tenantId: string;
    spaceId: string | null;
    ownerScope: string;
    ownerSubjectId: string | null;
  };
}

/** 协议握手超时（毫秒）：5s 内未收到握手消息则断开连接 */
const HANDSHAKE_TIMEOUT_MS = 5_000;

// ── V2 安全会话管理（内存 Map，按 sessionId 索引） ──────────
const secureSessions = new Map<string, DeviceSessionState>();

/** 按 deviceId 查找活跃会话 */
function findSessionByDevice(deviceId: string): DeviceSessionState | undefined {
  for (const s of secureSessions.values()) {
    if (s.deviceId === deviceId && !isSessionExpired(s)) return s;
  }
  return undefined;
}

/** 清理指定设备的所有会话 */
function clearDeviceSessions(deviceId: string): void {
  for (const [sid, s] of secureSessions) {
    if (s.deviceId === deviceId) secureSessions.delete(sid);
  }
}

/** 每个连接的协议上下文 */
interface DeviceWsProtocolContext {
  negotiatedVersion: string;
  agentVersion: string;
  handshakeCompleted: boolean;
  /** 设备声明的多模态能力（元数据驱动） */
  multimodalCapabilities?: DeviceMultimodalCapabilities;
  /** V2 安全会话 ID（存在即表示当前连接走 V2） */
  secureSessionId?: string;
}

export const deviceWsRoutes: FastifyPluginAsync = async (app) => {
  // 进程级：启动心跳超时清理
  startHeartbeatCleanup();

  // P2-6.2: 注入 Redis 实例并启动跨节点订阅
  try {
    setRegistryRedis((app as any).redis);
    startCrossNodeSubscriber().catch(() => {});
  } catch { /* ignore */ }

  app.get("/device-agent/ws", { websocket: true }, (socket /* WebSocket */, req) => {
    // ── 鉴权 ──────────────────────────────────────────────────────
    // authentication plugin 的 onRequest hook 已在 upgrade 前执行，
    // 如果 Device token 合法，req.ctx.device 已设置
    const device = requireDeviceFromReq(req);
    if (!device) {
      socket.close(4001, "unauthorized");
      return;
    }

    const deviceId = device.deviceId;
    const now = Date.now();

    // ── 注册连接 ──────────────────────────────────────────────────
    registerDeviceConnection({
      deviceId,
      tenantId: device.tenantId,
      spaceId: device.spaceId,
      socket: socket as any, // WsLike 兼容
      connectedAt: now,
      lastHeartbeatAt: now,
    });

    _logger.info("connected", { deviceId });

    // ── 协议握手 ──────────────────────────────────────────────────
    const protocolCtx: DeviceWsProtocolContext = {
      negotiatedVersion: DEVICE_PROTOCOL_VERSION,
      agentVersion: "unknown",
      handshakeCompleted: false,
    };

    // 握手超时计时器：未在规定时间内完成握手 → 直接断开
    const handshakeTimeout = setTimeout(() => {
      if (!protocolCtx.handshakeCompleted) {
        _logger.warn("Handshake timeout, closing connection", {
          deviceId,
          timeoutMs: HANDSHAKE_TIMEOUT_MS,
        });
        try {
          socket.close(4003, "handshake_timeout");
        } catch { /* ignore */ }
      }
    }, HANDSHAKE_TIMEOUT_MS);

    // ── Redis 订阅：接收跨设备消息并通过 WS 推送 ────────
    let unsubscribe: (() => void) | null = null;
    let unsubscribeD2D: (() => void) | null = null;
    let d2dSubClient: any = null;
    (async () => {
      try {
        const { default: Redis } = await import("ioredis");
        const redisCfg = {
          host: process.env.REDIS_HOST ?? "127.0.0.1",
          port: Number(process.env.REDIS_PORT ?? 6379),
          maxRetriesPerRequest: null as null,
        };
        const subClient = new Redis(redisCfg);
        unsubscribe = await subscribeDeviceChannels({
          subClient,
          tenantId: device.tenantId,
          deviceId,
          onMessage: (msg: DeviceMessage) => {
            try {
              socket.send(JSON.stringify({ type: "device_message", payload: msg }));
            } catch { /* WS 发送失败忽略 */ }
          },
        });

        // P2: D2D 通信总线订阅（独立 sub client）
        d2dSubClient = new Redis(redisCfg);
        const d2dRedis = new Redis(redisCfg);
        unsubscribeD2D = await subscribeD2DChannels({
          subClient: d2dSubClient,
          redis: d2dRedis,
          tenantId: device.tenantId,
          deviceId,
          onMessage: (env: D2DEnvelope) => {
            try {
              socket.send(JSON.stringify({ type: "d2d_message", payload: env }));
            } catch { /* ignore */ }
          },
        });

        // P2: 重连时自动投递 pending D2D 消息
        try {
          const pending = await getPendingD2DMessages({
            redis: d2dRedis,
            tenantId: device.tenantId,
            deviceId,
            limit: 50,
          });
          if (pending.length > 0) {
            _logger.info("delivering pending D2D messages", { count: pending.length, deviceId });
            for (const env of pending) {
              try {
                socket.send(JSON.stringify({ type: "d2d_message", payload: env }));
              } catch { break; /* WS 已断 */ }
            }
          }
        } catch (pendingErr: any) {
          _logger.warn("pending D2D delivery failed", { error: pendingErr?.message });
        }

        // 当 socket 关闭时清理 Redis 订阅
        socket.on("close", () => {
          unsubscribe?.();
          subClient.quit().catch(() => {});
          unsubscribeD2D?.();
          d2dSubClient?.quit().catch(() => {});
          d2dRedis.quit().catch(() => {});
        });
      } catch (subErr: any) {
        _logger.error("Redis subscribe failed", { deviceId, error: subErr?.message });
      }
    })();

    // ── 消息处理 ──────────────────────────────────────────────────
    socket.on("message", (data: any) => {
      try {
        const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        const msg = JSON.parse(raw);
        const type = String(msg?.type ?? "");

        switch (type) {
          // ── 协议握手 ──────────────────────────────────────────
          case "protocol.handshake": {
            clearTimeout(handshakeTimeout);
            const handshake = msg as unknown as ProtocolHandshake;
            const clientVersion = String(handshake.protocolVersion ?? "1.0");
            protocolCtx.agentVersion = String(handshake.agentVersion ?? "unknown");

            const negotiated = negotiateVersion(clientVersion, PROTOCOL_VERSIONS);
            const compatible = negotiated !== null && isVersionCompatible(clientVersion, MIN_SUPPORTED_PROTOCOL_VERSION);

            // P2: 先解析设备声明的多模态能力，再构造 ack
            const rawCaps = (handshake as any).multimodalCapabilities as DeviceMultimodalCapabilities | undefined;
            if (rawCaps && Array.isArray(rawCaps.modalities) && rawCaps.modalities.length > 0) {
              protocolCtx.multimodalCapabilities = rawCaps;
            }

            // ── V2 安全握手检测 ────────────────────────────────
            const securityExt = (handshake as any).securityExt as HandshakeSecurityExt | undefined;
            let securityAckExt: HandshakeAckSecurityExt | undefined;

            if (securityExt) {
              // 1. 验证客户端 nonce + 时间戳
              if (!validateNonce(securityExt.nonce, securityExt.timestamp)) {
                _logger.warn("V2 handshake: invalid nonce or timestamp", { deviceId });
                try { socket.close(4010, "invalid_nonce"); } catch { /* ignore */ }
                break;
              }

              // 2. 验证客户端 HMAC（使用设备 token 作为密钥）
              const deviceToken = (req as any).ctx?.deviceToken ?? "";
              const { hmac: clientHmac, ...dataWithoutHmac } = securityExt;
              const hmacValid = verifyHandshake(
                { ...handshake, securityExt: dataWithoutHmac } as unknown as Record<string, unknown>,
                clientHmac,
                deviceToken,
              );
              if (!hmacValid) {
                _logger.warn("V2 handshake: HMAC verification failed", { deviceId });
                try { socket.close(4011, "hmac_invalid"); } catch { /* ignore */ }
                break;
              }

              // 3. 生成服务端 ECDH 密钥对
              const serverKeyPair = generateECDHKeyPair();
              const serverNonce = generateNonce();

              // 4. 派生会话密钥（salt = clientNonce + serverNonce）
              const salt = securityExt.nonce + serverNonce;
              const { sessionKey, hmacKey } = deriveSessionKeys(
                serverKeyPair.privateKey,
                securityExt.ephemeralPubKey!,
                salt,
              );

              // 5. 创建会话状态
              const sessionId = crypto.randomUUID();
              const session: DeviceSessionState = {
                sessionId,
                deviceId,
                tenantId: device.tenantId,
                authLevel: DEFAULT_SECURITY_POLICY.authLevel,
                sessionKey,
                hmacKey,
                messageCounter: 0,
                replayWindow: new Set(),
                createdAt: Date.now(),
                expiresAt: Date.now() + DEFAULT_SECURITY_POLICY.sessionTtlMs,
              };
              secureSessions.set(sessionId, session);
              protocolCtx.secureSessionId = sessionId;

              // 6. 构建安全 ACK 扩展
              securityAckExt = {
                sessionId,
                serverNonce,
                serverEphemeralPubKey: serverKeyPair.publicKey,
                securityPolicy: DEFAULT_SECURITY_POLICY,
                hmac: "",
              };

              _logger.info("V2 secure handshake established", { deviceId, sessionId });
            }

            const ack: ProtocolHandshakeAck & { securityExt?: HandshakeAckSecurityExt } = {
              type: "protocol.handshake.ack",
              negotiatedVersion: negotiated ?? DEVICE_PROTOCOL_VERSION,
              serverVersion: DEVICE_PROTOCOL_VERSION,
              compatible,
              // P2: 下发多模态策略（元数据驱动，仅当设备声明了多模态能力时才返回）
              multimodalPolicy: protocolCtx.multimodalCapabilities ? {
                allowedModalities: protocolCtx.multimodalCapabilities.modalities,
                maxFileSizeBytes: protocolCtx.multimodalCapabilities.multimodalConfig?.maxFileSize ?? 5_000_000,
                supportedFormats: protocolCtx.multimodalCapabilities.multimodalConfig?.supportedFormats ?? {},
                streaming: protocolCtx.multimodalCapabilities.multimodalConfig?.streaming ?? null,
                vad: protocolCtx.multimodalCapabilities.multimodalConfig?.vad ?? null,
                videoStream: protocolCtx.multimodalCapabilities.multimodalConfig?.videoStream ?? null,
              } : null,
            };

            // V2: 附加安全扩展并签名
            if (securityAckExt) {
              const deviceToken = (req as any).ctx?.deviceToken ?? "";
              const { hmac: _h, ...ackExtWithoutHmac } = securityAckExt;
              securityAckExt.hmac = signHandshake(
                { ...ack, securityExt: ackExtWithoutHmac } as unknown as Record<string, unknown>,
                deviceToken,
              );
              ack.securityExt = securityAckExt;
            }

            if (compatible && negotiated) {
              protocolCtx.negotiatedVersion = negotiated;
              protocolCtx.handshakeCompleted = true;

              _logger.info("protocol handshake ok", {
                deviceId,
                clientVersion,
                negotiatedVersion: negotiated,
                agentVersion: protocolCtx.agentVersion,
                capabilities: handshake.capabilities ?? [],
                secureV2: !!securityAckExt,
              });
            } else {
              _logger.warn("protocol handshake incompatible", {
                deviceId,
                clientVersion,
                minSupported: MIN_SUPPORTED_PROTOCOL_VERSION,
                agentVersion: protocolCtx.agentVersion,
              });
            }

            try {
              socket.send(JSON.stringify(ack));
            } catch { /* ignore */ }

            // 不兼容：发送 ack 后关闭连接
            if (!compatible) {
              try {
                socket.close(4002, `incompatible_protocol: client=${clientVersion} min=${MIN_SUPPORTED_PROTOCOL_VERSION}`);
              } catch { /* ignore */ }
            }
            break;
          }

          case "heartbeat":
            touchDeviceHeartbeat(deviceId);
            // 回复心跳 ACK
            try { socket.send(JSON.stringify({ type: "heartbeat", payload: { ts: Date.now() } })); } catch { /* ignore */ }
            break;

          case "status_update":
            touchDeviceHeartbeat(deviceId);
            // 状态上报：目前只更新心跳，后续可通过事件总线扩展
            break;

          case "task_result":
            touchDeviceHeartbeat(deviceId);
            // task_result 已通过 HTTP /device-agent/executions/:id/result 持久化，
            // WS 通道仅作低延迟通知，此处记录日志
            _logger.info("task_result via WS", { deviceId, executionId: msg?.payload?.executionId ?? "?" });
            break;

          // P1: 流式控制状态上报
          case "streaming_status":
            touchDeviceHeartbeat(deviceId);
            _logger.info("streaming_status", { deviceId, sessionId: msg?.payload?.sessionId ?? "?", state: msg?.payload?.state ?? msg?.payload?.type ?? "?" });
            // 可转发给 orchestrator 或前端 WS 订阅者
            break;

          case "streaming_progress":
            touchDeviceHeartbeat(deviceId);
            // 高频步骤进度，仅记录调试日志（生产环境可缓存/采样）
            if (process.env.DEVICE_WS_STREAMING_VERBOSE === "true") {
              _logger.info("streaming_progress", { deviceId, step: msg?.payload?.stepIndex ?? "?", action: msg?.payload?.action ?? "?" });
            }
            break;

          // P2: D2D 消息发送（设备→服务端→目标设备）
          case "d2d_send": {
            touchDeviceHeartbeat(deviceId);
            const d2dPayload = msg?.payload;
            if (d2dPayload && typeof d2dPayload === "object") {
              sendD2DMessage({
                pool: app.db,
                redis: app.redis,
                msg: {
                  tenantId: device.tenantId,
                  fromDeviceId: deviceId,
                  routingKind: String(d2dPayload.routingKind ?? "direct") as any,
                  toDeviceId: d2dPayload.toDeviceId ? String(d2dPayload.toDeviceId) : null,
                  toDeviceIds: Array.isArray(d2dPayload.toDeviceIds) ? d2dPayload.toDeviceIds.map(String) : undefined,
                  topic: d2dPayload.topic ? String(d2dPayload.topic) : null,
                  category: d2dPayload.category ? String(d2dPayload.category) : "default",
                  priority: d2dPayload.priority ? String(d2dPayload.priority) as any : "normal",
                  payload: typeof d2dPayload.payload === "object" ? d2dPayload.payload : {},
                  requireAck: Boolean(d2dPayload.requireAck),
                  ttlMs: d2dPayload.ttlMs ? Number(d2dPayload.ttlMs) : undefined,
                  correlationId: d2dPayload.correlationId ? String(d2dPayload.correlationId) : null,
                  replyTo: d2dPayload.replyTo ? String(d2dPayload.replyTo) : null,
                },
              }).then((env) => {
                // 回复发送确认
                try {
                  socket.send(JSON.stringify({
                    type: "d2d_send_ack",
                    payload: { messageId: env.messageId, status: env.status },
                  }));
                } catch { /* ignore */ }
              }).catch((err) => {
                _logger.error("d2d_send failed", { deviceId, error: err?.message });
                try {
                  socket.send(JSON.stringify({
                    type: "d2d_send_nack",
                    payload: { error: err?.message ?? "send_failed" },
                  }));
                } catch { /* ignore */ }
              });
            }
            break;
          }

          // P2: D2D 送达回执
          case "d2d_ack":
          case "d2d_nack": {
            touchDeviceHeartbeat(deviceId);
            const ackPayload = msg?.payload;
            if (ackPayload?.messageId) {
              processDeliveryReceipt({
                pool: app.db,
                redis: app.redis,
                receipt: {
                  messageId: String(ackPayload.messageId),
                  deviceId,
                  status: type === "d2d_ack" ? "ack" : "nack",
                  receivedAt: Date.now(),
                  reason: ackPayload.reason ? String(ackPayload.reason) : undefined,
                },
              }).catch((err) => {
                _logger.warn("delivery receipt failed", { error: err?.message });
              });
            }
            break;
          }

          // P2: D2D 批量确认 pending 消息
          case "d2d_batch_ack": {
            touchDeviceHeartbeat(deviceId);
            const ids = msg?.payload?.messageIds;
            if (Array.isArray(ids) && ids.length > 0) {
              ackPendingD2DMessages({
                redis: app.redis,
                tenantId: device.tenantId,
                deviceId,
                messageIds: ids.map(String),
              }).catch((err) => {
                _logger.warn("d2d_batch_ack failed", { error: err?.message });
              });
            }
            break;
          }

          // P2: Topic 订阅管理
          case "subscribe_topic": {
            touchDeviceHeartbeat(deviceId);
            const topicName = msg?.payload?.topic;
            if (typeof topicName === "string" && topicName) {
              subscribeTopic({
                redis: app.redis,
                tenantId: device.tenantId,
                deviceId,
                topic: topicName,
                persistent: Boolean(msg?.payload?.persistent ?? true),
              }).then(() => {
                // 动态订阅 Redis channel
                if (d2dSubClient) {
                  dynamicSubscribeTopicChannel({
                    subClient: d2dSubClient,
                    tenantId: device.tenantId,
                    topic: topicName,
                  }).catch(() => {});
                }
                try {
                  socket.send(JSON.stringify({
                    type: "subscribe_topic_ack",
                    payload: { topic: topicName, ok: true },
                  }));
                } catch { /* ignore */ }
              }).catch((err) => {
                _logger.warn("subscribe_topic failed", { error: err?.message });
              });
            }
            break;
          }

          case "unsubscribe_topic": {
            touchDeviceHeartbeat(deviceId);
            const topicName = msg?.payload?.topic;
            if (typeof topicName === "string" && topicName) {
              unsubscribeTopic({
                redis: app.redis,
                tenantId: device.tenantId,
                deviceId,
                topic: topicName,
              }).then(() => {
                if (d2dSubClient) {
                  dynamicUnsubscribeTopicChannel({
                    subClient: d2dSubClient,
                    tenantId: device.tenantId,
                    topic: topicName,
                  }).catch(() => {});
                }
                try {
                  socket.send(JSON.stringify({
                    type: "unsubscribe_topic_ack",
                    payload: { topic: topicName, ok: true },
                  }));
                } catch { /* ignore */ }
              }).catch((err) => {
                _logger.warn("unsubscribe_topic failed", { error: err?.message });
              });
            }
            break;
          }

          // P2: 设备多模态查询（device_query → orchestrateChatTurn → device_response 流式推送）
          case "device_query": {
            touchDeviceHeartbeat(deviceId);
            const queryPayload = msg as unknown as DeviceMultimodalQuery;
            const deviceQueryParams = {
              ws: socket as any,
              payload: queryPayload,
              deviceRecord: {
                deviceId,
                tenantId: device.tenantId,
                spaceId: device.spaceId,
                ownerScope: device.ownerScope,
                ownerSubjectId: device.ownerSubjectId,
                metadata: {
                  ...((device as any).metadata ?? {}),
                  multimodalCapabilities: protocolCtx.multimodalCapabilities ?? undefined,
                },
              },
              pool: app.db,
              app,
            };

            // 始终走流式路径
            processDeviceQuery(deviceQueryParams).catch((err) => {
              _logger.error("device_query processing failed", { deviceId, error: err?.message });
              try {
                socket.send(JSON.stringify({
                  type: "device_response",
                  sessionId: queryPayload?.sessionId ?? "",
                  error: err?.message ?? "处理失败",
                  done: true,
                }));
              } catch { /* ignore */ }
            });
            break;
          }

          // ── V2 安全消息处理 ──────────────────────────────
          case "secure.message": {
            touchDeviceHeartbeat(deviceId);
            const secMsg = msg as unknown as SecureDeviceMessage;
            const session = secureSessions.get(secMsg.sessionId);

            if (!session || session.deviceId !== deviceId) {
              _logger.warn("secure.message: unknown session", { deviceId, sessionId: secMsg.sessionId });
              try {
                socket.send(JSON.stringify({ type: "secure.error", error: "unknown_session" }));
              } catch { /* ignore */ }
              break;
            }

            // 会话过期检查
            if (isSessionExpired(session)) {
              _logger.warn("secure.message: session expired", { deviceId, sessionId: session.sessionId });
              secureSessions.delete(session.sessionId);
              protocolCtx.secureSessionId = undefined;
              try {
                socket.send(JSON.stringify({ type: "secure.error", error: "session_expired", action: "rehandshake" }));
              } catch { /* ignore */ }
              break;
            }

            // 密钥轮换判定 → 提示客户端重新握手
            if (shouldRotateKey(session, DEFAULT_SECURITY_POLICY)) {
              _logger.info("secure.message: key rotation needed", { deviceId, sessionId: session.sessionId });
              try {
                socket.send(JSON.stringify({ type: "secure.key_rotation", sessionId: session.sessionId }));
              } catch { /* ignore */ }
            }

            // 解密
            const decrypted = decryptSecureMessage(secMsg, session);
            if (!decrypted) {
              _logger.warn("secure.message: decryption failed", { deviceId, sessionId: session.sessionId });
              try {
                socket.send(JSON.stringify({ type: "secure.error", error: "decrypt_failed" }));
              } catch { /* ignore */ }
              break;
            }

            // 将解密后的内部 payload 重新派发到消息处理
            _logger.info("secure.message decrypted", { deviceId, innerType: decrypted.type ?? "unknown" });
            if (typeof decrypted.type === "string") {
              // 注入回消息流（模拟收到明文消息）
              try {
                const innerRaw = JSON.stringify(decrypted);
                socket.emit("message", innerRaw);
              } catch (emitErr: any) {
                _logger.error("secure.message re-dispatch failed", { error: emitErr?.message });
              }
            }
            break;
          }

          default:
            _logger.info("unknown message type", { type, deviceId });
        }
      } catch (err: any) {
        _logger.error("message parse error", { deviceId, error: err?.message });
      }
    });

    // ── V2: 安全消息发送辅助（供服务端主动推送加密消息） ─────
    const secureSend = (payload: Record<string, unknown>) => {
      const sid = protocolCtx.secureSessionId;
      if (!sid) {
        // V1 连接：明文发送
        try { socket.send(JSON.stringify(payload)); } catch { /* ignore */ }
        return;
      }
      const session = secureSessions.get(sid);
      if (!session || isSessionExpired(session)) {
        // 会话失效：降级明文
        try { socket.send(JSON.stringify(payload)); } catch { /* ignore */ }
        return;
      }
      try {
        const secMsg = createSecureMessage(payload, session);
        socket.send(JSON.stringify(secMsg));
      } catch { /* ignore */ }
    };
    // 将 secureSend 挂载到 socket 上，供其他模块使用
    (socket as any)._secureSend = secureSend;

    // ── 断开 / 错误清理 ──────────────────────────────────────────
    socket.on("close", () => {
      clearTimeout(handshakeTimeout);
      // V2: 清理安全会话
      clearDeviceSessions(deviceId);
      unregisterDeviceConnection(deviceId, socket as any);
      _logger.info("disconnected", { deviceId });
    });

    socket.on("error", (err: any) => {
      _logger.error("ws error", { deviceId, error: err?.message });
      unregisterDeviceConnection(deviceId, socket as any);
    });
  });
};
