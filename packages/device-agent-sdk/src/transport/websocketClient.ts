/**
 * Device Agent WebSocket 客户端 — 核心骨架
 *
 * [SDK迁移] 从 apps/device-agent/src/websocketClient.ts 迁入
 *
 * 职责：连接管理、心跳、消息收发路由
 * 安全会话 → ./deviceSessionSecurity
 * 流式消息 → ./streamingMessageRouter
 */

import { WebSocket } from 'ws';
import type { DeviceAgentConfig } from '../config';
import { safeLog, safeError } from '../kernel/log';
import { listPlugins } from '../kernel/capabilityRegistry';
import { handleTaskPending, handleDeviceMessage, sendTaskResult, type WsTaskContext } from './wsMessageHandlers';
import {
  DEVICE_PROTOCOL_VERSION,
  type ProtocolHandshake,
  type ProtocolHandshakeAck,
  type DeviceMultimodalQuery,
  type DeviceMultimodalResponse,
  type DeviceAttachment,
  type DeviceMultimodalCapabilities,
  type DeviceMultimodalPolicy,
  type DeviceCapabilityDescriptor,
  type SensorCapability,
  type ActuatorCapability,
  type HandshakeAckSecurityExt,
  type SecureDeviceMessage,
} from '@mindpal/shared';

import { DeviceSecuritySession } from './deviceSessionSecurity';
import {
  type StreamingSessionState,
  type StreamingSendContext,
  type StreamingHandlers,
  setStreamingHandlers as _setStreamingHandlers,
  routeStreamingMessage,
} from './streamingMessageRouter';

// ── 类型/函数重导出（保持外部 API 不变） ─────────────────────

export type { StreamingSessionState, StreamingSendContext, StreamingHandlers };
export { setStreamingHandlers } from './streamingMessageRouter';

let _activeInstance: WebSocketDeviceAgent | null = null;

/**
 * 获取当前活跃的 WebSocket 设备代理实例（供插件层使用）
 */
export function getActiveWebSocketAgent(): WebSocketDeviceAgent | null {
  return _activeInstance;
}

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface WebSocketMessage {
  type: 'task_pending' | 'task_result' | 'heartbeat' | 'status_update' | 'device_message'
    | 'streaming_start' | 'streaming_stop' | 'streaming_step' | 'streaming_pause' | 'streaming_resume'
    | 'streaming_status' | 'streaming_progress'
    | 'device_query' | 'device_response'
    | 'error';
  payload?: Record<string, unknown>;
}

export interface DeviceExecution {
  deviceExecutionId: string;
  toolRef: string;
  input?: any;
}

export interface DeviceStatusReport {
  deviceId: string;
  timestamp: number;
  status: 'idle' | 'running' | 'busy' | 'error';
  currentTaskId?: string;
  frequency?: number; // Hz
  sensorData?: Float64Array;
}

// ────────────────────────────────────────────────────────────────
// WebSocket 设备代理
// ────────────────────────────────────────────────────────────────

export class WebSocketDeviceAgent {
  private ws: WebSocket | null = null;
  private config: DeviceAgentConfig;
  private confirmFn: (q: string) => Promise<boolean>;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private statusReportTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private maxFailures = 10;
  private isRunning = false;
  private currentTaskId?: string;
  private _needReEnroll = false;
  private stopRequested = false;

  /** P1: 流式执行器状态 */
  private streamingState: StreamingSessionState = { executor: null, sessionId: null };

  /** P2: 服务端下发的多模态策略 */
  private _multimodalPolicy: DeviceMultimodalPolicy | null = null;
  private _multimodalCapabilities: DeviceMultimodalCapabilities | null = null;
  /** P3: OS级设备能力描述符 */
  private _capabilityDescriptor: DeviceCapabilityDescriptor | null = null;
  private _deviceResponseCallbacks = new Map<string, {
    onChunk: (chunk: string) => void;
    onDone: () => void;
    onError: (error: string) => void;
  }>();

  /** 降级/恢复回调 */
  private _onDisconnectCb: (() => void) | null = null;
  private _onReconnectCb: (() => void) | null = null;

  /** 背压 */
  private reportConsecutiveFailures = 0;
  private reportFrequencyDivisor = 1;

  /** V2 安全会话（委托给 DeviceSecuritySession） */
  private _security = new DeviceSecuritySession();

