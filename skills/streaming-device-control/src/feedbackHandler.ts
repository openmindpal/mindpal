/**
 * 反馈处理器与指令生成器接口
 * 
 * 提供标准化的反馈处理流程和指令生成策略
 */

// ────────────────────────────────────────────────────────────────
// 反馈处理器接口
// ────────────────────────────────────────────────────────────────

export interface FeedbackHandler {
  /**
   * 处理传感器反馈数据
   */
  handleSensorFeedback(data: SensorFeedbackData): Promise<FeedbackResult>;
  
  /**
   * 处理状态更新
   */
  handleStatusUpdate(data: StatusUpdateData): Promise<FeedbackResult>;
  
  /**
   * 处理错误报告
   */
  handleErrorReport(data: ErrorReportData): Promise<FeedbackResult>;
}

export interface SensorFeedbackData {
  /** 数据类型 */
  dataType: 'joint_angles' | 'force_sensor' | 'camera_frame' | 'position' | 'velocity';
  /** 时间戳 */
  timestamp: number;
  /** 设备 ID */
  deviceId: string;
  /** 传感器数据 */
  values: Float64Array | Record<string, number>;
  /** 序列号 */
  sequenceNumber: number;
}

export interface StatusUpdateData {
  /** 设备状态 */
  deviceStatus: 'idle' | 'running' | 'paused' | 'error' | 'emergency_stop';
  /** 当前任务 ID */
  taskId?: string;
  /** 进度百分比 */
  progressPercent?: number;
  /** 附加信息 */
  message?: string;
}

export interface ErrorReportData {
  /** 错误类型 */
  errorType: 'hardware' | 'software' | 'communication' | 'safety';
  /** 错误码 */
  errorCode: number;
  /** 错误消息 */
  errorMessage: string;
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 建议的恢复动作 */
  suggestedRecovery?: string;
}

export interface FeedbackResult {
  /** 是否成功处理 */
  success: boolean;
  /** 是否需要立即响应 */
  requiresImmediateAction: boolean;
  /** 生成的指令（如果有） */
  generatedCommand?: Record<string, unknown>;
  /** 错误信息（如果失败） */
  error?: string;
  /** 处理延迟（毫秒） */
  processingLatencyMs: number;
}

// ────────────────────────────────────────────────────────────────
// 指令生成器接口
// ────────────────────────────────────────────────────────────────

export interface CommandGenerator {
  /**
   * 基于反馈生成指令
   */
  generateCommand(feedback: SensorFeedbackData): Promise<ControlCommand>;
  
  /**
   * 基于目标状态生成指令
   */
  generateCommandForTarget(
    currentState: Record<string, number>,
    targetState: Record<string, number>
  ): Promise<ControlCommand>;
  
  /**
   * 紧急停止指令
   */
  generateEmergencyStop(reason: string): ControlCommand;
}

export interface ControlCommand {
  /** 命令 ID */
  commandId: string;
  /** 目标设备 ID */
  targetDeviceId: string;
  /** 命令类型 */
  commandType: 'move_to' | 'adjust_grip' | 'set_force' | 'set_velocity' | 'emergency_stop';
  /** 命令参数 */
  params: Record<string, number | string>;
  /** 期望执行时间（毫秒） */
  expectedExecutionTimeMs?: number;
  /** 优先级 */
  priority: 'low' | 'normal' | 'high' | 'urgent';
  /** 创建时间戳 */
  createdAt: number;
}

// ────────────────────────────────────────────────────────────────
// 默认实现：PID 控制器
// ────────────────────────────────────────────────────────────────

export class PidController implements CommandGenerator {
  private kp: number;
  private ki: number;
  private kd: number;
  private integralSum: Map<string, number> = new Map();
  private previousError: Map<string, number> = new Map();
  private dt: number; // 采样时间间隔（秒）

  constructor(params: { kp: number; ki: number; kd: number; frequency: number }) {
    this.kp = params.kp;
    this.ki = params.ki;
    this.kd = params.kd;
    this.dt = 1 / params.frequency;
  }

  async generateCommand(feedback: SensorFeedbackData): Promise<ControlCommand> {
    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    // 计算误差（示例：假设目标是 0）
    const values = feedback.values as Float64Array;
    let totalError = 0;
    for (let i = 0; i < values.length; i++) {
      totalError += Math.abs(values[i]);
    }
    const error = totalError / values.length;

    // PID 计算
    const key = feedback.deviceId;
    const integral = (this.integralSum.get(key) ?? 0) + error * this.dt;
    const derivative = (error - (this.previousError.get(key) ?? 0)) / this.dt;
    
    const output = this.kp * error + this.ki * integral + this.kd * derivative;

    // 更新状态
    this.integralSum.set(key, integral);
    this.previousError.set(key, error);

    return {
      commandId,
      targetDeviceId: feedback.deviceId,
      commandType: 'adjust_grip',
      params: {
        adjustment: parseFloat(output.toFixed(4)),
        error: parseFloat(error.toFixed(4)),
      },
      expectedExecutionTimeMs: this.dt * 1000,
      priority: 'normal',
      createdAt: Date.now(),
    };
  }

