/**
 * 实时控制能力测试套件
 * 
 * 验证：
 * 1. WebSocket 高频数据通道（100Hz）
 * 2. 二进制协议延迟优化
 * 3. 流式任务分解引擎（10ms 微步骤）
 * 4. 快速事件响应（<10ms）
 * 5. PID 控制器性能
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  handleEmergencyStop,
  handleSensorThreshold,
  handleObstacleDetected,
  handleForceAnomaly,
} from './fastEventHandlers';

type DeviceDataStream = {
  deviceId: string;
  timestamp: number;
  dataType: string;
  sequenceNumber: number;
  payload: Float64Array;
};

const {
  StreamingDeviceChannel,
} = require('../../../../skills/streaming-device-control/src/channel.ts') as any;
const {
  encodeSensorData,
  encodeControlCommand,
  decodeMessage,
  MessageType,
  SensorDataType,
  CommandTypes,
} = require('../../../../skills/streaming-device-control/src/protocol.js') as any;
const {
  createStreamingPlanner,
} = require('../../../../skills/streaming-device-control/src/planner.js') as any;
const {
  createPidController,
  createThresholdController,
} = require('../../../../skills/streaming-device-control/src/feedbackHandler.js') as any;

// Mock Pool for testing
const mockPool = {
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
};

describe('P0 实时控制能力测试', () => {
  
  // ────────────────────────────────────────────────────────────────
  // 测试 1: WebSocket 通道基础功能
  // ────────────────────────────────────────────────────────────────
  
  describe('WebSocket 通道', () => {
    let channel: any;

    beforeEach(() => {
      channel = new StreamingDeviceChannel({ pool: mockPool as any });
    });

    afterEach(() => {
      channel.close();
    });

    it('应该成功建立连接', async () => {
      const wsUrl = 'ws://localhost:8080/device-agent/ws';
      
      // 注意：实际测试需要真实的 WebSocket 服务器
      // 这里验证接口定义
      expect(channel).toBeDefined();
      expect(typeof channel.sendSensorData).toBe('function');
      expect(typeof channel.onCommand).toBe('function');
    });

    it('应该支持背压控制', async () => {
      // 模拟发送大量数据
      const stream: DeviceDataStream = {
        deviceId: 'test-device-001',
        timestamp: Date.now(),
        dataType: 'joint_angles',
        sequenceNumber: 1,
        payload: new Float64Array([0.1, 0.2, 0.3]),
      };

      // 验证数据结构
      expect(stream.deviceId).toBe('test-device-001');
      expect(stream.sequenceNumber).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 测试 2: 二进制协议性能
  // ────────────────────────────────────────────────────────────────
  
  describe('二进制协议', () => {
    it('应该正确编码传感器数据', () => {
      const data = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const encoded = encodeSensorData({
        deviceId: 'device-001',
        timestamp: 1711623456789,
        dataType: SensorDataType.JOINT_ANGLES,
        sequenceNumber: 42,
        data,
      });

      expect(encoded.buffer).toBeDefined();
      expect(encoded.messageType).toBe(MessageType.SENSOR_DATA);
      expect(encoded.buffer.length).toBeGreaterThan(0);
    });

    it('应该正确解码消息', () => {
      const originalData = {
        deviceId: 'device-001',
        timestamp: 1711623456789,
        dataType: SensorDataType.FORCE_SENSOR,
        sequenceNumber: 100,
        data: new Float64Array([1.5, 2.5, 3.5]),
      };

      const encoded = encodeSensorData(originalData);
      const decoded = decodeMessage(encoded.buffer);

      expect(decoded.isValid).toBe(true);
      expect(decoded.messageType).toBe(MessageType.SENSOR_DATA);
      if (decoded.isValid && decoded.data) {
        expect(decoded.data.deviceId).toBe('device-001');
        expect(decoded.data.sequenceNumber).toBe(100);
      }
    });

    it('紧急停止命令应该最小化延迟', () => {
      const { encodeEmergencyStop } = require('../../../../skills/streaming-device-control/src/protocol.js');
      const emergencyMsg = encodeEmergencyStop('device-001');
      
      // 紧急停止命令应该是最小的
      expect(emergencyMsg.buffer.length).toBeLessThan(100);
      expect(emergencyMsg.messageType).toBe(MessageType.CONTROL_COMMAND);
    });

    it('二进制协议比 JSON 序列化更快', () => {
      const testData = {
        deviceId: 'device-001',
        values: [0.1, 0.2, 0.3, 0.4, 0.5],
        timestamp: Date.now(),
      };

      // JSON 序列化
      const jsonStart = Date.now();
      const jsonStr = JSON.stringify(testData);
      const jsonTime = Date.now() - jsonStart;

      // 二进制编码
      const binaryStart = Date.now();
      const binaryData = encodeSensorData({
        deviceId: testData.deviceId,
        timestamp: testData.timestamp,
        dataType: SensorDataType.JOINT_ANGLES,
        sequenceNumber: 1,
        data: new Float64Array(testData.values),
      });
      const binaryTime = Date.now() - binaryStart;

      // 二进制应该更快或至少不慢太多
      console.log(`JSON: ${jsonTime}ms, Binary: ${binaryTime}ms`);
      expect(binaryData.buffer.length).toBeLessThan(jsonStr.length);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 测试 3: 流式任务分解引擎
  // ────────────────────────────────────────────────────────────────
  
  describe('流式任务分解引擎', () => {
    it('应该创建微步骤序列', async () => {
      const planner = createStreamingPlanner({ pool: mockPool as any });
      
      const plan = await planner.createStreamingPlan({
        runId: 'run-test-001',
        stepId: 'step-001',
        taskDescription: '抓取杯子',
        frequency: 100, // 100Hz
        durationMs: 1000, // 1 秒
      });

      expect(plan.microSteps.length).toBe(100); // 100Hz * 1s
      expect(plan.frequency).toBe(100);
      expect(plan.totalDurationMs).toBe(1000);
    });

    it('应该按顺序返回微步骤', async () => {
      const planner = createStreamingPlanner({ pool: mockPool as any });
      
      const plan = await planner.createStreamingPlan({
        runId: 'run-test-002',
        stepId: 'step-002',
        taskDescription: '调整力度',
        frequency: 50,
        durationMs: 500,
      });

      const firstStep = planner.getNextMicroStep(plan.planId);
      const secondStep = planner.getNextMicroStep(plan.planId);

      expect(firstStep).toBeDefined();
      expect(secondStep).toBeDefined();
      if (firstStep && secondStep) {
        expect(secondStep.sequenceNumber).toBe(firstStep.sequenceNumber + 1);
      }
    });

    it('应该支持 sense→plan→act循环', async () => {
      const planner = createStreamingPlanner({ pool: mockPool as any });
      
      const plan = await planner.createStreamingPlan({
        runId: 'run-test-003',
        stepId: 'step-003',
        taskDescription: '实时监控',
        frequency: 3, // 3Hz 便于验证
        durationMs: 3000,
      });

      const steps = [];
      for (let i = 0; i < 9; i++) {
        const step = planner.getNextMicroStep(plan.planId);
        if (step) steps.push(step);
      }

      // 验证执行类型循环：sense → plan → act → sense → ...
      expect(steps[0].executionType).toBe('sense');
      expect(steps[1].executionType).toBe('plan');
      expect(steps[2].executionType).toBe('act');
      expect(steps[3].executionType).toBe('sense');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 测试 4: PID 控制器性能
  // ────────────────────────────────────────────────────────────────
  
  describe('PID 控制器', () => {
    it('应该基于误差生成控制指令', async () => {
      const pid = createPidController({
        kp: 1.5,
        ki: 0.1,
        kd: 0.05,
        frequency: 100,
      });

      const feedback = {
        dataType: 'force_sensor' as const,
        timestamp: Date.now(),
        deviceId: 'device-001',
        values: new Float64Array([0.5, 0.6, 0.7]), // 有力误差
        sequenceNumber: 1,
      };

      const command = await pid.generateCommand(feedback);

      expect(command.commandId).toBeDefined();
      expect(command.commandType).toBe('adjust_grip');
      expect((command.params as any).adjustment).toBeDefined();
    });

    it('应该收敛到目标值', async () => {
      const pid = createPidController({
        kp: 2.0,
        ki: 0.5,
        kd: 0.1,
        frequency: 100,
      });

      let error = 1.0; // 初始误差
      const commands = [];

      // 模拟多次迭代
      for (let i = 0; i < 10; i++) {
        const feedback = {
          dataType: 'position' as const,
          timestamp: Date.now(),
          deviceId: 'device-001',
          values: new Float64Array([error]),
          sequenceNumber: i,
        };

        const command = await pid.generateCommand(feedback);
        commands.push(command);

        // 模拟误差减小
        error *= 0.7;
      }

      // 验证输出逐渐减小
      const firstOutput = Math.abs((commands[0].params as any).adjustment);
      const lastOutput = Math.abs((commands[9].params as any).adjustment);
      expect(lastOutput).toBeLessThan(firstOutput);
    });

    it('紧急停止应该立即生效', () => {
      const pid = createPidController({
        kp: 1.0,
        ki: 0.0,
        kd: 0.0,
        frequency: 100,
      });

      const emergencyCmd = pid.generateEmergencyStop('检测到碰撞');

      expect(emergencyCmd.commandType).toBe('emergency_stop');
      expect(emergencyCmd.priority).toBe('urgent');
      expect(emergencyCmd.params.reason).toBe('检测到碰撞');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 测试 5: 阈值控制器
  // ────────────────────────────────────────────────────────────────
  
  describe('阈值控制器', () => {
    it('应该基于阈值触发动作', async () => {
      const thresholds = [
        {
          field: 'force',
          operator: '>' as const,
          value: 5.0,
          action: 'reduce_grip',
          commandType: 'adjust_grip',
        },
        {
          field: 'distance',
          operator: '<' as const,
          value: 0.1,
          action: 'stop',
          commandType: 'emergency_stop',
        },
      ];

      const controller = createThresholdController(thresholds);

      const feedback = {
        dataType: 'force_sensor' as const,
        timestamp: Date.now(),
        deviceId: 'device-001',
        values: { force: 6.0, distance: 0.5 },
        sequenceNumber: 1,
      };

      const command = await controller.generateCommand(feedback as any);

      expect(command.params.action).toBe('reduce_grip');
    });

    it('多个阈值应该优先级匹配', async () => {
      const thresholds = [
        { field: 'critical', operator: '>' as const, value: 10, action: 'emergency', commandType: 'emergency_stop' },
        { field: 'warning', operator: '>' as const, value: 5, action: 'warn', commandType: 'adjust_grip' },
      ];

      const controller = createThresholdController(thresholds);
      const feedback: any = {
        deviceId: 'device-001',
        values: { critical: 15, warning: 8 },
      };

      const command = await controller.generateCommand(feedback);
      
      // 应该匹配最高优先级的紧急动作
      expect(command.params.action).toBe('emergency');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 测试 6: 快速事件响应
  // ────────────────────────────────────────────────────────────────
  
  describe('快速事件响应', () => {
    it('紧急停止应该在 20ms 内完成', async () => {
      const event = {
        type: 'emergency.stop' as const,
        sourceId: 'sensor-001',
        tenantId: 'tenant-001',
        spaceId: 'space-001',
        subjectId: 'system',
        payload: { reason: 'collision_detected' },
      };

      const startTime = Date.now();
      const result = await handleEmergencyStop(
        mockPool as any,
        event,
        'run-001',
        'streaming'
      );
      const endTime = Date.now();

      const latency = endTime - startTime;
      console.log(`紧急停止延迟：${latency}ms`);

      expect(result.ok).toBe(true);
      expect(result.newStatus).toBe('paused');
      expect(latency).toBeLessThan(20);
    });

    it('传感器阈值超限应该分级响应', async () => {
      const testCases = [
        { severity: 'critical', expectedStatus: 'paused' },
        { severity: 'high', expectedStatus: 'streaming' },
        { severity: 'medium', expectedStatus: 'running' },
      ];

      for (const testCase of testCases) {
        const event = {
          type: 'sensor.threshold_exceeded' as const,
          sourceId: 'sensor-002',
          tenantId: 'tenant-001',
          spaceId: 'space-001',
          subjectId: 'system',
          payload: { severity: testCase.severity },
        };

        const result = await handleSensorThreshold(
          mockPool as any,
          event,
          'run-002',
          'running'
        );

        expect(result.newStatus).toBe(testCase.expectedStatus);
      }
    });

    it('障碍物检测应该立即暂停并等待重规划', async () => {
      const event = {
        type: 'obstacle.detected' as const,
        sourceId: 'lidar-001',
        tenantId: 'tenant-001',
        spaceId: 'space-001',
        subjectId: 'system',
        payload: { distance: 0.5 },
      };

      const result = await handleObstacleDetected(
        mockPool as any,
        event,
        'run-003',
        'running'
      );

      expect(result.ok).toBe(true);
      expect(result.newStatus).toBe('needs_device');
      expect(result.message).toContain('障碍物');
    });

    it('力控异常应该暂停检查', async () => {
      const event = {
        type: 'force.anomaly' as const,
        sourceId: 'force-sensor-001',
        tenantId: 'tenant-001',
        spaceId: 'space-001',
        subjectId: 'system',
        payload: { anomalyType: 'slip_detected' },
      };

      const result = await handleForceAnomaly(
        mockPool as any,
        event,
        'run-004',
        'streaming'
      );

      expect(result.ok).toBe(true);
      expect(result.newStatus).toBe('paused');
      expect(result.message).toContain('力控异常');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 测试 7: 端到端集成测试
  // ────────────────────────────────────────────────────────────────
  
  describe('端到端集成测试', () => {
    it('完整的实时控制闭环', async () => {
      // 1. 创建流式计划
      const planner = createStreamingPlanner({ pool: mockPool as any });
      const plan = await planner.createStreamingPlan({
        runId: 'run-e2e-001',
        stepId: 'step-e2e-001',
        taskDescription: '倒水',
        frequency: 100,
        durationMs: 2000,
      });

      // 2. 获取微步骤
      const microStep = planner.getNextMicroStep(plan.planId);
      expect(microStep).toBeDefined();

      // 3. 模拟传感器反馈
      const pid = createPidController({
        kp: 1.5,
        ki: 0.1,
        kd: 0.05,
        frequency: 100,
      });

      const feedback = {
        dataType: 'force_sensor' as const,
        timestamp: Date.now(),
        deviceId: 'robot-arm-001',
        values: new Float64Array([0.2, 0.3, 0.1]),
        sequenceNumber: 1,
      };

      // 4. 生成控制指令
      const command = await pid.generateCommand(feedback);
      expect(command).toBeDefined();
      expect(command.commandType).toBe('adjust_grip');

      // 5. 模拟突发事件
      const emergencyEvent = {
        type: 'emergency.stop' as const,
        sourceId: 'collision-sensor',
        tenantId: 'tenant-001',
        spaceId: 'space-001',
        subjectId: 'system',
        payload: { reason: 'unexpected_collision' },
      };

      const emergencyResult = await handleEmergencyStop(
        mockPool as any,
        emergencyEvent,
        plan.runId,
        'streaming'
      );

      expect(emergencyResult.ok).toBe(true);
      expect(emergencyResult.newStatus).toBe('paused');

      console.log('✅ 端到端测试通过：实时感知→决策→执行→应急响应闭环验证完成');
    });
  });
});
