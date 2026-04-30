/**
 * 流式设备控制 Skill 主入口
 *
 * 通过 HTTP 调用平台 DeviceCommand API（/v1/device-agent/command）实现
 * 四种设备控制命令：start_stream / stop_stream / send_command / emergency_stop
 *
 * 设计原则：
 * - Skill 自包含沙箱运行，不直接 import 项目内部模块
 * - 通过环境变量 SKILL_API_BASE 获取平台 API 地址
 * - 使用 DeviceCommand/DeviceCommandAck 统一协议
 */

import {
  StreamingDeviceChannel,
  createStreamingChannel,
  type DeviceDataStream,
  type ControlCommand,
  type StreamConfig,
} from './channel';

import {
  MessageType,
  SensorDataType,
  CommandTypes,
  encodeSensorData,
  encodeControlCommand,
  encodeEmergencyStop,
  decodeMessage,
} from './protocol';

export interface StreamingSkillConfig {
  /** WebSocket URL */
  wsUrl: string;
  /** 池连接 */
  pool: any; // Pool from pg
  /** 流配置 */
  streamConfig?: Partial<StreamConfig>;
}

export class StreamingDeviceControlSkill {
  private channel: StreamingDeviceChannel | null = null;
  private config: StreamingSkillConfig;
  private eventHandlers: Map<string, (data: unknown) => void> = new Map();

  constructor(config: StreamingSkillConfig) {
    this.config = config;
  }

  /** 初始化 Skill */
  async initialize(): Promise<void> {
    this.channel = await createStreamingChannel({
      pool: this.config.pool,
      url: this.config.wsUrl,
      config: this.config.streamConfig,
    });

    this.channel.onCommand((command) => {
      this.handleCommand(command);
    });

    console.log('[StreamingDeviceControlSkill] 初始化完成');
  }

  /** 注册事件处理器 */
  on(eventType: string, handler: (data: unknown) => void): void {
    this.eventHandlers.set(eventType, handler);
  }

  /** 发送传感器数据 */
  async sendSensorData(stream: DeviceDataStream): Promise<void> {
    if (!this.channel) throw new Error('Skill 未初始化');
    await this.channel.sendSensorData(stream);
  }

  /** 下发控制指令 */
  async sendCommand(command: ControlCommand): Promise<void> {
    if (!this.channel) throw new Error('Skill 未初始化');
    console.log('[StreamingDeviceControlSkill] 发送指令:', command);
  }

  /** 紧急停止 */
  async emergencyStop(deviceId: string): Promise<void> {
    if (!this.channel) throw new Error('Skill 未初始化');
    console.log('[StreamingDeviceControlSkill] 紧急停止:', deviceId);
  }

  /** 处理接收到的命令 */
  private handleCommand(command: ControlCommand): void {
    const eventType = `command:${command.commandType}`;
    const handler = this.eventHandlers.get(eventType);
    if (handler) handler(command);

    const generalHandler = this.eventHandlers.get('command:*');
    if (generalHandler) generalHandler(command);
  }

