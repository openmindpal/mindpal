/**
 * Intent Integration Helper - 意图分析集成辅助函数
 * 
 * 用于 orchestrator 和其他模块调用 intent.analyze skill
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { analyzeIntent } from "../../intent-analyzer/modules/analyzer";
import { intentTypeToMode, type IntentMode, type IntentType } from "./intentClassifier";

export interface IntentAnalysisResult {
  /** intent-analyzer 原始输出 */
  intent: IntentType;
  /** 转换后的编排层 mode，可直接用于 dispatch 路由 */
  mode: IntentMode;
  confidence: number;
  suggestedTools: Array<{
    toolRef: string;
    inputDraft: Record<string, any>;
    confidence: number;
  }>;
  requiresConfirmation: boolean;
}

/**
 * 调用 intent.analyze skill 分析用户意图
 * 
 * @param pool 数据库连接池
 * @param message 用户消息
 * @param subject 主体信息
 * @param app Fastify 实例
 * @returns 意图分析结果
 */
export async function analyzeUserIntent(
  pool: Pool,
  message: string,
  subject: { tenantId: string; spaceId?: string | null; subjectId?: string | null },
  app: FastifyInstance
): Promise<IntentAnalysisResult | null> {
  try {
    // 直接调用 intent analyzer 核心函数
    const result = await analyzeIntent(pool, {
      message,
      context: {
        userId: subject.subjectId || "anonymous",
        tenantId: subject.tenantId,
        spaceId: subject.spaceId || undefined,
      },
    }, { app });
    
    return {
      intent: result.intent as IntentType,
      mode: intentTypeToMode(result.intent as IntentType),
      confidence: result.confidence,
      suggestedTools: result.suggestedTools || [],
      requiresConfirmation: result.requiresConfirmation || false,
    };
  } catch (err: any) {
    app.log.error({ err: err?.message, message: message.slice(0, 50) }, "[intent-integration] 意图分析失败");
    return null;
  }
}

/**
 * 从预生成的 toolSuggestions 中分离 NL2UI 和其他工具。
 * 当前被 dispatch.handleExecute 活跃调用，请勿删除。
 */
export function separateToolSuggestions(prebuiltSuggestions: Array<{ toolRef: string; inputDraft?: any }>) {
  const nl2uiSuggestions = prebuiltSuggestions.filter(s => s.toolRef.startsWith("nl2ui.generate"));
  const workerSuggestions = prebuiltSuggestions.filter(s => !s.toolRef.startsWith("nl2ui.generate"));
  return { nl2uiSuggestions, workerSuggestions };
}
