/**
 * 流式设备控制 Skill 主入口
 */

import { 
  StreamingDeviceChannel, 
  createStreamingChannel,
  type DeviceDataStream,
  type ControlCommand,
  type StreamConfig 
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

  /**
   * 初始化 Skill
   */
  async initialize(): Promise<void> {
    this.channel = await createStreamingChannel({
      pool: this.config.pool,
      url: this.config.wsUrl,
      config: this.config.streamConfig,
    });

    // 设置命令处理器
    this.channel.onCommand((command) => {
      this.handleCommand(command);
    });

    console.log('[StreamingDeviceControlSkill] 初始化完成');
  }

  /**
   * 注册事件处理器
   */
  on(eventType: string, handler: (data: unknown) => void): void {
    this.eventHandlers.set(eventType, handler);
  }

  /**
   * 发送传感器数据
   */
  async sendSensorData(stream: DeviceDataStream): Promise<void> {
    if (!this.channel) {
      throw new Error('Skill 未初始化');
    }
    await this.channel.sendSensorData(stream);
  }

  /**
   * 下发控制指令
   */
  async sendCommand(command: ControlCommand): Promise<void> {
    if (!this.channel) {
      throw new Error('Skill 未初始化');
    }
    // TODO: 通过 WebSocket 下发指令
    console.log('[StreamingDeviceControlSkill] 发送指令:', command);
  }

  /**
   * 紧急停止
   */
  async emergencyStop(deviceId: string): Promise<void> {
    if (!this.channel) {
      throw new Error('Skill 未初始化');
    }
    console.log('[StreamingDeviceControlSkill] 紧急停止:', deviceId);
    // TODO: 发送急停命令
  }

  /**
   * 处理接收到的命令
   */
  private handleCommand(command: ControlCommand): void {
    const eventType = `command:${command.commandType}`;
    const handler = this.eventHandlers.get(eventType);
    
    if (handler) {
      handler(command);
    }

    // 同时触发通用命令事件
    const generalHandler = this.eventHandlers.get('command:*');
    if (generalHandler) {
      generalHandler(command);
    }
  }

  /**
   * 关闭 Skill
   */
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