  /** 关闭 Skill */
  shutdown(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 导出 Skill 工厂函数
// ────────────────────────────────────────────────────────────────

export function createStreamingDeviceControlSkill(
  config: StreamingSkillConfig
): Promise<StreamingDeviceControlSkill> {
  const skill = new StreamingDeviceControlSkill(config);
  return skill.initialize().then(() => skill);
}

// ────────────────────────────────────────────────────────────────
// 导出所有公共类型和常量
// ────────────────────────────────────────────────────────────────

export {
  MessageType,
  SensorDataType,
  CommandTypes,
  encodeSensorData,
  encodeControlCommand,
  encodeEmergencyStop,
  decodeMessage,
};

export type {
  DeviceDataStream,
  ControlCommand,
  StreamConfig,
};

// ────────────────────────────────────────────────────────────────
// Skill execute 入口（符合 manifest io schema 契约）
// 通过 HTTP 调用平台 DeviceCommand API，不直接 import 内部模块
// ────────────────────────────────────────────────────────────────

interface ExecuteInput {
  command: 'start_stream' | 'stop_stream' | 'send_command' | 'emergency_stop';
  deviceId: string;
  frequency?: number;
  payload?: Record<string, unknown>;
  binary?: boolean;
}

interface ExecuteOutput {
  ok: boolean;
  error?: string;
  streamId?: string;
  latencyMs?: number;
  result?: Record<string, unknown>;
}

/** 生成唯一命令 ID */
function genCommandId(prefix = 'cmd'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 向平台发送 DeviceCommand 并等待 ACK */
async function sendDeviceCommand(
  apiBase: string,
  cmd: {
    commandId: string;
    targetDeviceId: string;
    action: string;
    params: Record<string, unknown>;
    priority: 'normal' | 'high' | 'emergency';
    ttlMs: number;
  },
): Promise<{ ok: boolean; status?: string; latencyMs?: number; result?: Record<string, unknown>; error?: string }> {
  const resp = await fetch(`${apiBase}/device-agent/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });

  if (!resp.ok) {
    return { ok: false, error: `HTTP ${resp.status}` };
  }

  const ack = (await resp.json()) as {
    commandId: string;
    status: string;
    result?: Record<string, unknown>;
    latencyMs?: number;
  };

  return {
    ok: ack.status === 'accepted' || ack.status === 'completed',
    status: ack.status,
    latencyMs: ack.latencyMs ?? 0,
    result: ack.result,
  };
}

exports.execute = async function execute(
  req: { input?: ExecuteInput },
): Promise<ExecuteOutput> {
  const input = req?.input;
  if (!input?.command || !input?.deviceId) {
    return { ok: false, error: 'Missing required fields: command, deviceId' };
  }

  const apiBase = process.env.SKILL_API_BASE || 'http://localhost:4001/v1';
  const { command, deviceId, frequency, payload, binary } = input;

  try {
    switch (command) {
      case 'start_stream': {
        const cmdId = genCommandId('cmd');
        const ack = await sendDeviceCommand(apiBase, {
          commandId: cmdId,
          targetDeviceId: deviceId,
          action: 'start_stream',
          params: { frequency: frequency || 30, binary: binary ?? false },
          priority: 'normal',
          ttlMs: 10_000,
        });

        return {
          ok: ack.ok,
          streamId: cmdId,
          latencyMs: ack.latencyMs,
          error: ack.error,
        };
      }

      case 'stop_stream': {
        const ack = await sendDeviceCommand(apiBase, {
          commandId: genCommandId('cmd'),
          targetDeviceId: deviceId,
          action: 'stop_stream',
          params: {},
          priority: 'normal',
          ttlMs: 5_000,
        });

        return { ok: true, latencyMs: ack.latencyMs, error: ack.error };
      }

      case 'send_command': {
        const ack = await sendDeviceCommand(apiBase, {
          commandId: genCommandId('cmd'),
          targetDeviceId: deviceId,
          action: (payload?.action as string) || 'custom',
          params: payload || {},
          priority: 'normal',
          ttlMs: 10_000,
        });

        return {
          ok: ack.ok,
          latencyMs: ack.latencyMs,
          result: ack.result,
          error: ack.error,
        };
      }

      case 'emergency_stop': {
        const ack = await sendDeviceCommand(apiBase, {
          commandId: genCommandId('cmd_emergency'),
          targetDeviceId: deviceId,
          action: 'emergency_stop',
          params: {},
          priority: 'emergency',
          ttlMs: 3_000, // 急停超时更短
        });

        return { ok: true, latencyMs: ack.latencyMs, error: ack.error };
      }

      default:
        return { ok: false, error: `Unknown command: ${command}` };
    }
  } catch (err: any) {
    console.error('[streaming-device-control] 执行失败:', err.message);
    return { ok: false, error: err.message ?? 'Unknown error' };
  }
};
