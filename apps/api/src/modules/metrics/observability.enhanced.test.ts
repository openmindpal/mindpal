/**
 * P3-1: 可观测性增强 - 核心Skill指标埋点测试
 * 
 * 验证点：
 * 1. Intent Analyzer 指标埋点正确性
 * 2. Orchestrator 指标埋点正确性
 * 3. Device Runtime 指标埋点正确性
 * 4. Prometheus 格式输出正确性
 * 5. 指标累加和直方图统计正确性
 */

import { describe, expect, it, beforeEach } from "vitest";
import { createMetricsRegistry } from "./metrics";

describe("P3-1: Observability Enhancement - Core Skill Metrics", () => {
  
  let metrics: ReturnType<typeof createMetricsRegistry>;

  beforeEach(() => {
    metrics = createMetricsRegistry();
  });

  describe("Intent Analyzer Metrics", () => {
    
    it("应该记录规则匹配指标", () => {
      metrics.incIntentRuleMatch({
        ruleId: "nl2ui_display",
        confidence: "high",
      });

      metrics.incIntentRuleMatch({
        ruleId: "nl2ui_display",
        confidence: "medium",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain("openslin_intent_rule_matches_total");
      expect(output).toContain('rule_id="nl2ui_display"');
      expect(output).toContain('confidence="high"');
      expect(output).toContain('confidence="medium"');
    });
  });

  describe("Orchestrator Metrics", () => {
    
    it("应该记录 Orchestrator 执行成功指标", () => {
      metrics.observeOrchestratorExecution({
        result: "ok",
        latencyMs: 200,
        toolType: "memory.read",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain("openslin_orchestrator_execution_total");
      expect(output).toContain('result="ok"');
      expect(output).toContain('tool_type="memory.read"');
    });

    it("应该记录安全拒绝指标", () => {
      metrics.observeOrchestratorExecution({
        result: "denied",
        latencyMs: 15,
        toolType: "data.export",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain('result="denied"');
      expect(output).toContain('tool_type="data.export"');
    });

    it("应该记录超时指标", () => {
      metrics.observeOrchestratorExecution({
        result: "timeout",
        latencyMs: 30000,
        toolType: "external.api",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain('result="timeout"');
    });

    it("应该在 toolType 缺失时使用 unknown", () => {
      metrics.observeOrchestratorExecution({
        result: "ok",
        latencyMs: 100,
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain('tool_type="unknown"');
    });

    it("应该记录工具调用指标", () => {
      metrics.incOrchestratorToolCall({
        toolRef: "builtin:memory.read",
        result: "success",
      });

      metrics.incOrchestratorToolCall({
        toolRef: "builtin:memory.read",
        result: "failed",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain("openslin_orchestrator_tool_calls_total");
      expect(output).toContain('tool_ref="builtin:memory.read"');
      expect(output).toContain('result="success"');
      expect(output).toContain('result="failed"');
    });

    it("应该设置活跃运行数指标", () => {
      metrics.setOrchestratorActiveRuns({ count: 15 });

      const output = metrics.renderPrometheus();
      expect(output).toContain("openslin_orchestrator_active_runs");
      expect(output).toMatch(/openslin_orchestrator_active_runs\s+15/);
    });

    it("应该生成正确的执行时长直方图", () => {
      // 模拟不同延迟的执行
      [10, 50, 100, 250, 500, 1000, 2500, 5000].forEach((latency) => {
        metrics.observeOrchestratorExecution({
          result: "ok",
          latencyMs: latency,
          toolType: "test.tool",
        });
      });

      const output = metrics.renderPrometheus();
      
      // 验证直方图结构
      expect(output).toContain("openslin_orchestrator_execution_duration_ms_bucket");
      expect(output).toContain("le=");
      expect(output).toContain("+Inf");
    });
  });

  describe("Device Runtime Metrics", () => {
    
    it("应该记录设备执行成功指标", () => {
      metrics.observeDeviceExecution({
        result: "ok",
        latencyMs: 150,
        deviceType: "mobile",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain("openslin_device_execution_total");
      expect(output).toContain('result="ok"');
      expect(output).toContain('device_type="mobile"');
    });

    it("应该记录设备执行超时指标", () => {
      metrics.observeDeviceExecution({
        result: "timeout",
        latencyMs: 60000,
        deviceType: "desktop",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain('result="timeout"');
      expect(output).toContain('device_type="desktop"');
    });

    it("应该在 deviceType 缺失时使用 unknown", () => {
      metrics.observeDeviceExecution({
        result: "ok",
        latencyMs: 100,
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain('device_type="unknown"');
    });

    it("应该记录设备消息指标", () => {
      metrics.incDeviceMessage({
        category: "task_notification",
        result: "delivered",
      });

      metrics.incDeviceMessage({
        category: "state_sync",
        result: "failed",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain("openslin_device_messages_total");
      expect(output).toContain('category="task_notification"');
      expect(output).toContain('result="delivered"');
      expect(output).toContain('category="state_sync"');
      expect(output).toContain('result="failed"');
    });

    it("应该设置连接客户端数指标", () => {
      metrics.setDeviceConnectedClients({ count: 42 });

      const output = metrics.renderPrometheus();
      expect(output).toContain("openslin_device_connected_clients");
      expect(output).toMatch(/openslin_device_connected_clients\s+42/);
    });

    it("应该记录跨设备总线推送指标", () => {
      metrics.incDevicePushNotification({
        method: "cross_device_bus",
        result: "ok",
      });

      metrics.incDevicePushNotification({
        method: "local_ws",
        result: "ok",
      });

      metrics.incDevicePushNotification({
        method: "cross_device_bus",
        result: "failed",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain("openslin_device_push_notifications_total");
      expect(output).toContain('method="cross_device_bus"');
      expect(output).toContain('method="local_ws"');
      expect(output).toContain('result="ok"');
      expect(output).toContain('result="failed"');
    });

    it("应该生成分布式推送成功率指标", () => {
      // 模拟 90% 成功率
      for (let i = 0; i < 90; i++) {
        metrics.incDevicePushNotification({
          method: "cross_device_bus",
          result: "ok",
        });
      }
      for (let i = 0; i < 10; i++) {
        metrics.incDevicePushNotification({
          method: "cross_device_bus",
          result: "failed",
        });
      }

      const output = metrics.renderPrometheus();
      expect(output).toMatch(/openslin_device_push_notifications_total.*method="cross_device_bus".*result="ok".*\s+90/);
      expect(output).toMatch(/openslin_device_push_notifications_total.*method="cross_device_bus".*result="failed".*\s+10/);
    });
  });

  describe("Metric Aggregation", () => {
    
    it("相同标签的计数器应该累加", () => {
      metrics.observeIntentRoute({
        source: "dispatch",
        classifier: "fast",
        mode: "chat",
        confidence: 0.9,
        result: "ok",
        latencyMs: 10,
      });

      metrics.observeIntentRoute({
        source: "dispatch",
        classifier: "fast",
        mode: "chat",
        confidence: 0.8,
        result: "ok",
        latencyMs: 20,
      });

      metrics.observeIntentRoute({
        source: "dispatch",
        classifier: "fast",
        mode: "chat",
        confidence: 0.7,
        result: "ok",
        latencyMs: 30,
      });

      const output = metrics.renderPrometheus();
      
      // counter 应该是 3
      expect(output).toMatch(/openslin_orchestrator_intent_route_total.*result="ok".*source="dispatch".*\s+3/);
    });

    it("不同标签的计数器应该分开计数", () => {
      metrics.observeIntentRoute({
        source: "dispatch",
        classifier: "fast",
        mode: "chat",
        confidence: 0.9,
        result: "ok",
        latencyMs: 10,
      });

      metrics.observeIntentRoute({
        source: "dispatch",
        classifier: "llm",
        mode: "task",
        confidence: 0.8,
        result: "ok",
        latencyMs: 100,
      });

      const output = metrics.renderPrometheus();
      
      // 应该有两条不同的记录
      expect(output).toMatch(/openslin_orchestrator_intent_route_total.*classifier="fast".*\s+1/);
      expect(output).toMatch(/openslin_orchestrator_intent_route_total.*classifier="llm".*\s+1/);
    });

    it("Gauge 应该更新为最新值", () => {
      metrics.setDeviceConnectedClients({ count: 10 });
      metrics.setDeviceConnectedClients({ count: 25 });
      metrics.setDeviceConnectedClients({ count: 18 });

      const output = metrics.renderPrometheus();
      
      // 应该是最新值 18
      expect(output).toMatch(/openslin_device_connected_clients\s+18/);
    });

    it("Histogram 应该正确累加 count 和 sum", () => {
      [10, 20, 30, 40, 50].forEach((latency) => {
        metrics.observeOrchestratorExecution({
          result: "ok",
          latencyMs: latency,
          toolType: "test",
        });
      });

      const output = metrics.renderPrometheus();
      
      // count 应该是 5
      expect(output).toMatch(/openslin_orchestrator_execution_duration_ms_count.*\{[^}]*\}\s+5/);
      
      // sum 应该是 150 (10+20+30+40+50)
      expect(output).toMatch(/openslin_orchestrator_execution_duration_ms_sum.*\{[^}]*\}\s+150\.000/);
    });
  });

  describe("Prometheus Format Compliance", () => {
    
    it("应该包含所有必需的 HELP 注释", () => {
      metrics.observeIntentRoute({
        source: "dispatch",
        classifier: "fast",
        mode: "chat",
        confidence: 0.9,
        result: "ok",
        latencyMs: 50,
      });

      const output = metrics.renderPrometheus();
      
      expect(output).toContain("# HELP openslin_orchestrator_intent_route_total");
      expect(output).toContain("# TYPE openslin_orchestrator_intent_route_total counter");
      expect(output).toContain("# HELP openslin_orchestrator_intent_route_duration_ms");
      expect(output).toContain("# TYPE openslin_orchestrator_intent_route_duration_ms histogram");
    });

    it("应该包含所有新指标的 HELP 注释", () => {
      metrics.observeOrchestratorExecution({
        result: "ok",
        latencyMs: 100,
        toolType: "test",
      });

      metrics.observeDeviceExecution({
        result: "ok",
        latencyMs: 100,
        deviceType: "test",
      });

      const output = metrics.renderPrometheus();
      
      // Orchestrator 指标
      expect(output).toContain("# HELP openslin_orchestrator_execution_total");
      expect(output).toContain("# HELP openslin_orchestrator_tool_calls_total");
      expect(output).toContain("# HELP openslin_orchestrator_active_runs");
      
      // Device 指标
      expect(output).toContain("# HELP openslin_device_execution_total");
      expect(output).toContain("# HELP openslin_device_messages_total");
      expect(output).toContain("# HELP openslin_device_connected_clients");
      expect(output).toContain("# HELP openslin_device_push_notifications_total");
    });

    it("标签值应该正确转义", () => {
      metrics.observeOrchestratorExecution({
        result: "ok",
        latencyMs: 100,
        toolType: 'test"tool',
      });

      const output = metrics.renderPrometheus();
      
      // 双引号应该被转义
      expect(output).toContain('tool_type="test\\"tool"');
    });

    it("每行应该以换行符结尾", () => {
      metrics.observeIntentRoute({
        source: "dispatch",
        classifier: "fast",
        mode: "chat",
        confidence: 0.9,
        result: "ok",
        latencyMs: 50,
      });

      const output = metrics.renderPrometheus();
      
      expect(output.endsWith("\n")).toBe(true);
    });
  });

  describe("Performance", () => {
    
    it("指标记录应该在微秒级完成", () => {
      const iterations = 10000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        metrics.observeIntentRoute({
          source: "dispatch",
          classifier: i % 2 === 0 ? "fast" : "llm",
          mode: "chat",
          confidence: Math.random(),
          result: "ok",
          latencyMs: Math.random() * 100,
        });
      }

      const duration = Date.now() - start;
      const avgTime = duration / iterations;

      expect(avgTime).toBeLessThan(0.1); // 平均每次 < 0.1ms
      console.log(`Metric recording: ${avgTime.toFixed(4)}ms per operation (${iterations} iterations)`);
    });

    it("大量指标不应该影响渲染性能", () => {
      // 添加 1000 个不同的指标
      for (let i = 0; i < 1000; i++) {
        metrics.observeOrchestratorExecution({
          result: i % 3 === 0 ? "ok" : i % 3 === 1 ? "denied" : "error",
          latencyMs: Math.random() * 1000,
          toolType: `tool.${i % 10}`,
        });
      }

      const start = Date.now();
      const output = metrics.renderPrometheus();
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100); // 渲染 < 100ms
      expect(output.length).toBeGreaterThan(10000); // 输出应该有足够的内容
      console.log(`Prometheus rendering: ${duration}ms for 1000 metrics`);
    });
  });

  describe("Edge Cases", () => {
    
    it("应该处理零延迟", () => {
      metrics.observeIntentRoute({
        source: "dispatch",
        classifier: "fast",
        mode: "chat",
        confidence: 0.9,
        result: "ok",
        latencyMs: 0,
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain("openslin_orchestrator_intent_route_total");
    });

    it("应该处理极大延迟", () => {
      metrics.observeDeviceExecution({
        result: "timeout",
        latencyMs: 300000, // 5分钟
        deviceType: "slow_device",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain("openslin_device_execution_total");
      expect(output).toContain('result="timeout"');
    });

    it("空字符串标签应该被正确处理", () => {
      metrics.observeOrchestratorExecution({
        result: "ok",
        latencyMs: 100,
        toolType: "",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain('tool_type=""');
    });

    it("特殊字符标签应该被正确转义", () => {
      metrics.incDeviceMessage({
        category: "test\nwith\nnewlines",
        result: "delivered",
      });

      const output = metrics.renderPrometheus();
      expect(output).toContain("test\\nwith\\nnewlines");
    });
  });
});