  async generateCommandForTarget(
    currentState: Record<string, number>,
    targetState: Record<string, number>
  ): Promise<ControlCommand> {
    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    // 计算状态差异
    const keys = Object.keys(currentState);
    let totalError = 0;
    for (const key of keys) {
      const target = targetState[key] ?? 0;
      const current = currentState[key] ?? 0;
      totalError += Math.abs(target - current);
    }
    const error = totalError / keys.length;

    // 简化的 PID 输出
    const output = this.kp * error;

    return {
      commandId,
      targetDeviceId: 'default_device',
      commandType: 'move_to',
      params: {
        velocity: parseFloat(output.toFixed(4)),
        target_reached: error < 0.01 ? 1 : 0,
      },
      expectedExecutionTimeMs: this.dt * 1000,
      priority: 'normal',
      createdAt: Date.now(),
    };
  }

  generateEmergencyStop(reason: string): ControlCommand {
    return {
      commandId: `emergency_${Date.now()}`,
      targetDeviceId: 'all_devices',
      commandType: 'emergency_stop',
      params: {
        reason,
        timestamp: Date.now(),
      },
      priority: 'urgent',
      createdAt: Date.now(),
    };
  }

  /**
   * 重置积分和微分项
   */
  reset(deviceId: string): void {
    this.integralSum.delete(deviceId);
    this.previousError.delete(deviceId);
  }
}

// ────────────────────────────────────────────────────────────────
// 默认实现：阈值控制器
// ────────────────────────────────────────────────────────────────

export class ThresholdController implements CommandGenerator {
  private thresholds: Array<{
    field: string;
    operator: '>' | '<' | '>=' | '<=' | '==';
    value: number;
    action: string;
    commandType: string;
  }>;

  constructor(thresholds: Array<{
    field: string;
    operator: '>' | '<' | '>=' | '<=' | '==';
    value: number;
    action: string;
    commandType: string;
  }>) {
    this.thresholds = thresholds;
  }

  async generateCommand(feedback: SensorFeedbackData): Promise<ControlCommand> {
    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const values = feedback.values as Record<string, number>;
    
    let matchedAction = 'no_op';
    let matchedCommandType = 'custom';

    for (const threshold of this.thresholds) {
      const value = values[threshold.field] ?? 0;
      let conditionMet = false;

      switch (threshold.operator) {
        case '>': conditionMet = value > threshold.value; break;
        case '<': conditionMet = value < threshold.value; break;
        case '>=': conditionMet = value >= threshold.value; break;
        case '<=': conditionMet = value <= threshold.value; break;
        case '==': conditionMet = value === threshold.value; break;
      }

      if (conditionMet) {
        matchedAction = threshold.action;
        matchedCommandType = threshold.commandType;
        break;
      }
    }

    return {
      commandId,
      targetDeviceId: feedback.deviceId,
      commandType: matchedCommandType as any,
      params: {
        action: matchedAction,
        triggered_by: feedback.dataType,
      },
      expectedExecutionTimeMs: 10,
      priority: matchedAction === 'emergency_stop' ? 'urgent' : 'normal',
      createdAt: Date.now(),
    };
  }

  async generateCommandForTarget(): Promise<ControlCommand> {
    throw new Error('ThresholdController 不支持 generateCommandForTarget');
  }

  generateEmergencyStop(reason: string): ControlCommand {
    return {
      commandId: `emergency_${Date.now()}`,
      targetDeviceId: 'all_devices',
      commandType: 'emergency_stop',
      params: { reason, timestamp: Date.now() },
      priority: 'urgent',
      createdAt: Date.now(),
    };
  }
}

// ────────────────────────────────────────────────────────────────
// 工厂函数
// ────────────────────────────────────────────────────────────────

export function createPidController(params: { 
  kp: number; 
  ki: number; 
  kd: number; 
  frequency: number 
}): PidController {
  return new PidController(params);
}

export function createThresholdController(
  thresholds: Array<{
    field: string;
    operator: '>' | '<' | '>=' | '<=' | '==';
    value: number;
    action: string;
    commandType: string;
  }>
): ThresholdController {
  return new ThresholdController(thresholds);
}
