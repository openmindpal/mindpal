/**
 * P0核心修改验证测试
 * 测试结构化摘要解析、实体提取、事件驱动触发
 */

import { describe, it, expect } from 'vitest';
import { parseStructuredSummary, extractEntities, shouldTriggerEventDrivenSummary } from '../orchestrator';

describe('P0: 结构化上下文增强', () => {
  describe('parseStructuredSummary', () => {
    it('应正确解析JSON代码块', () => {
      const input = '```json\n{"activeTopic":"审批流程优化","summary":"测试摘要"}\n```';
      const result = parseStructuredSummary(input);
      
      expect(result.structured).not.toBeNull();
      expect(result.structured?.activeTopic).toBe('审批流程优化');
      expect(result.summary).toBe('测试摘要');
    });

    it('应解析直接JSON', () => {
      const input = '{"activeTopic":"测试","summary":"摘要内容"}';
      const result = parseStructuredSummary(input);
      
      expect(result.structured).not.toBeNull();
      expect(result.summary).toBe('摘要内容');
    });

    it('JSON解析失败时应降级为自由文本', () => {
      const input = '这是一个普通的摘要文本';
      const result = parseStructuredSummary(input);
      
      expect(result.structured).toBeNull();
      expect(result.summary).toBe('这是一个普通的摘要文本');
    });
  });

  describe('extractEntities', () => {
    it('应提取引号中的实体', () => {
      const entities = extractEntities('讨论"XX项目"的审批流程');
      expect(entities).toContain('XX项目');
    });

    it('应提取书名号中的实体', () => {
      const entities = extractEntities('《智慧城市》管理系统');
      expect(entities).toContain('智慧城市');
    });

    it('应限制最多10个实体', () => {
      const input = '"项目1" "项目2" "项目3" "项目4" "项目5" "项目6" "项目7" "项目8" "项目9" "项目10" "项目11"';
      const entities = extractEntities(input);
      expect(entities.length).toBeLessThanOrEqual(10);
    });
  });

  describe('shouldTriggerEventDrivenSummary', () => {
    it('应检测话题切换关键词', () => {
      const result = shouldTriggerEventDrivenSummary('换个话题，说回之前的项目', 5);
      expect(result.should).toBe(true);
      expect(result.reason).toBe('topic_switch');
    });

    it('应检测结论输出关键词', () => {
      const result = shouldTriggerEventDrivenSummary('总结一下刚才的讨论', 10);
      expect(result.should).toBe(true);
      expect(result.reason).toBe('conclusion');
    });

    it('应检测任务定稿关键词', () => {
      const result = shouldTriggerEventDrivenSummary('定稿，就这样吧', 8);
      expect(result.should).toBe(true);
      expect(result.reason).toBe('finalization');
    });

    it('应检测列清单关键词', () => {
      const result = shouldTriggerEventDrivenSummary('列个清单出来', 6);
      expect(result.should).toBe(true);
      expect(result.reason).toBe('listing');
    });

    it('应检测回指引用关键词', () => {
      const result = shouldTriggerEventDrivenSummary('按前面的方式继续', 12);
      expect(result.should).toBe(true);
      expect(result.reason).toBe('reference');
    });

    it('应每10轮定期触发', () => {
      const result = shouldTriggerEventDrivenSummary('普通消息', 20);
      expect(result.should).toBe(true);
      expect(result.reason).toBe('periodic_10');
    });

    it('长消息应触发摘要', () => {
      // 生成超过500字符的消息
      const longMessage = '这是一条很长的消息，包含了很多复杂的决策和讨论内容，需要系统仔细分析和理解用户的意图，以便提供更好的服务和支持。用户提到了关于项目管理的多个方面，包括任务分配、进度跟踪、团队协作等重要议题。'.repeat(3);
      expect(longMessage.length).toBeGreaterThan(500);
      
      const result = shouldTriggerEventDrivenSummary(longMessage, 8);
      expect(result.should).toBe(true);
      expect(result.reason).toBe('long_message');
    });

    it('普通短消息不应触发', () => {
      const result = shouldTriggerEventDrivenSummary('你好', 3);
      expect(result.should).toBe(false);
    });
  });
});