  constructor(config: DeviceAgentConfig, confirmFn?: (q: string) => Promise<boolean>) {
    this.config = config;
    this.confirmFn = confirmFn ?? (async () => true);
  }

  onDisconnect(cb: () => void): void { this._onDisconnectCb = cb; }
  onReconnect(cb: () => void): void { this._onReconnectCb = cb; }

  get needReEnroll(): boolean { return this._needReEnroll; }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.stopRequested = false;
        const wsUrl = this.config.apiBase.replace('http', 'ws') + '/device-agent/ws';
        safeLog(`[WebSocketDeviceAgent] 连接：${wsUrl}`);

        this.ws = new WebSocket(wsUrl, {
          headers: {
            'Authorization': `Device ${this.config.deviceToken}`,
            'X-Device-Id': this.config.deviceId,
          },
        });

        this.ws.on('open', () => {
          safeLog('[WebSocketDeviceAgent] 连接成功');
          _activeInstance = this;
          const wasReconnect = this.consecutiveFailures > 0;
          this.consecutiveFailures = 0;
          this.startHeartbeat();
          this.sendProtocolHandshake();
          if (wasReconnect && this._onReconnectCb) {
            this._onReconnectCb();
          }
          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (err: Error) => {
          safeError(`[WebSocketDeviceAgent] 错误：${err.message}`);
          reject(err);
        });

        this.ws.on('close', () => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.ws = null;
          }
          if (this.stopRequested) {
            safeLog('[WebSocketDeviceAgent] 连接关闭，已停止自动重连');
            return;
          }
          safeLog('[WebSocketDeviceAgent] 连接关闭，准备重连...');
          if (this._onDisconnectCb) {
            this._onDisconnectCb();
          }
          this.scheduleReconnect();
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  async sendStatusReport(report: DeviceStatusReport): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接');
    }

    const message: WebSocketMessage = {
      type: 'status_update',
      payload: {
        deviceId: report.deviceId,
        timestamp: report.timestamp,
        status: report.status,
        currentTaskId: report.currentTaskId,
        frequency: report.frequency,
      },
    };

