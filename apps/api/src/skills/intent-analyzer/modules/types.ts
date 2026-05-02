import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "api:intentAnalyzerTypes" });

/**
 * Intent Analyzer - 意图分析类型定义
 */

// ─── Intent Types ──────────────────────────────────────────────────────

export type IntentType = "chat" | "ui" | "query" | "task" | "collab";

export const INTENT_TYPES: IntentType[] = ["chat", "ui", "query", "task", "collab"];

// ─── Request Schema ────────────────────────────────────────────────────

export const intentAnalyzeRequestSchema = z.object({
  message: z.string().min(1).describe("用户输入的自然语言消息"), // 与 dispatch.schema.ts 对齐，移除输入字数限制，支持大模型长上下文
  context: z.object({
    userId: z.string().optional(),
    tenantId: z.string(),
    spaceId: z.string().optional(),
    conversationId: z.string().optional(),
    conversationHistory: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    })).optional().describe("最近 5 轮对话历史"),
    availableTools: z.array(z.string()).optional().describe("当前空间可用的工具列表"),
  }).optional(),
});

export type IntentAnalyzeRequest = z.infer<typeof intentAnalyzeRequestSchema>;

// ─── Tool Suggestion Schema ────────────────────────────────────────────

export const toolSuggestionSchema = z.object({
  toolRef: z.string().describe("工具引用，如 entity.read@1.0"),
  inputDraft: z.record(z.string(), z.any()).describe("工具输入草稿"),
  confidence: z.number().min(0).max(1).describe("该工具推荐的置信度"),
  reasoning: z.string().optional().describe("推荐该工具的推理过程"),
});

export type ToolSuggestion = z.infer<typeof toolSuggestionSchema>;

// ─── Response Schema ───────────────────────────────────────────────────

export const intentAnalyzeResponseSchema = z.object({
  intent: z.enum(INTENT_TYPES).describe("识别的意图类型"),
  confidence: z.number().min(0).max(1).describe("意图识别置信度"),
  reasoning: z.string().describe("意图判断的推理过程"),
  suggestedTools: z.array(toolSuggestionSchema).describe("推荐的工具调用建议"),
  requiresConfirmation: z.boolean().describe("是否需要用户确认后再执行（写操作通常为 true）"),
  metadata: z.object({
    analyzedAt: z.string().datetime().describe("分析时间 ISO 8601"),
    modelUsed: z.string().optional().describe("使用的 LLM 模型（如有）"),
    processingTimeMs: z.number().optional().describe("处理耗时毫秒"),
  }).optional(),
});

export type IntentAnalyzeResponse = z.infer<typeof intentAnalyzeResponseSchema>;

// ─── Intent Detection Keywords (Rule-based fallback) ───────────────────

// P3-5 / P0-6: 关键词可配置化——优先从 JSON 配置文件加载，失败时回退到编译时默认值
const _BUILTIN_INTENT_KEYWORDS: Record<IntentType, string[]> = {
  ui: [
    "显示", "展示", "界面", "页面", "dashboard", "看板", "图表", "可视化",
    "生成页面", "创建界面", "ui", "view", "page", "layout",
  ],
  query: [
    "查询", "查找", "搜索", "查看", "列出", "统计", "汇总",
    "query", "search", "find", "list", "count", "get",
  ],
  task: [
    "执行", "运行", "创建", "更新", "删除", "审批", "提交",
    "execute", "run", "create", "update", "delete", "approve", "submit",
  ],
  collab: [
    "协作", "讨论", "辩论", "多智能体", "团队", "分配",
    "collaborate", "discuss", "debate", "assign", "team",
  ],
  chat: [],
};

/**
 * P3-5: 尝试从配置 JSON 文件加载 intent-analyzer 关键词
 * 支持 env: INTENT_ANALYZER_KEYWORDS_PATH
 * JSON 结构: { "ui": [...], "query": [...], ... }
 */
function _loadIntentKeywords(): Record<IntentType, string[]> {
  try {
    const cfgPath = process.env.INTENT_ANALYZER_KEYWORDS_PATH
      || path.resolve(__dirname, "intent-keywords.json");
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      // 合并: 配置文件中有的类型覆盖默认值，没有的保留内置默认
      const merged = { ..._BUILTIN_INTENT_KEYWORDS };
      for (const key of Object.keys(merged) as IntentType[]) {
        if (Array.isArray(parsed[key]) && parsed[key].length > 0) {
          merged[key] = parsed[key];
        }
      }
      return merged;
    }
  } catch (err) {
    _logger.warn("failed to load keywords config", { error: (err as Error)?.message });
  }
  return _BUILTIN_INTENT_KEYWORDS;
}

export const INTENT_KEYWORDS: Record<IntentType, string[]> = _loadIntentKeywords();

// ─── Confidence Thresholds ─────────────────────────────────────────────

export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.8,    // 高置信度，可直接执行
  MEDIUM: 0.6,  // 中等置信度，建议确认
  LOW: 0.4,     // 低置信度，需要用户澄清
};
