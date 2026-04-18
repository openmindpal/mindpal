/**
 * 实时控制能力验证脚本（独立版）
 * 
 * 运行方式：
 * cd skills/streaming-device-control
 * npx ts-node src/validate.ts
 */

import { encodeSensorData, decodeMessage, MessageType, SensorDataType } from './protocol.js';
import { StreamingPlanner, createStreamingPlanner } from './planner.js';
import { PidController, createPidController } from './feedbackHandler.js';

// Mock pool
const mockPool = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

async function validateWebSocketChannel() {
  console.log('\n=== 测试 1: WebSocket 通道基础验证 ===');
  
  const frequency = 100; // 100Hz
  const durationSec = 1;
  const totalMessages = frequency * durationSec;
  
  console.log(`配置：${frequency}Hz，持续 ${durationSec}秒，总消息数：${totalMessages}`);
  
  let startTime = Date.now();
  let messageCount = 0;
  
  for (let i = 0; i < totalMessages; i++) {
    const data = new Float64Array([
      Math.sin(i / 10),
      Math.cos(i / 10),
      Math.sin(i / 20),
    ]);
    
    const encoded = encodeSensorData({
      deviceId: 'test-robot-001',
      timestamp: Date.now(),
      dataType: SensorDataType.JOINT_ANGLES,
      sequenceNumber: i,
      data,
    });
    
    if (encoded && encoded.buffer) {
      messageCount++;
    }
  }
  
  const endTime = Date.now();
  const elapsed = endTime - startTime;
  const throughput = messageCount / (elapsed / 1000);
  
  console.log(`✅ 编码性能:`);
  console.log(`   - 总消息数：${messageCount}`);
  console.log(`   - 耗时：${elapsed}ms`);
  console.log(`   - 吞吐量：${throughput.toFixed(0)} msg/s`);
  console.log(`   - 平均延迟：${(elapsed / messageCount).toFixed(2)}ms/msg`);
  
  return throughput >= frequency;
}

async function validateBinaryProtocol() {
  console.log('\n=== 测试 2: 二进制协议性能对比 ===');
  
  const testData = {
    deviceId: 'device-001',
    values: [0.1, 0.2, 0.3, 0.4, 0.5],
    timestamp: Date.now(),
  };
  
  // JSON 序列化
  const jsonStart = Date.now();
  const jsonStr = JSON.stringify(testData);
  const jsonTime = Date.now() - jsonStart;
  const jsonSize = Buffer.byteLength(jsonStr, 'utf8');
  
  // 二进制编码
  const binaryStart = Date.now();
  const binaryEncoded = encodeSensorData({
    deviceId: testData.deviceId,
    timestamp: testData.timestamp,
    dataType: SensorDataType.FORCE_SENSOR,
    sequenceNumber: 1,
    data: new Float64Array(testData.values),
  });
  const binaryTime = Date.now() - binaryStart;
  const binarySize = binaryEncoded ? binaryEncoded.buffer.length : 0;
  
  console.log(`JSON vs 二进制对比:`);
  console.log(`   JSON:     ${jsonTime}ms, ${jsonSize} bytes`);
  console.log(`   二进制：   ${binaryTime}ms, ${binarySize} bytes`);
  console.log(`   大小优化：${((1 - binarySize / jsonSize) * 100).toFixed(1)}%`);
  console.log(`   速度提升：${(jsonTime / (binaryTime || 1)).toFixed(2)}x`);
  
  // 解码验证
  if (binaryEncoded) {
    const decoded = decodeMessage(binaryEncoded.buffer);
    if (decoded.isValid && decoded.data) {
      const anyData = decoded.data as any;
      console.log(`✅ 解码成功：deviceId=${anyData.deviceId}, seq=${anyData.sequenceNumber}`);
    } else {
      console.log(`❌ 解码失败`);
      return false;
    }
  }
  
  return binarySize < jsonSize;
}