    if (report.sensorData) {
      const binaryData = this.encodeSensorData(report);
      this.ws.send(binaryData);
    } else {
      this.ws.send(JSON.stringify(message));
    }
  }

  startHighFrequencyReporting(frequency: number = 100): void {
    const baseIntervalMs = 1000 / frequency;
    this.reportConsecutiveFailures = 0;
    this.reportFrequencyDivisor = 1;

    if (this.statusReportTimer) {
      clearInterval(this.statusReportTimer);
    }

    const scheduleNext = () => {
      const effectiveInterval = baseIntervalMs * this.reportFrequencyDivisor;
      this.statusReportTimer = setTimeout(() => {
        if (!this.isRunning) { scheduleNext(); return; }

        this.sendStatusReport({
          deviceId: this.config.deviceId,
          timestamp: Date.now(),
          status: this.currentTaskId ? 'running' : 'idle',
          currentTaskId: this.currentTaskId,
          frequency: frequency / this.reportFrequencyDivisor,
        }).then(() => {
          if (this.reportFrequencyDivisor > 1) {
            this.reportConsecutiveFailures = 0;
            this.reportFrequencyDivisor = Math.max(1, this.reportFrequencyDivisor / 2);
            safeLog(`[WebSocketDeviceAgent] 上报频率恢复: ${Math.round(frequency / this.reportFrequencyDivisor)}Hz`);
          }
          scheduleNext();
        }).catch((err: Error) => {
          this.reportConsecutiveFailures++;
          if (this.reportConsecutiveFailures >= 3 && this.reportFrequencyDivisor < 4) {
            this.reportFrequencyDivisor *= 2;
            safeLog(`[WebSocketDeviceAgent] 上报背压降频: ${Math.round(frequency / this.reportFrequencyDivisor)}Hz`);
          }
          safeError(`[WebSocketDeviceAgent] 状态上报失败：${err.message}`);
          scheduleNext();
        });
      }, effectiveInterval);
    };
    scheduleNext();

    safeLog(`[WebSocketDeviceAgent] 启动高频上报：${frequency}Hz`);
  }

  stop(): void {
    this.stopRequested = true;
    this.isRunning = false;
    if (_activeInstance === this) _activeInstance = null;

    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.statusReportTimer) { clearInterval(this.statusReportTimer); this.statusReportTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

    this._security.reset();

    if (this.ws) { this.ws.close(); this.ws = null; }
    safeLog('[WebSocketDeviceAgent] 已停止');
  }

  // ── P2: 多模态查询 ──

  setMultimodalCapabilities(caps: DeviceMultimodalCapabilities): void {
    this._multimodalCapabilities = caps;
  }

  /** P3: 设置 OS级设备能力描述符（端侧探测后调用） */
  setCapabilityDescriptor(desc: DeviceCapabilityDescriptor): void {
    this._capabilityDescriptor = desc;
  }

  /** P3: 获取当前设备能力描述符 */
  get capabilityDescriptor(): DeviceCapabilityDescriptor | null {
    return this._capabilityDescriptor;
  }

  get multimodalPolicy(): DeviceMultimodalPolicy | null {
    return this._multimodalPolicy;
  }

  async sendMultimodalQuery(
    message: string,
    attachments?: DeviceAttachment[],
    callbacks?: {
      onChunk?: (chunk: string) => void;
      onDone?: () => void;
      onError?: (error: string) => void;
    },
    conversationId?: string,
  ): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接');
    }

    const sessionId = `dq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (callbacks) {
      this._deviceResponseCallbacks.set(sessionId, {
        onChunk: callbacks.onChunk ?? (() => {}),
        onDone: callbacks.onDone ?? (() => {}),
        onError: callbacks.onError ?? (() => {}),
      });
    }

    const processedAttachments = attachments ? await this.preprocessAttachments(attachments) : undefined;

    const query: DeviceMultimodalQuery = {
      type: 'device_query',
      sessionId,
      message,
      attachments: processedAttachments,
      ...(conversationId ? { conversationId } : {}),
    };

    this.ws.send(JSON.stringify(query));
    safeLog(`[WebSocketDeviceAgent] 多模态查询已发送: sessionId=${sessionId}, attachments=${processedAttachments?.length ?? 0}`);

    return sessionId;
  }

  private handleDeviceResponse(resp: DeviceMultimodalResponse): void {
    const callbacks = this._deviceResponseCallbacks.get(resp.sessionId);
    if (!callbacks) {
      safeLog(`[WebSocketDeviceAgent] 收到未知 sessionId 的 device_response: ${resp.sessionId}`);
      return;
    }

    if (resp.error) {
      callbacks.onError(resp.error);
      this._deviceResponseCallbacks.delete(resp.sessionId);
      return;
    }

    if (resp.chunk) { callbacks.onChunk(resp.chunk); }
    if (resp.done) {
      callbacks.onDone();
      this._deviceResponseCallbacks.delete(resp.sessionId);
    }
  }

  private async preprocessAttachments(attachments: DeviceAttachment[]): Promise<DeviceAttachment[]> {
    const result: DeviceAttachment[] = [];
    for (const att of attachments) {
      if (att.dataUrl) {
        result.push(att);
      } else if (att.name) {
        try {
          const fs = await import('node:fs/promises');
          const data = await fs.readFile(att.name);
          const base64 = data.toString('base64');
          result.push({
            ...att,
            dataUrl: `data:${att.mimeType};base64,${base64}`,
          });
        } catch (err: any) {
          safeError(`[WebSocketDeviceAgent] 附件读取失败: ${att.name} - ${err?.message}`);
        }
      }
    }
    return result;
  }

  // ── 消息路由 ──

  private handleMessage(data: Buffer): void {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString('utf8'));
      const taskCtx = this.buildTaskContext();
      const sendCtx: StreamingSendContext = { ws: this.ws };

      // 流式消息委托给 streamingMessageRouter
      if (routeStreamingMessage(message.type, this.streamingState, sendCtx, message.payload)) {
        return;
      }

      switch (message.type) {
        case 'task_pending':
          handleTaskPending(taskCtx, message.payload);
          break;
        case 'device_message':
          handleDeviceMessage(message.payload);
          break;
        case 'device_response':
          this.handleDeviceResponse(message as any);
          break;
        case 'heartbeat':
          break;
        case 'secure.message' as any: {
          const secMsg = message as unknown as SecureDeviceMessage;
          const decrypted = this._security.decryptMessage(secMsg);
          if (decrypted) {
            this.handleMessage(Buffer.from(JSON.stringify(decrypted), 'utf8'));
          }
          break;
        }
        case 'error':
          safeError(`[WebSocketDeviceAgent] 服务器错误：${JSON.stringify(message.payload)}`);
          break;
        default: {
          const raw = message as any;
          if (raw.type === 'protocol.handshake.ack') {
            this.handleHandshakeAck(raw as ProtocolHandshakeAck);
          } else {
            safeLog(`[WebSocketDeviceAgent] 未知消息类型：${message.type}`);
          }
        }
      }
    } catch (err: any) {
      safeError(`[WebSocketDeviceAgent] 消息解析失败：${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  private buildTaskContext(): WsTaskContext {
    return {
      config: { apiBase: this.config.apiBase, deviceToken: this.config.deviceToken, deviceId: this.config.deviceId },
      confirmFn: this.confirmFn,
      ws: this.ws,
      setNeedReEnroll: () => { this._needReEnroll = true; },
      stop: () => this.stop(),
      setCurrentTask: (id) => { this.currentTaskId = id; },
      setRunning: (v) => { this.isRunning = v; },
    };
  }

  private sendProtocolHandshake(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const loadedCapabilities = listPlugins().flatMap(p => p.toolPrefixes ?? []);
    const capabilities = loadedCapabilities.length > 0
      ? loadedCapabilities
      : ["desktop.control", "browser.automation", "file.ops"];
    const handshake: ProtocolHandshake & {
      multimodalCapabilities?: DeviceMultimodalCapabilities;
      securityExt?: import('./deviceSessionSecurity').HandshakeSecurityExt;
      capabilityDescriptor?: DeviceCapabilityDescriptor;
    } = {
      type: "protocol.handshake",
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      agentVersion: this.config.agentVersion ?? "1.0.0",
      capabilities,
    };
    if (this._multimodalCapabilities) {
      handshake.multimodalCapabilities = this._multimodalCapabilities;
    }
    // P3: 携带 OS级设备能力描述符
    if (this._capabilityDescriptor) {
      handshake.capabilityDescriptor = this._capabilityDescriptor;
    }
    // V2 安全扩展
    const secExt = this._security.buildSecurityExt(
      handshake.type,
      handshake.protocolVersion,
      this.config.deviceToken,
    );
    if (secExt) {
      handshake.securityExt = secExt;
    }
    try {
      this.ws.send(JSON.stringify(handshake));
      safeLog(`[WebSocketDeviceAgent] 协议握手已发送: v${DEVICE_PROTOCOL_VERSION}`);
    } catch (err: any) {
      safeError(`[WebSocketDeviceAgent] 握手发送失败: ${err?.message ?? "unknown"}`);
    }
  }

  private handleHandshakeAck(ack: ProtocolHandshakeAck & { securityExt?: import('./deviceSessionSecurity').HandshakeAckSecurityExt }): void {
    if (ack.compatible) {
      safeLog(`[WebSocketDeviceAgent] 协议握手成功: negotiated=${ack.negotiatedVersion} server=${ack.serverVersion}`);
      if (ack.deprecationWarning) {
        safeLog(`[WebSocketDeviceAgent] 版本废弃警告: ${ack.deprecationWarning}`);
      }
      if (ack.multimodalPolicy) {
        this._multimodalPolicy = ack.multimodalPolicy;
        safeLog(`[WebSocketDeviceAgent] 多模态策略已接收: modalities=${ack.multimodalPolicy.allowedModalities.join(',')}`);
      }
      if (ack.securityExt && this._security.ephemeralPrivateKey) {
        this._security.handleSecurityAck(
          ack.securityExt,
          this.config.deviceToken,
          this.config.deviceId,
          () => this.sendProtocolHandshake(),
        );
      } else {
        safeLog('[WebSocketDeviceAgent] V1 兼容模式（无安全扩展）');
      }
    } else {
      safeError(`[WebSocketDeviceAgent] 协议不兼容: server=${ack.serverVersion} negotiated=${ack.negotiatedVersion}，请升级 Device Agent`);
      this.stop();
    }
  }

  private startHeartbeat(): void {
    const heartbeatIntervalMs = 1000;

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const message: WebSocketMessage = {
        type: 'heartbeat',
        payload: {
          deviceId: this.config.deviceId,
          timestamp: Date.now(),
        },
      };

      this.ws.send(JSON.stringify(message));
    }, heartbeatIntervalMs);

    safeLog('[WebSocketDeviceAgent] 心跳已启动');
  }

  private scheduleReconnect(): void {
    if (this.stopRequested) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.maxFailures) {
      safeError(`[WebSocketDeviceAgent] 重连次数超限 (${this.consecutiveFailures}/${this.maxFailures})，停止重连`);
      this.stop();
      return;
    }

    const delayMs = Math.min(1000 * Math.pow(2, this.consecutiveFailures), 30000);

    this.reconnectTimer = setTimeout(async () => {
      if (this.stopRequested) return;
      safeLog(`[WebSocketDeviceAgent] 尝试第 ${this.consecutiveFailures} 次重连...`);
      try {
        await this.connect();
      } catch (err: any) {
        safeError(`[WebSocketDeviceAgent] 重连失败：${err instanceof Error ? err.message : 'unknown'}`);
        this.scheduleReconnect();
      }
    }, delayMs);
  }

  // ── V2: 安全消息收发（委托给 DeviceSecuritySession） ──

  sendSecureMessage(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this._security.needsKeyRotation()) {
      safeLog('[WebSocketDeviceAgent] 会话密钥需要轮换，触发重新握手');
      this.sendProtocolHandshake();
    }
    const wrapped = this._security.wrapSecurePayload(payload);
    this.ws.send(JSON.stringify(wrapped));
  }

  handleSecureMessage(msg: SecureDeviceMessage): Record<string, unknown> | null {
    return this._security.decryptMessage(msg);
  }

  get deviceSession(): import('./deviceSessionSecurity').DeviceSessionState | null { return this._security.deviceSession; }
  get securityPolicy(): import('./deviceSessionSecurity').DeviceSecurityPolicy | null { return this._security.securityPolicy; }

  private encodeSensorData(report: DeviceStatusReport): Buffer {
    const header = Buffer.alloc(16);
    header.write(report.deviceId.slice(0, 8).padEnd(8, '\0'), 0, 8, 'utf8');
    header.writeUInt32BE(report.timestamp, 8);
    header.writeUInt8(report.status === 'running' ? 1 : 0, 12);

    const payload = report.sensorData
      ? Buffer.from(report.sensorData.buffer)
      : Buffer.alloc(0);

    return Buffer.concat([header, payload]);
  }
}

