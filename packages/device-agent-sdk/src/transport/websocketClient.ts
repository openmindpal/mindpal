/**
 * Device Agent WebSocket 客户端
 *
 * [SDK迁移] 从 apps/device-agent/src/websocketClient.ts 迁入
 *
 * 应用层依赖解耦：
 * - ./deviceAgentEnv (resolveDeviceAgentEnv) → agentVersion 通过 config 传入
 * - ./wsStreamingHandlers → StreamingHandlers 注入接口 (setStreamingHandlers)
 *
 * SDK 内部导入调整：
 * - ./config → ../config
 * - ./log → ../kernel/log
 * - @openslin/device-agent-sdk (listPlugins) → ../kernel/capabilityRegistry
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
  // V2 安全握手
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
} from '@openslin/shared';

// ── 流式处理器注入接口（解耦 wsStreamingHandlers）────────────────

/** 流式执行器状态（由宿主注入的 streaming handlers 维护） */
export interface StreamingSessionState {
  executor: { stop: () => void; getSummary: () => any } | null;
  sessionId: string | null;
}

/** 流式发送上下文 */
export interface StreamingSendContext {
  ws: { readyState: number; send: (data: string) => void } | null;
}

/** 流式消息处理器接口 — 应用层需注入 */
export interface StreamingHandlers {
  handleStreamingStart(state: StreamingSessionState, ctx: StreamingSendContext, payload?: Record<string, unknown>): void;
  handleStreamingStep(state: StreamingSessionState, payload?: Record<string, unknown>): void;
  handleStreamingStop(state: StreamingSessionState): void;
  handleStreamingPause(state: StreamingSessionState): void;
  handleStreamingResume(state: StreamingSessionState): void;
}

let _streamingHandlers: StreamingHandlers | null = null;
let _activeInstance: WebSocketDeviceAgent | null = null;

/**
 * 获取当前活跃的 WebSocket 设备代理实例（供插件层使用）
 */
export function getActiveWebSocketAgent(): WebSocketDeviceAgent | null {
  return _activeInstance;
}

/**
 * 注入流式消息处理器（应用层在使用 streaming 消息前调用）
 */
