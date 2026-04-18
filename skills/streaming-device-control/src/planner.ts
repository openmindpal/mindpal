/**
 * 流式任务分解引擎
 * 
 * 支持将连续控制任务分解为 10ms 级微步骤
 * 用于实时感知→实时决策→实时执行的闭环
 */

import type { Pool } from 'pg';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface MicroStep {
  /** 微步骤 ID */
  stepId: string;
  /** 所属的父 step ID */
  parentStepId: string;
  /** 序列号（保证顺序） */
  sequenceNumber: number;
  /** 执行类型 */
  executionType: 'sense' | 'plan' | 'act';
  /** 期望执行时间（毫秒） */
  expectedDurationMs: number;
  /** 输入数据 */
  input: Record<string, unknown>;
  /** 反馈处理器配置 */
  feedbackHandler?: FeedbackHandlerConfig;
  /** 指令生成器配置 */
  commandGenerator?: CommandGeneratorConfig;
}

export interface FeedbackHandlerConfig {
  /** 反馈数据类型 */
  dataType: 'sensor_data' | 'status_update' | 'error_report';
  /** 处理超时（毫秒） */
  timeoutMs: number;
  /** 重试次数 */
  maxRetries: number;
  /** 回调函数名称（Skill 中定义的处理器） */
  callbackName: string;
}

export interface CommandGeneratorConfig {
  /** 命令类型 */
  commandType: 'move_to' | 'adjust_grip' | 'set_force' | 'set_velocity' | 'emergency_stop';
  /** 基于什么反馈生成指令 */
  basedOnFeedback: string[];
  /** 生成策略 */
  strategy: 'pid_control' | 'threshold_based' | 'ml_inference' | 'rule_based';
  /** PID 参数（如果使用 PID 控制） */
  pidParams?: {
    kp: number;
    ki: number;
    kd: number;
  };
  /** 阈值规则（如果使用阈值控制） */
  thresholdRules?: Array<{
    field: string;
    operator: '>' | '<' | '>=' | '<=' | '==';
    value: number;
    action: string;
  }>;
}

export interface StreamingPlan {
  /** 计划 ID */
  planId: string;
  /** 关联的 run/step ID */
  runId: string;
  stepId: string;
  /** 微步骤列表 */
  microSteps: MicroStep[];
  /** 当前执行到的微步骤序号 */
  currentSequence: number;
  /** 更新频率（Hz） */
  frequency: number;
  /** 总持续时间（毫秒） */
  totalDurationMs: number;
  /** 计划状态 */
  status: 'planning' | 'executing' | 'paused' | 'completed' | 'failed';
}

// ────────────────────────────────────────────────────────────────
// 流式任务分解引擎
// ────────────────────────────────────────────────────────────────

export class StreamingPlanner {
  private pool: Pool;
  private activePlans: Map<string, StreamingPlan> = new Map();

  constructor(params: { pool: Pool }) {
    this.pool = params.pool;
  }

  /**
   * 创建流式任务计划
   */
  async createStreamingPlan(params: {
    runId: string;
    stepId: string;
    taskDescription: string;
    frequency: number; // Hz
    durationMs: number;
  }): Promise<StreamingPlan> {
    const planId = this.generatePlanId();
    const microSteps: MicroStep[] = [];

    // 根据频率和总时长计算微步骤数量
    const totalMicroSteps = Math.ceil((params.durationMs / 1000) * params.frequency);

    // 生成微步骤序列
    for (let i = 0; i < totalMicroSteps; i++) {
      const expectedDurationMs = 1000 / params.frequency;
      const microStep: MicroStep = {
        stepId: `micro_${planId}_${i}`,
        parentStepId: params.stepId,
        sequenceNumber: i,
        executionType: i % 3 === 0 ? 'sense' : i % 3 === 1 ? 'plan' : 'act',
        expectedDurationMs,
        input: {
          sequenceIndex: i,
          totalSteps: totalMicroSteps,
          timestamp: Date.now() + (i * expectedDurationMs),
        },
      };

      // 为 act 类型的微步骤添加指令生成器
      if (microStep.executionType === 'act') {
        microStep.commandGenerator = {
          commandType: 'adjust_grip',
          basedOnFeedback: ['force_sensor', 'joint_angles'],
          strategy: 'pid_control',
          pidParams: { kp: 1.5, ki: 0.1, kd: 0.05 },
        };
      }

      // 为 sense 类型的微步骤添加反馈处理器
      if (microStep.executionType === 'sense') {
        microStep.feedbackHandler = {
          dataType: 'sensor_data',
          timeoutMs: 50,
          maxRetries: 3,
          callbackName: 'handleSensorFeedback',
        };
      }

      microSteps.push(microStep);
    }

    const plan: StreamingPlan = {
      planId,
      runId: params.runId,
      stepId: params.stepId,
      microSteps,
      currentSequence: 0,
      frequency: params.frequency,
      totalDurationMs: params.durationMs,
      status: 'planning',
    };

    // 持久化计划
    await this.persistPlan(plan);
    this.activePlans.set(planId, plan);

    console.log(`[StreamingPlanner] 创建计划：planId=${planId}, microSteps=${totalMicroSteps}, frequency=${params.frequency}Hz`);
    return plan;
  }

  /**
   * 获取下一个待执行的微步骤
   */
  getNextMicroStep(planId: string): MicroStep | null {
    const plan = this.activePlans.get(planId);
    if (!plan || plan.currentSequence >= plan.microSteps.length) {
      return null;
    }

    const microStep = plan.microSteps[plan.currentSequence];
    plan.currentSequence++;
    return microStep;
  }