// ────────────────────────────────────────────────────────────────
// 工厂函数
// ────────────────────────────────────────────────────────────────

export async function createWebSocketDeviceAgent(
  config: DeviceAgentConfig,
  confirmFn?: (q: string) => Promise<boolean>,
): Promise<WebSocketDeviceAgent> {
  const agent = new WebSocketDeviceAgent(config, confirmFn);
  await agent.connect();
  return agent;
}

// ────────────────────────────────────────────────────────────────
// P3: 端侧设备能力探测
// ────────────────────────────────────────────────────────────────

/**
 * 端侧设备能力探测——通过环境变量/配置判断设备能力，不做实际硬件检测。
 * 生成 DeviceCapabilityDescriptor 用于 WS 握手时上报云端。
 */
export function probeDeviceModalities(): DeviceCapabilityDescriptor {
  const sensors: SensorCapability[] = [];
  const actuators: ActuatorCapability[] = [];

  // 检测麦克风（设备代理默认有音频能力）
  sensors.push({ type: "microphone", id: "mic_default", config: { sampleRate: 16000, channels: 1 } });

  // 检测扬声器
  actuators.push({ type: "speaker", id: "spk_default", config: {} });

  // 检测摄像头（通过环境变量判断）
  if (process.env.DEVICE_HAS_CAMERA !== "false") {
    sensors.push({ type: "camera", id: "cam_default", config: { resolution: "640x480", fps: 30 } });
  }

  // 设备类型从环境变量读取
  const deviceType = (process.env.DEVICE_TYPE as DeviceCapabilityDescriptor["deviceType"]) || "generic";

  return {
    deviceType,
    capabilities: {
      sensors,
      actuators,
      compute: { edgeInferenceMs: parseInt(process.env.EDGE_INFERENCE_MS ?? "100", 10) },
    },
    protocols: ["v1"],
  };
}