export function setStreamingHandlers(handlers: StreamingHandlers): void {
  _streamingHandlers = handlers;
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

  /** V2 安全握手 */
  private _ephemeralPrivateKey: string | null = null;
  private _deviceSession: DeviceSessionState | null = null;
  private _securityPolicy: DeviceSecurityPolicy | null = null;
  private _tokenRefreshTimer: NodeJS.Timeout | null = null;

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
    if (this._tokenRefreshTimer) { clearTimeout(this._tokenRefreshTimer); this._tokenRefreshTimer = null; }

    this._deviceSession = null;
    this._securityPolicy = null;
    this._ephemeralPrivateKey = null;

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

  // ── 私有方法 ──

  private handleMessage(data: Buffer): void {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString('utf8'));
      const taskCtx = this.buildTaskContext();
      const sendCtx: StreamingSendContext = { ws: this.ws };

      switch (message.type) {
        case 'task_pending':
          handleTaskPending(taskCtx, message.payload);
          break;
        case 'device_message':
          handleDeviceMessage(message.payload);
          break;
        case 'streaming_start':
          if (_streamingHandlers) {
            _streamingHandlers.handleStreamingStart(this.streamingState, sendCtx, message.payload);
          } else {
            safeLog('[WebSocketDeviceAgent] streaming_start: StreamingHandlers 未注入，忽略');
          }
          break;
        case 'streaming_step':
          if (_streamingHandlers) {
            _streamingHandlers.handleStreamingStep(this.streamingState, message.payload);
          }
          break;
        case 'streaming_stop':
          if (_streamingHandlers) {
            _streamingHandlers.handleStreamingStop(this.streamingState);
          }
          break;
        case 'streaming_pause':
          if (_streamingHandlers) {
            _streamingHandlers.handleStreamingPause(this.streamingState);
          }
          break;
        case 'streaming_resume':
          if (_streamingHandlers) {
            _streamingHandlers.handleStreamingResume(this.streamingState);
          }
          break;
        case 'device_response':
          this.handleDeviceResponse(message as any);
          break;
        case 'heartbeat':
          break;
        case 'secure.message' as any: {
          const secMsg = message as unknown as SecureDeviceMessage;
          const decrypted = this.handleSecureMessage(secMsg);
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
      securityExt?: HandshakeSecurityExt;
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
    try {
      const keyPair = generateECDHKeyPair();
      this._ephemeralPrivateKey = keyPair.privateKey;

      const nonce = generateNonce();
      const timestamp = Date.now();

      const secExtData: Record<string, unknown> = {
        nonce,
        timestamp,
        ephemeralPubKey: keyPair.publicKey,
      };
      const hmac = signHandshake(
        { ...secExtData, type: handshake.type, protocolVersion: handshake.protocolVersion },
        this.config.deviceToken,
      );

      handshake.securityExt = {
        nonce,
        timestamp,
        ephemeralPubKey: keyPair.publicKey,
        hmac,
      };
    } catch (err: any) {
      safeLog(`[WebSocketDeviceAgent] V2 安全扩展生成失败，降级 V1: ${err?.message}`);
      this._ephemeralPrivateKey = null;
    }
    try {
      this.ws.send(JSON.stringify(handshake));
      safeLog(`[WebSocketDeviceAgent] 协议握手已发送: v${DEVICE_PROTOCOL_VERSION}`);
    } catch (err: any) {
      safeError(`[WebSocketDeviceAgent] 握手发送失败: ${err?.message ?? "unknown"}`);
    }
  }

  private handleHandshakeAck(ack: ProtocolHandshakeAck & { securityExt?: HandshakeAckSecurityExt }): void {
    if (ack.compatible) {
      safeLog(`[WebSocketDeviceAgent] 协议握手成功: negotiated=${ack.negotiatedVersion} server=${ack.serverVersion}`);
      if (ack.deprecationWarning) {
        safeLog(`[WebSocketDeviceAgent] 版本废弃警告: ${ack.deprecationWarning}`);
      }
      if (ack.multimodalPolicy) {
        this._multimodalPolicy = ack.multimodalPolicy;
        safeLog(`[WebSocketDeviceAgent] 多模态策略已接收: modalities=${ack.multimodalPolicy.allowedModalities.join(',')}`);
      }
      if (ack.securityExt && this._ephemeralPrivateKey) {
        this.handleSecurityAck(ack.securityExt);
      } else {
        safeLog('[WebSocketDeviceAgent] V1 兼容模式（无安全扩展）');
      }
    } else {
      safeError(`[WebSocketDeviceAgent] 协议不兼容: server=${ack.serverVersion} negotiated=${ack.negotiatedVersion}，请升级 Device Agent`);
      this.stop();
    }
  }

  private handleSecurityAck(secExt: HandshakeAckSecurityExt): void {
    try {
      const { hmac, ...dataWithoutHmac } = secExt;
      const hmacValid = verifyHandshake(
        dataWithoutHmac as unknown as Record<string, unknown>,
        hmac,
        this.config.deviceToken,
      );
      if (!hmacValid) {
        safeError('[WebSocketDeviceAgent] V2 服务端 HMAC 校验失败，降级 V1');
        this._ephemeralPrivateKey = null;
        return;
      }

      if (secExt.serverEphemeralPubKey && this._ephemeralPrivateKey) {
        const salt = `${secExt.sessionId}:${secExt.serverNonce}`;
        const { sessionKey, hmacKey } = deriveSessionKeys(
          this._ephemeralPrivateKey,
          secExt.serverEphemeralPubKey,
          salt,
        );

        const policy = secExt.securityPolicy ?? DEFAULT_SECURITY_POLICY;
        this._securityPolicy = policy;

        this._deviceSession = {
          sessionId: secExt.sessionId,
          deviceId: this.config.deviceId,
          tenantId: '',
          authLevel: policy.authLevel,
          sessionKey,
          hmacKey,
          messageCounter: 0,
          replayWindow: new Set(),
          createdAt: Date.now(),
          expiresAt: Date.now() + policy.sessionTtlMs,
        };

        safeLog(`[WebSocketDeviceAgent] V2 安全会话已建立: session=${secExt.sessionId} auth=${policy.authLevel}`);

        if (secExt.tokenRefreshAt) {
          const delay = secExt.tokenRefreshAt - Date.now();
          if (delay > 0) {
            if (this._tokenRefreshTimer) clearTimeout(this._tokenRefreshTimer);
            this._tokenRefreshTimer = setTimeout(() => {
              safeLog('[WebSocketDeviceAgent] Token 轮换时间到达，触发重新握手');
              this.sendProtocolHandshake();
            }, delay);
          }
        }
      } else {
        safeLog('[WebSocketDeviceAgent] V2 ACK 缺少 serverEphemeralPubKey，降级 V1');
      }
    } catch (err: any) {
      safeError(`[WebSocketDeviceAgent] V2 安全ACK处理失败: ${err?.message}`);
    } finally {
      this._ephemeralPrivateKey = null;
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

  // ── V2: 安全消息收发 ──

  sendSecureMessage(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this._deviceSession && !isSessionExpired(this._deviceSession)) {
      if (this._securityPolicy && shouldRotateKey(this._deviceSession, this._securityPolicy)) {
        safeLog('[WebSocketDeviceAgent] 会话密钥需要轮换，触发重新握手');
        this.sendProtocolHandshake();
      }
      const msg = createSecureMessage(payload, this._deviceSession);
      this.ws.send(JSON.stringify(msg));
    } else {
      this.ws.send(JSON.stringify(payload));
    }
  }

  handleSecureMessage(msg: SecureDeviceMessage): Record<string, unknown> | null {
    if (!this._deviceSession) {
      safeError('[WebSocketDeviceAgent] 收到安全消息但无活跃会话');
      return null;
    }
    if (isSessionExpired(this._deviceSession)) {
      safeError('[WebSocketDeviceAgent] 会话已过期，丢弃安全消息');
      this._deviceSession = null;
      return null;
    }
    const result = decryptSecureMessage(msg, this._deviceSession);
    if (!result) {
      safeError(`[WebSocketDeviceAgent] 安全消息解密/验证失败: seq=${msg.seq}`);
    }
    return result;
  }

  get deviceSession(): DeviceSessionState | null { return this._deviceSession; }
  get securityPolicy(): DeviceSecurityPolicy | null { return this._securityPolicy; }

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
