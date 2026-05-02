/**
 * Dispatch — Classify Route
 *
 * POST /orchestrator/dispatch/classify — 仅分类不执行
 */
import { z } from "zod";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { PERM } from "@mindpal/shared";
import {
  classifyIntentFast,
  classifyIntentTwoLevel,
  intentDecisionToClassification,
  reviewIntentDecision,
  type IntentMode,
  type IntentClassification,
} from "./modules/intentClassifier";

export function registerClassifyRoute(app: any): void {
  app.post("/orchestrator/dispatch/classify", async (req: any) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "classify" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_TURN });

    const subject = requireSubject(req);
    const body = z.object({
      message: z.string().min(1), // P2-2 FIX: 移除输入字数限制，支持大模型长上下文
      mode: z.enum(["auto", "answer", "execute", "collab"]).optional(),
      fastClassify: z.boolean().optional(),
      activeRunContext: z.object({
        runId: z.string().min(1),
        taskId: z.string().min(1),
        taskTitle: z.string().optional(),
        phase: z.string().optional(),
      }).optional(),
    }).parse(req.body);

    const explicitMode = body.mode === "auto" ? undefined : body.mode as IntentMode | undefined;

    let classification: IntentClassification;
    const classifyStartMs = Date.now();
    const useFast = !!body.fastClassify;
    if (useFast) {
      classification = classifyIntentFast(body.message, explicitMode)
        ?? { mode: "answer" as IntentMode, confidence: 0.5, reason: "fast_no_match", needsTask: false, needsApproval: false, complexity: "simple" as const };
    } else {
      const classifyParams = {
        pool: app.db,
        app,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? "",
        subjectId: subject.subjectId,
        message: body.message,
        explicitMode,
        locale: req.ctx.locale,
        authorization: (req.headers.authorization as string | undefined) ?? null,
        traceId: req.ctx.traceId,
        activeRunContext: body.activeRunContext ? {
          runId: body.activeRunContext.runId,
          taskId: body.activeRunContext.taskId,
          taskTitle: body.activeRunContext.taskTitle ?? "",
          phase: body.activeRunContext.phase ?? "",
        } : undefined,
      };
      classification = intentDecisionToClassification(
        await reviewIntentDecision(classifyParams, await classifyIntentTwoLevel(classifyParams)),
      );
    }
    const classifyLatencyMs = Date.now() - classifyStartMs;

    // P0-1: 统一意图路由指标
    app.metrics.observeIntentRoute({
      source: "dispatch.classify",
      classifier: useFast ? "fast" : "reviewer",
      mode: classification.mode,
      confidence: classification.confidence,
      result: "ok",
      latencyMs: classifyLatencyMs,
    });
    if (classification.reason) {
      const cBand = classification.confidence >= 0.85 ? "high" : classification.confidence >= 0.65 ? "medium" : "low";
      app.metrics.incIntentRuleMatch({ ruleId: classification.reason, confidence: cBand });
    }

    req.ctx.audit!.outputDigest = { classification };
    return { classification };
  });
}