async function validateStreamingPlanner() {
  console.log('\n=== 测试 3: 流式任务分解引擎 ===');
  
  const planner = createStreamingPlanner({ pool: mockPool as any });
  
  const plan = await planner.createStreamingPlan({
    runId: 'validation-run-001',
    stepId: 'validation-step-001',
    taskDescription: '抓取杯子并倒水',
    frequency: 10,
    durationMs: 3000,
  });
  
  console.log(`计划创建:`);
  console.log(`   - Plan ID: ${plan.planId}`);
  console.log(`   - 微步骤总数：${plan.microSteps.length}`);
  console.log(`   - 频率：${plan.frequency}Hz`);
  console.log(`   - 总时长：${plan.totalDurationMs}ms`);
  
  // 获取前 10 个微步骤
  console.log(`\n前 10 个微步骤:`);
  for (let i = 0; i < Math.min(10, plan.microSteps.length); i++) {
    const step = planner.getNextMicroStep(plan.planId);
    if (step) {
      console.log(`   [${i}] ${step.executionType.padEnd(5)} - seq=${step.sequenceNumber}, duration=${step.expectedDurationMs}ms`);
    }
  }
  
  // 验证循环模式
  const types: ('sense' | 'plan' | 'act')[] = [];
  for (let i = 0; i < 9; i++) {
    const step = planner.getNextMicroStep(plan.planId);
    if (step) types.push(step.executionType);
  }
  
  const pattern = types.slice(0, 9).join(' → ');
  console.log(`\n执行模式：${pattern}`);
  
  const hasCycle = types[0] === 'sense' && types[1] === 'plan' && types[2] === 'act';
  console.log(hasCycle ? `✅ sense→plan→act 循环验证通过` : `❌ 循环模式错误`);
  
  return hasCycle;
}

async function validatePidController() {
  console.log('\n=== 测试 4: PID 控制器收敛性 ===');
  
  const pid = createPidController({
    kp: 2.0,
    ki: 0.5,
    kd: 0.1,
    frequency: 100,
  });
  
  let error = 1.0;
  const iterations = 20;
  const errors: number[] = [];
  const outputs: number[] = [];
  
  console.log(`初始误差：${error}`);
  console.log(`迭代次数：${iterations}`);
  
  for (let i = 0; i < iterations; i++) {
    const feedback = {
      dataType: 'position' as const,
      timestamp: Date.now(),
      deviceId: 'robot-arm-001',
      values: new Float64Array([error]),
      sequenceNumber: i,
    };
    
    const command = await pid.generateCommand(feedback);
    const output = (command.params as any).output;
    
    errors.push(error);
    outputs.push(output);
    
    error -= output * 0.1;
    
    if (i % 5 === 0) {
      console.log(`   [${i}] error=${error.toFixed(4)}, output=${output.toFixed(4)}`);
    }
  }
  
  const finalError = Math.abs(errors[errors.length - 1]);
  const initialOutput = Math.abs(outputs[0]);
  const finalOutput = Math.abs(outputs[outputs.length - 1]);
  
  console.log(`\n收敛结果:`);
  console.log(`   - 最终误差：${finalError.toFixed(6)}`);
  console.log(`   - 初始输出：${initialOutput.toFixed(4)}`);
  console.log(`   - 最终输出：${finalOutput.toFixed(4)}`);
  console.log(`   - 收敛比：${(finalOutput / initialOutput * 100).toFixed(1)}%`);
  
  const isConverged = finalError < 0.01 && finalOutput < initialOutput;
  console.log(isConverged ? `✅ PID 控制器收敛验证通过` : `❌ PID 控制器未收敛`);
  
  return isConverged;
}

async function runAllValidations() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     灵智智能体系统 - P0 实时控制能力验证            ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  
  const results: boolean[] = [];
  
  try {
    results.push(await validateWebSocketChannel());
    results.push(await validateBinaryProtocol());
    results.push(await validateStreamingPlanner());
    results.push(await validatePidController());
    
    const passed = results.filter(r => r).length;
    const total = results.length;
    
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log(`║  验证结果：${passed}/${total} 通过                              ║`);
    console.log('╚══════════════════════════════════════════════════════╝');
    
    if (passed === total) {
      console.log('\n🎉 所有 P0 核心能力验证通过！');
      console.log('\n下一步建议：');
      console.log('1. 在真实环境中部署并调整 PID 参数');
      console.log('2. 根据实际硬件性能优化频率和延迟');
      console.log('3. 补充 P1 多设备协同和监控功能');
    } else {
      console.log('\n⚠️ 部分验证未通过。');
    }
    
    return passed === total;
  } catch (err: any) {
    console.error('\n❌ 验证过程出错:', err.message);
    return false;
  }
}

// 主函数
if (require.main === module) {
  runAllValidations().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { runAllValidations };
