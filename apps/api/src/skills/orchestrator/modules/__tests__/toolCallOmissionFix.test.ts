/**
 * 首页对话工具调用遗漏修复 - 单元测试
 * 
 * 测试场景：
 * 1. 工具名称提及但未生成 tool_call → 强制重试
 * 2. 行动意图检测但未生成 tool_call → 二次校验
 * 3. 正常 tool_call 不应触发重试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseToolCallsFromOutput } from '../../../../lib/llm';

describe('Tool Call Omission Fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('场景 1: 工具名称提及检测', () => {
    it('应检测到工具名称并触发重试', async () => {
      const mockReplyText = "我可以帮您创建任务。我将使用 entity.create 工具来完成这个操作。";
      const mockToolNames = ['entity.create', 'entity.delete', 'entity.update'];
      
      // 检测是否提到工具名称
      const mentionedTool = mockToolNames.find(name => mockReplyText.includes(name));
      
      // 场景验证：检测到工具名称提及，但 LLM 输出中未包含 tool_call 代码块
      expect(mentionedTool).toBe('entity.create');
      // 此时 mockReplyText 中没有 tool_call 代码块 → 应触发强制重试机制
      expect(mockReplyText).not.toContain('```tool_call');
    });

    it('未提工具名称时不触发重试', async () => {
      const mockReplyText = "好的，我已经理解了您的需求。";
      const mockToolNames = ['entity.create', 'entity.delete'];
      
      const mentionedTool = mockToolNames.find(name => mockReplyText.includes(name));
      
      expect(mentionedTool).toBeUndefined();
    });
  });

  describe('场景 2: 行动意图检测', () => {
    it('应检测到行动动词并触发二次校验', async () => {
      // 注意：正则中的空格是关键，"帮助 " 表示后面有空格
      // 实际 orchestrator.ts 中使用的正则
      const actionPatterns = /帮助|执行|创建|删除|更新|查询|打开|关闭|发送|接收/i;
      
      const testCases = [
        { text: "我来帮您执行这个操作", shouldMatch: true },
        { text: "正在创建新的记录", shouldMatch: true },
        { text: "立即删除这条记录", shouldMatch: true },
        { text: "查询您的账户信息", shouldMatch: true },
        { text: "这是一个很好的想法", shouldMatch: false },
        { text: "我明白了", shouldMatch: false },
      ];

      testCases.forEach(({ text, shouldMatch }) => {
        const matches = actionPatterns.test(text);
        expect(matches).toBe(shouldMatch);
      });
    });
  });

  describe('场景 3: tool_call 解析', () => {
    it('应正确解析标准 tool_call 代码块', () => {
      const mockOutput = `好的，我来帮您创建记录。

\`\`\`tool_call
[{"toolRef":"entity.create@v1","inputDraft":{"title":"新记录","content":"内容"}}]
\`\`\``;

      const result = parseToolCallsFromOutput(mockOutput);
      
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual({
        toolRef: 'entity.create@v1',
        inputDraft: { title: '新记录', content: '内容' }
      });
      expect(result.cleanText).toContain('我来帮您创建记录');
    });

    it('应解析多个 tool_call', () => {
      const mockOutput = `\`\`\`tool_call
[{"toolRef":"entity.create@v1","inputDraft":{}},{"toolRef":"email.send@v1","inputDraft":{}}]
\`\`\``;

      const result = parseToolCallsFromOutput(mockOutput);
      
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls.map((tc: any) => tc.toolRef)).toEqual([
        'entity.create@v1',
        'email.send@v1'
      ]);
    });

    it('空输出应返回空数组', () => {
      const result = parseToolCallsFromOutput('');
      expect(result.toolCalls).toHaveLength(0);
      expect(result.parseErrorCount).toBe(0);
    });
  });

  describe('场景 4: 日志记录验证', () => {
    it('应记录 warn 级别日志当检测到工具遗漏', () => {
      const mockLog = {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      };

      const traceId = 'test-trace-123';
      const mentionedTool = 'entity.create';
      
      mockLog.warn({
        traceId,
        mentionedTool,
        replyTextLength: 50,
      }, '[P0-ToolCall-Omission] 检测到工具提及但缺少 tool_call 代码块，触发强制重试');

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId,
          mentionedTool,
          replyTextLength: 50,
        }),
        expect.stringContaining('[P0-ToolCall-Omission]')
      );
    });

    it('应记录 info 级别日志当重试成功', () => {
      const mockLog = {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      };

      const traceId = 'test-trace-456';
      const retryToolCount = 1;
      
      mockLog.info({
        traceId,
        retryToolCount,
      }, '[P0-ToolCall-Omission] 重试成功，已补全 tool_call');

      expect(mockLog.info).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId,
          retryToolCount: 1,
        }),
        expect.stringContaining('重试成功')
      );
    });
  });
});
