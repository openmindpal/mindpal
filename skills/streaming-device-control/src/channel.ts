/**
 * WebSocket 实时设备控制通道
 * 
 * 支持：
 * - 高频传感器数据上报（50-100Hz）
 * - 低延迟指令下发（<10ms 响应）
 * - 二进制协议减少序列化开销
 * - 背压控制和消息队列管理
 */

import { WebSocket } from 'ws';
import type { Pool } from 'pg';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface DeviceDataStream {
  /** 设备 ID */
  deviceId: string;
  /** 时间戳（毫秒） */
  timestamp: number;
  /** 传感器数据类型 */
  dataType: 'joint_angles' | 'force_sensor' | 'camera_frame' | 'position' | 'custom';
  /** 数据负载（二进制或 JSON） */
  payload: Uint8Array | Record<string, unknown>;
  /** 序列号（用于检测丢包） */
  sequenceNumber: number;
}

export interface ControlCommand {
  /** 命令 ID */
  commandId: string;
  /** 目标设备 ID */
  targetDeviceId: string;
  /** 命令类型 */
  commandType: 'move_to' | 'adjust_grip' | 'set_force' | 'set_velocity' | 'emergency_stop' | 'custom';
  /** 命令参数 */
  params: Record<string, unknown>;
  /** 期望执行时间（毫秒） */
  expectedExecutionTime?: number;
  /** 关联的 run/step ID */
  runId?: string;
  stepId?: string;
}

export interface StreamConfig {
  /** 上报频率（Hz），默认 100 */
  frequency: number;
  /** 最大积压消息数，超过则丢弃旧消息 */
  maxBacklog: number;
  /** 心跳间隔（毫秒） */
  heartbeatIntervalMs: number;
  /** 超时断开连接时间（毫秒） */
  timeoutMs: number;
  /** 重连延迟（毫秒），默认 5000 */
  reconnectDelayMs?: number;
}

const DEFAULT_CONFIG: StreamConfig = {
  frequency: 100,
  maxBacklog: 1000,
  heartbeatIntervalMs: 1000,
  timeoutMs: 30000,
  reconnectDelayMs: 5000,
};

// ────────────────────────────────────────────────────────────────
// WebSocket 通道管理器
// ────────────────────────────────────────────────────────────────

export class StreamingDeviceChannel {
  private ws: WebSocket | null = null;
  private pool: Pool;
  private config: StreamConfig;
  private messageQueue: Array<{ event: string; data: unknown }> = [];
  private lastHeartbeat = Date.now();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sequenceNumbers: Map<string, number> = new Map(); // deviceId -> lastSeq
  
  constructor(params: { pool: Pool; config?: Partial<StreamConfig> }) {
    this.pool = params.pool;
    this.config = { ...DEFAULT_CONFIG, ...params.config };
  }

  /**
   * 建立 WebSocket 连接
   */
  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
          console.log('[StreamingDeviceChannel] WebSocket connected');
          this.startHeartbeat();
          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleIncomingMessage(data);
        });

        this.ws.on('error', (err) => {
          console.error('[StreamingDeviceChannel] WebSocket error:', err);
          reject(err);
        });

        this.ws.on('close', () => {
          console.log('[StreamingDeviceChannel] WebSocket closed, attempting reconnect...');
          this.scheduleReconnect(url);
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * 发送传感器数据流
   */
  async sendSensorData(stream: DeviceDataStream): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    // 检查序列号连续性
    const lastSeq = this.sequenceNumbers.get(stream.deviceId) ?? -1;
    if (stream.sequenceNumber !== lastSeq + 1) {
      console.warn(
        `[StreamingDeviceChannel] 检测到丢包：deviceId=${stream.deviceId}, ` +
        `expected=${lastSeq + 1}, received=${stream.sequenceNumber}`
      );
    }
    this.sequenceNumbers.set(stream.deviceId, stream.sequenceNumber);

    // 背压控制：如果队列已满，丢弃最旧的消息
    if (this.messageQueue.length >= this.config.maxBacklog) {
      console.warn(`[StreamingDeviceChannel] 消息队列已满，丢弃旧消息`);
      this.messageQueue.shift();
    }

    // 使用二进制协议减少序列化开销
    const binaryData = this.encodeStreamData(stream);
    this.ws.send(binaryData);
  }

  /**
   * 接收控制指令
   */
  onCommand(callback: (command: ControlCommand) => void): void {
    this.commandHandler = callback;
  }

  private commandHandler: ((command: ControlCommand) => void) | null = null;

  /**
   * 编码传感器数据为二进制格式
   */
  private encodeStreamData(stream: DeviceDataStream): Buffer {
    // 简化的二进制编码示例
    // 实际生产环境应使用 Protocol Buffers 或 MessagePack
    const header = Buffer.alloc(16);
    
    // 写入头部信息
    header.write(stream.deviceId.slice(0, 8).padEnd(8, '\0'), 0, 8, 'utf8');
    header.writeUInt32BE(stream.timestamp, 8);
    header.writeUInt8(stream.dataType === 'joint_angles' ? 0 : 1, 12);
    header.writeUInt8(stream.sequenceNumber & 0xFF, 13);
    
    // 数据负载
    const payload = Buffer.isBuffer(stream.payload) 
      ? stream.payload 
      : Buffer.from(JSON.stringify(stream.payload), 'utf8');
    
    // 合并头部和负载
    const fullMessage = Buffer.concat([header, payload]);
    return fullMessage;
  }

  /**
   * 解码 incoming 消息
   */
  private decodeIncomingData(data: Buffer): ControlCommand | null {
    try {
      // 尝试解析为 JSON（兼容模式）
      const json = JSON.parse(data.toString('utf8'));
      if (json.commandId && json.targetDeviceId && json.commandType) {
        return json as ControlCommand;
      }
    } catch {
      // 不是 JSON，可能是二进制协议，暂时不处理
      console.warn('[StreamingDeviceChannel] 收到未知格式消息');
    }
    return null;
  }

  /**
   * 处理接收到的消息
   */
  private handleIncomingMessage(data: Buffer): void {
    const command = this.decodeIncomingData(data);
    if (command && this.commandHandler) {
      this.commandHandler(command);
    }
  }

  /**
   * 启动心跳机制
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const now = Date.now();
      if (now - this.lastHeartbeat > this.config.timeoutMs) {
        console.error('[StreamingDeviceChannel] 心跳超时，断开连接');
        this.ws.close();
        return;
      }

      // 发送心跳
      this.ws.send(JSON.stringify({ type: 'heartbeat', timestamp: now }));
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * 计划重连
   */
  private scheduleReconnect(url: string): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      console.log('[StreamingDeviceChannel] 尝试重新连接...');
      try {
        await this.connect(url);
      } catch (err) {
        console.error('[StreamingDeviceChannel] 重连失败:', err);
        this.scheduleReconnect(url);
      }
    }, DEFAULT_CONFIG.reconnectDelayMs);
  }

  /**
   * 关闭连接
   */
  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 工厂函数
// ────────────────────────────────────────────────────────────────

export function createStreamingChannel(params: { 
  pool: Pool; 
  url: string;
  config?: Partial<StreamConfig> 
}): Promise<StreamingDeviceChannel> {
  const channel = new StreamingDeviceChannel(params);
  return channel.connect(params.url).then(() => channel);
}
