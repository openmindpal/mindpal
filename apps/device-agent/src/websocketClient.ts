/**
 * Device Agent WebSocket 客户端
 *
 * 支持：
 * - WebSocket 长连接（替代 HTTP 轮询）
 * - 服务器主动推送任务（claim → executeDeviceTool → 上报结果）
 * - 高频状态上报（50-100Hz）
 * - 本地缓存和断线重连
 * - HTTP + WebSocket 双通道结果上报
 */

import { WebSocket } from 'ws';
import type { DeviceAgentConfig } from './config';
import { safeLog, safeError } from './log';
import { resolveDeviceAgentEnv } from './deviceAgentEnv';
import { handleTaskPending, handleDeviceMessage, sendTaskResult, type WsTaskContext } from './wsMessageHandlers';
import {
  handleStreamingStart, handleStreamingStep, handleStreamingStop,
  handleStreamingPause, handleStreamingResume,
  type StreamingState, type StreamingSendContext,
} from './wsStreamingHandlers';
import {
  DEVICE_PROTOCOL_VERSION,
  type ProtocolHandshake,
  type ProtocolHandshakeAck,
  type DeviceMultimodalQuery,
  type DeviceMultimodalResponse,
  type DeviceAttachment,
  type DeviceMultimodalCapabilities,
  type DeviceMultimodalPolicy,
} from '@openslin/shared';

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

  /** P1: 流式执行器状态（委托给 wsStreamingHandlers） */
  private streamingState: StreamingState = { executor: null, sessionId: null };

  /** P2: 服务端下发的多模态策略 */
  private _multimodalPolicy: DeviceMultimodalPolicy | null = null;
  /** P2: 设备声明的多模态能力 */
  private _multimodalCapabilities: DeviceMultimodalCapabilities | null = null;
  /** P2: 流式 AI 响应回调 */
  private _deviceResponseCallbacks = new Map<string, {
    onChunk: (chunk: string) => void;
    onDone: () => void;
    onError: (error: string) => void;
  }>();

  /** 降级/恢复回调（由 agent.ts runLoop 注册，用于通信模式切换） */
  private _onDisconnectCb: (() => void) | null = null;
  private _onReconnectCb: (() => void) | null = null;

  /** 背压：高频上报连续失败计数与当前降频因子 */
  private reportConsecutiveFailures = 0;
  private reportFrequencyDivisor = 1;

  constructor(config: DeviceAgentConfig, confirmFn?: (q: string) => Promise<boolean>) {
    this.config = config;
    // 默认自动确认（WebSocket 模式通常无终端交互能力）
    this.confirmFn = confirmFn ?? (async () => true);
  }

  /** 注册WS断开回调（非主动stop时触发，通知调用方切换到HTTP fallback） */
  onDisconnect(cb: () => void): void {
    this._onDisconnectCb = cb;
  }

  /** 注册WS重连成功回调（通知调用方切回WS模式） */
  onReconnect(cb: () => void): void {
    this._onReconnectCb = cb;
  }

  /** 是否需要重新配对（收到 401/403 后置 true） */
  get needReEnroll(): boolean {
    return this._needReEnroll;
  }

  /**
   * 连接到 WebSocket 服务器
   */
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
          const wasReconnect = this.consecutiveFailures > 0;
          this.consecutiveFailures = 0;
          this.startHeartbeat();
          this.sendProtocolHandshake();
          // 重连成功时触发回调，通知调用方切回WS模式
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
          // 非主动stop时触发降级回调，通知调用方切换到HTTP fallback
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

  /**
   * 发送设备状态报告
   */
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

    // 如果有传感器数据，使用二进制格式
    if (report.sensorData) {
      const binaryData = this.encodeSensorData(report);
      this.ws.send(binaryData);
    } else {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * 启动高频状态上报（50-100Hz）
   */
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
          // 连续成功5次后尝试恢复频率
          if (this.reportFrequencyDivisor > 1) {
            this.reportConsecutiveFailures = 0;
            this.reportFrequencyDivisor = Math.max(1, this.reportFrequencyDivisor / 2);
            safeLog(`[WebSocketDeviceAgent] 上报频率恢复: ${Math.round(frequency / this.reportFrequencyDivisor)}Hz`);
          }
          scheduleNext();
        }).catch((err: Error) => {
          this.reportConsecutiveFailures++;
          // 连续失败时自适应降频: 100Hz → 50Hz → 25Hz
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

  /**
   * 停止所有定时器
   */
  stop(): void {
    this.stopRequested = true;
    this.isRunning = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.statusReportTimer) {
      clearInterval(this.statusReportTimer);
      this.statusReportTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    safeLog('[WebSocketDeviceAgent] 已停止');
  }

  // ────────────────────────────────────────────────────────────────
  // P2: 多模态查询
  // ────────────────────────────────────────────────────────────────

  /** 设置设备多模态能力（在握手前调用） */
  setMultimodalCapabilities(caps: DeviceMultimodalCapabilities): void {
    this._multimodalCapabilities = caps;
  }

  /** 获取服务端下发的多模态策略 */
  get multimodalPolicy(): DeviceMultimodalPolicy | null {
    return this._multimodalPolicy;
  }

  /**
   * 发送多模态查询到云端，接收流式 AI 响应
   *
   * @param message 文本消息
   * @param attachments 多模态附件（图片/音频/视频）
   * @param callbacks 流式响应回调
   * @returns sessionId
   */
  async sendMultimodalQuery(
    message: string,
    attachments?: DeviceAttachment[],
    callbacks?: {
      onChunk?: (chunk: string) => void;
      onDone?: () => void;
      onError?: (error: string) => void;
    },
  ): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接');
    }

    const sessionId = `dq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 注册响应回调
    if (callbacks) {
      this._deviceResponseCallbacks.set(sessionId, {
        onChunk: callbacks.onChunk ?? (() => {}),
        onDone: callbacks.onDone ?? (() => {}),
        onError: callbacks.onError ?? (() => {}),
      });
    }

    // 附件预处理：本地文件路径 → base64 dataUrl（如有需要）
    const processedAttachments = attachments ? await this.preprocessAttachments(attachments) : undefined;

    const query: DeviceMultimodalQuery = {
      type: 'device_query',
      sessionId,
      message,
      attachments: processedAttachments,
    };

    this.ws.send(JSON.stringify(query));
    safeLog(`[WebSocketDeviceAgent] 多模态查询已发送: sessionId=${sessionId}, attachments=${processedAttachments?.length ?? 0}`);

    return sessionId;
  }

  /** 处理设备响应消息 */
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

    if (resp.chunk) {
      callbacks.onChunk(resp.chunk);
    }

    if (resp.done) {
      callbacks.onDone();
      this._deviceResponseCallbacks.delete(resp.sessionId);
    }
  }

  /** 预处理附件：确保 dataUrl 已就绪 */
  private async preprocessAttachments(attachments: DeviceAttachment[]): Promise<DeviceAttachment[]> {
    const result: DeviceAttachment[] = [];
    for (const att of attachments) {
      if (att.dataUrl) {
        result.push(att);
      } else if (att.name) {
        // 本地文件 → base64 dataUrl
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

  // ────────────────────────────────────────────────────────────────
  // 私有方法
  // ────────────────────────────────────────────────────────────────

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
          handleStreamingStart(this.streamingState, sendCtx, message.payload);
          break;
        case 'streaming_step':
          handleStreamingStep(this.streamingState, message.payload);
          break;
        case 'streaming_stop':
          handleStreamingStop(this.streamingState);
          break;
        case 'streaming_pause':
          handleStreamingPause(this.streamingState);
          break;
        case 'streaming_resume':
          handleStreamingResume(this.streamingState);
          break;
        case 'device_response':
          this.handleDeviceResponse(message as any);
          break;
        case 'heartbeat':
          // 心跳响应，无需处理
          break;
        case 'error':
          safeError(`[WebSocketDeviceAgent] 服务器错误：${JSON.stringify(message.payload)}`);
          break;
        default: {
          // 检查是否为协议握手确认（type 含点号，不在 WebSocketMessage 联合类型中）
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

  /** 构建任务处理上下文（最小依赖接口） */
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
    const handshake: ProtocolHandshake & { multimodalCapabilities?: DeviceMultimodalCapabilities } = {
      type: "protocol.handshake",
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      agentVersion: resolveDeviceAgentEnv().agentVersion,
      capabilities: ["desktop.control", "browser.automation", "file.ops"],
    };
    // P2: 附加多模态能力声明
    if (this._multimodalCapabilities) {
      handshake.multimodalCapabilities = this._multimodalCapabilities;
    }
    try {
      this.ws.send(JSON.stringify(handshake));
      safeLog(`[WebSocketDeviceAgent] 协议握手已发送: v${DEVICE_PROTOCOL_VERSION}`);
    } catch (err: any) {
      safeError(`[WebSocketDeviceAgent] 握手发送失败: ${err?.message ?? "unknown"}`);
    }
  }

  private handleHandshakeAck(ack: ProtocolHandshakeAck): void {
    if (ack.compatible) {
      safeLog(`[WebSocketDeviceAgent] 协议握手成功: negotiated=${ack.negotiatedVersion} server=${ack.serverVersion}`);
      if (ack.deprecationWarning) {
        safeLog(`[WebSocketDeviceAgent] 版本废弃警告: ${ack.deprecationWarning}`);
      }
      // P2: 存储服务端下发的多模态策略
      if (ack.multimodalPolicy) {
        this._multimodalPolicy = ack.multimodalPolicy;
        safeLog(`[WebSocketDeviceAgent] 多模态策略已接收: modalities=${ack.multimodalPolicy.allowedModalities.join(',')}`);
      }
    } else {
      safeError(`[WebSocketDeviceAgent] 协议不兼容: server=${ack.serverVersion} negotiated=${ack.negotiatedVersion}，请升级 Device Agent`);
      // 服务端会主动关闭连接，此处阻止自动重连
      this.stop();
    }
  }

  private startHeartbeat(): void {
    const heartbeatIntervalMs = 1000; // 1 秒

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

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
    if (this.stopRequested) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

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

  // ── 二进制编码（保留在主类中，与状态上报紧密相关） ──
  private encodeSensorData(report: DeviceStatusReport): Buffer {
    // 简化的二进制编码
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
