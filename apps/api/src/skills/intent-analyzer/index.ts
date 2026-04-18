/**
 * Built-in Skill: Intent Analyzer
 * 
 * 意图分析引擎 - 将用户自然语言输入分类为不同意图类型，
 * 并推荐相应的工具调用建议。
 * 
 * 支持的意图类型:
 * - chat: 闲聊/问答（无需工具调用）
 * - ui: 界面生成（推荐 nl2ui.generate）
 * - query: 数据查询（推荐 entity.read 等）
 * - task: 任务执行（推荐 workflow/approval 工具）
 * - collab: 多智能体协作（推荐 collab.* 工具）
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { intentAnalyzerRoutes } from "./routes";
import { detectIntentByRules } from "./modules/analyzer";
import { registerIntentRuleDetector } from "../../kernel/intentRuleEngineContract";

// 注册规则引擎到 kernel 契约，供 orchestrator 等消费方跨 skill 使用
registerIntentRuleDetector(detectIntentByRules);

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "intent.analyzer", version: "1.0.0" },
    routes: ["/intent"],
    dependencies: ["audit", "rbac", "memory"],
    tools: [
      {
        name: "intent.analyze",
        displayName: { "zh-CN": "意图分析", "en-US": "Intent Analysis" },
        description: { 
          "zh-CN": "分析用户输入的自然语言意图，返回意图类型、置信度和推荐的工具调用建议", 
          "en-US": "Analyze user's natural language intent and return intent type, confidence, and recommended tool suggestions" 
        },
        scope: "read",
        resourceType: "intent",
        action: "analyze",
        riskLevel: "low",
        inputSchema: { 
          fields: { 
            message: { type: "string", required: true, description: "用户输入的自然语言消息" },
            context: { 
              type: "json", 
              required: false, 
              description: "对话上下文，包含 userId, tenantId, spaceId, conversationHistory 等" 
            },
          } 
        },
        outputSchema: { 
          fields: { 
            intent: { type: "string", enum: ["chat", "ui", "query", "task", "collab"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reasoning: { type: "string", description: "意图判断的推理过程" },
            suggestedTools: { 
              type: "array", 
              items: {
                type: "object",
                properties: {
                  toolRef: { type: "string" },
                  inputDraft: { type: "json" },
                  confidence: { type: "number" }
                }
              }
            },
            requiresConfirmation: { type: "boolean", description: "是否需要用户确认后再执行" }
          } 
        },
      },
    ],
  },
  routes: intentAnalyzerRoutes,
};

export default plugin;
