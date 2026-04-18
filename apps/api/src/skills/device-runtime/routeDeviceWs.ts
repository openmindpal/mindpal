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

    console.log(`[deviceWs] connected: deviceId=${deviceId}`);

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
            console.log(`[deviceWs] delivering ${pending.length} pending D2D messages to deviceId=${deviceId}`);
            for (const env of pending) {
              try {
                socket.send(JSON.stringify({ type: "d2d_message", payload: env }));
              } catch { break; /* WS 已断 */ }
            }
          }
        } catch (pendingErr: any) {
          console.warn(`[deviceWs] pending D2D delivery failed: ${pendingErr?.message}`);
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
        console.error(`[deviceWs] Redis subscribe failed for deviceId=${deviceId}:`, subErr?.message);
      }
    })();

    // ── 消息处理 ──────────────────────────────────────────────────
    socket.on("message", (data: any) => {
      try {
        const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        const msg = JSON.parse(raw);
        const type = String(msg?.type ?? "");

        switch (type) {
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
            console.log(
              `[deviceWs] task_result via WS: deviceId=${deviceId} executionId=${msg?.payload?.executionId ?? "?"}`,
            );
            break;

          // P1: 流式控制状态上报
          case "streaming_status":
            touchDeviceHeartbeat(deviceId);
            console.log(
              `[deviceWs] streaming_status: deviceId=${deviceId} sessionId=${msg?.payload?.sessionId ?? "?"} state=${msg?.payload?.state ?? msg?.payload?.type ?? "?"}`,
            );
            // 可转发给 orchestrator 或前端 WS 订阅者
            break;

          case "streaming_progress":
            touchDeviceHeartbeat(deviceId);
            // 高频步骤进度，仅记录调试日志（生产环境可缓存/采样）
            if (process.env.DEVICE_WS_STREAMING_VERBOSE === "true") {
              console.log(
                `[deviceWs] streaming_progress: deviceId=${deviceId} step=${msg?.payload?.stepIndex ?? "?"} action=${msg?.payload?.action ?? "?"}`,
              );
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
                console.error(`[deviceWs] d2d_send failed: deviceId=${deviceId}`, err?.message);
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
                console.warn(`[deviceWs] delivery receipt failed: ${err?.message}`);
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
                console.warn(`[deviceWs] d2d_batch_ack failed: ${err?.message}`);
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
                console.warn(`[deviceWs] subscribe_topic failed: ${err?.message}`);
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
                console.warn(`[deviceWs] unsubscribe_topic failed: ${err?.message}`);
              });
            }
            break;
          }

          default:
            console.log(`[deviceWs] unknown message type: ${type} from deviceId=${deviceId}`);
        }
      } catch (err: any) {
        console.error(`[deviceWs] message parse error: deviceId=${deviceId}`, err?.message);
      }
    });

    // ── 断开 / 错误清理 ──────────────────────────────────────────
    socket.on("close", () => {
      unregisterDeviceConnection(deviceId, socket as any);
      console.log(`[deviceWs] disconnected: deviceId=${deviceId}`);
    });

    socket.on("error", (err: any) => {
      console.error(`[deviceWs] error: deviceId=${deviceId}`, err?.message);
      unregisterDeviceConnection(deviceId, socket as any);
    });
  });
};