  /**
   * 处理反馈并生成新指令
   */
  async processFeedbackAndGenerateCommand(params: {
    planId: string;
    microStepId: string;
    feedbackData: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null> {
    const plan = this.activePlans.get(params.planId);
    if (!plan) {
      throw new Error(`Plan not found: ${params.planId}`);
    }

    const microStep = plan.microSteps.find(s => s.stepId === params.microStepId);
    if (!microStep || !microStep.commandGenerator) {
      return null;
    }

    const config = microStep.commandGenerator;
    let command: Record<string, unknown> = {};

    // 根据策略生成指令
    switch (config.strategy) {
      case 'pid_control':
        command = this.generatePidCommand(config, params.feedbackData);
        break;
      case 'threshold_based':
        command = this.generateThresholdCommand(config, params.feedbackData);
        break;
      case 'rule_based':
        command = this.generateRuleBasedCommand(config, params.feedbackData);
        break;
      case 'ml_inference':
        // TODO: 集成 ML 推理模型
        console.warn('[StreamingPlanner] ML inference 尚未实现');
        command = { fallback: true };
        break;
    }

    // 记录生成的指令到审计
    await this.logCommandGeneration({
      planId: plan.planId,
      microStepId: params.microStepId,
      feedbackData: params.feedbackData,
      generatedCommand: command,
    });

    return command;
  }

  /**
   * 暂停流式计划
   */
  async pausePlan(planId: string): Promise<void> {
    const plan = this.activePlans.get(planId);
    if (!plan) return;

    plan.status = 'paused';
    await this.updatePlanStatus(planId, 'paused');
    console.log(`[StreamingPlanner] 暂停计划：${planId}`);
  }

  /**
   * 恢复流式计划
   */
  async resumePlan(planId: string): Promise<void> {
    const plan = this.activePlans.get(planId);
    if (!plan) return;

    plan.status = 'executing';
    await this.updatePlanStatus(planId, 'executing');
    console.log(`[StreamingPlanner] 恢复计划：${planId}`);
  }

  /**
   * 完成流式计划
   */
  async completePlan(planId: string): Promise<void> {
    const plan = this.activePlans.get(planId);
    if (!plan) return;

    plan.status = 'completed';
    await this.updatePlanStatus(planId, 'completed');
    
    // 从活跃计划中移除
    this.activePlans.delete(planId);
    console.log(`[StreamingPlanner] 完成计划：${planId}`);
  }

  /**
   * 失败处理
   */
  async failPlan(planId: string, reason: string): Promise<void> {
    const plan = this.activePlans.get(planId);
    if (!plan) return;

    plan.status = 'failed';
    await this.updatePlanStatus(planId, 'failed');
    
    console.error(`[StreamingPlanner] 计划失败：${planId}, reason=${reason}`);
  }

  // ────────────────────────────────────────────────────────────────
  // 私有辅助方法
  // ────────────────────────────────────────────────────────────────

  private generatePlanId(): string {
    return `stream_plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private async persistPlan(plan: StreamingPlan): Promise<void> {
    // TODO: 持久化到数据库
    // 这里应该创建一个专门的表来存储流式计划
    console.log('[StreamingPlanner] 持久化计划:', plan.planId);
  }

  private async updatePlanStatus(planId: string, status: string): Promise<void> {
    // TODO: 更新数据库状态
    console.log('[StreamingPlanner] 更新状态:', planId, status);
  }

  private async logCommandGeneration(params: {
    planId: string;
    microStepId: string;
    feedbackData: Record<string, unknown>;
    generatedCommand: Record<string, unknown>;
  }): Promise<void> {
    // TODO: 写入审计日志
    console.log('[StreamingPlanner] 记录指令生成:', params);
  }

  private generatePidCommand(
    config: CommandGeneratorConfig,
    feedback: Record<string, unknown>
  ): Record<string, unknown> {
    if (!config.pidParams) {
      throw new Error('PID parameters not configured');
    }

    const { kp, ki, kd } = config.pidParams;
    
    // 简化示例：实际应从 feedback 中提取误差值
    const error = Number(feedback['error'] ?? 0);
    const integral = Number(feedback['integral'] ?? 0);
    const derivative = Number(feedback['derivative'] ?? 0);

    const output = kp * error + ki * integral + kd * derivative;

    return {
      command_type: config.commandType,
      output: parseFloat(output.toFixed(4)),
      timestamp: Date.now(),
    };
  }

  private generateThresholdCommand(
    config: CommandGeneratorConfig,
    feedback: Record<string, unknown>
  ): Record<string, unknown> {
    if (!config.thresholdRules) {
      throw new Error('Threshold rules not configured');
    }

    let action = 'no_op';
    
    for (const rule of config.thresholdRules) {
      const value = Number(feedback[rule.field] ?? 0);
      let conditionMet = false;

      switch (rule.operator) {
        case '>': conditionMet = value > rule.value; break;
        case '<': conditionMet = value < rule.value; break;
        case '>=': conditionMet = value >= rule.value; break;
        case '<=': conditionMet = value <= rule.value; break;
        case '==': conditionMet = value === rule.value; break;
      }

      if (conditionMet) {
        action = rule.action;
        break;
      }
    }

    return {
      command_type: config.commandType,
      action,
      timestamp: Date.now(),
    };
  }

  private generateRuleBasedCommand(
    config: CommandGeneratorConfig,
    feedback: Record<string, unknown>
  ): Record<string, unknown> {
    // 基于规则的简单映射
    return {
      command_type: config.commandType,
      params: feedback,
      timestamp: Date.now(),
    };
  }
}

// ────────────────────────────────────────────────────────────────
// 工厂函数
// ────────────────────────────────────────────────────────────────

export function createStreamingPlanner(params: { pool: Pool }): StreamingPlanner {
  return new StreamingPlanner(params);
}
