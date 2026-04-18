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
import { handleTaskPending, handleDeviceMessage, sendTaskResult, type WsTaskContext } from './wsMessageHandlers';
import {
  handleStreamingStart, handleStreamingStep, handleStreamingStop,
  handleStreamingPause, handleStreamingResume,
  type StreamingState, type StreamingSendContext,
} from './wsStreamingHandlers';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface WebSocketMessage {
  type: 'task_pending' | 'task_result' | 'heartbeat' | 'status_update' | 'device_message'
    | 'streaming_start' | 'streaming_stop' | 'streaming_step' | 'streaming_pause' | 'streaming_resume'
    | 'streaming_status' | 'streaming_progress'
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

  constructor(config: DeviceAgentConfig, confirmFn?: (q: string) => Promise<boolean>) {
    this.config = config;
    // 默认自动确认（WebSocket 模式通常无终端交互能力）
    this.confirmFn = confirmFn ?? (async () => true);
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
          this.consecutiveFailures = 0;
          this.startHeartbeat();
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
    const intervalMs = 1000 / frequency;

    if (this.statusReportTimer) {
      clearInterval(this.statusReportTimer);
    }

    this.statusReportTimer = setInterval(() => {
      if (!this.isRunning) return;

      this.sendStatusReport({
        deviceId: this.config.deviceId,
        timestamp: Date.now(),
        status: this.currentTaskId ? 'running' : 'idle',
        currentTaskId: this.currentTaskId,
        frequency,
      }).catch(err => {
        safeError(`[WebSocketDeviceAgent] 状态上报失败：${err.message}`);
      });
    }, intervalMs);

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
        case 'heartbeat':
          // 心跳响应，无需处理
          break;
        case 'error':
          safeError(`[WebSocketDeviceAgent] 服务器错误：${JSON.stringify(message.payload)}`);
          break;
        default:
          safeLog(`[WebSocketDeviceAgent] 未知消息类型：${message.type}`);
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
