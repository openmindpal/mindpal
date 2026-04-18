import type { FastifyPluginAsync } from "fastify";
import { Errors } from "../../lib/errors";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { analyzeIntent } from "./modules/analyzer";
import { intentAnalyzeRequestSchema } from "./modules/types";

/**
 * Intent Analyzer Routes - 意图分析 API
 */
export const intentAnalyzerRoutes: FastifyPluginAsync = async (app) => {
  
  /**
   * POST /intent/analyze
   * 分析用户输入的意图
   */
  app.post("/intent/analyze", async (req, reply) => {
    // 审计上下文 + 权限检查
    setAuditContext(req, { resourceType: "intent", action: "analyze" });
    req.ctx.audit!.policyDecision = await requirePermission({ 
      req, 
      resourceType: "intent", 
      action: "analyze" 
    });
    
    const subject = req.ctx.subject!;
    
    // 验证请求
    const request = intentAnalyzeRequestSchema.parse(req.body);
    
    const startedAt = Date.now();
    
    try {
      // 调用分析器
      const result = await analyzeIntent(app.db, {
        message: request.message,
        context: request.context ? {
          ...request.context,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId || request.context.spaceId,
          userId: subject.subjectId || request.context.userId,
        } : {
          tenantId: subject.tenantId,
          spaceId: subject.spaceId || undefined,
          userId: subject.subjectId || "anonymous",
        },
      }, { app });

      const latencyMs = Date.now() - startedAt;
      const usedLLM = !!result.metadata?.modelUsed;
      
      // P3-1: 记录意图分析指标
      app.metrics.observeIntentAnalysis({
        result: "ok",
        latencyMs,
        usedLLM,
      });

      // P3-4: 桥接统一意图路由指标，确保 intent-analyzer 产生的数据也流入 observeIntentRoute 漏斗
      app.metrics.observeIntentRoute({
        source: "dispatch" as any,  // 复用 dispatch 源以统一指标
        classifier: usedLLM ? "llm" as any : "fast" as any,
        mode: result.intent === "chat" ? "answer" : result.intent === "task" ? "execute" : result.intent as any,
        confidence: result.confidence,
        result: "ok",
        latencyMs,
      });

      // 审计日志
      req.ctx.audit!.outputDigest = {
        intent: result.intent,
        confidence: result.confidence,
        suggestedToolsCount: result.suggestedTools.length,
      };

      return {
        success: true,
        data: result,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startedAt;
      app.log.error({ err: err?.message, traceId: req.ctx.traceId }, "[intent-analyzer] 分析失败");
      
      // P3-1: 记录错误指标
      app.metrics.observeIntentAnalysis({
        result: "error",
        latencyMs,
        usedLLM: false,
      });
      
      throw Errors.internal();
    }
  });

  /**
   * GET /intent/capabilities
   * 查询意图分析能力说明
   */
  app.get("/intent/capabilities", async (req) => {
    req.ctx.audit!.policyDecision = await requirePermission({ 
      req, 
      resourceType: "intent", 
      action: "read" 
    });

    return {
      supportedIntents: ["chat", "ui", "query", "task", "collab"],
      description: {
        "zh-CN": "意图分析引擎支持 5 种意图类型识别，并提供工具调用建议",
        "en-US": "Intent analyzer supports 5 intent types and provides tool suggestions",
      },
      confidenceThresholds: {
        HIGH: 0.8,
        MEDIUM: 0.6,
        LOW: 0.4,
      },
    };
  });
};
