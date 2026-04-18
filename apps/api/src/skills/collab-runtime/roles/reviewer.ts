/**
 * P2-3: Reviewer 角色
 * 负责复核执行结果、质量检查、合规校验
 */
import type { CollabRole, StepContext, StepResult, RecoverySuggestion, RoleCapability } from "./index";
import { registerRole } from "./index";

export class ReviewerRole implements CollabRole {
  readonly name = "reviewer";
  readonly capabilities: readonly RoleCapability[] = ["review", "audit"] as const;
  readonly description = "复核角色，负责对执行结果进行质量检查、合规校验、一致性验证";

  canHandle(stepKind: string, toolRef: string): boolean {
    return stepKind === "review" || stepKind === "verify" || toolRef.startsWith("collab.review");
  }

  async execute(ctx: StepContext): Promise<StepResult> {
    try {
      // 实际实现会调用 LLM 或规则引擎进行结果复核
      const reviewTarget = ctx.input.targetStepId ?? ctx.input.targetOutput;
      return {
        ok: true,
        output: {
          reviewed: true,
          targetStepId: reviewTarget,
          verdict: "approved", // approved | rejected | needs_revision
          issues: [],
          confidence: 0.9,
        },
        evidenceDigest: `review:${ctx.planStepId}`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async validate(_ctx: StepContext, output: Record<string, unknown>): Promise<{ valid: boolean; issues?: string[] }> {
    const issues: string[] = [];
    if (!output.verdict) {
      issues.push("复核结果缺少 verdict 字段");
    }
    const validVerdicts = ["approved", "rejected", "needs_revision"];
    if (output.verdict && !validVerdicts.includes(String(output.verdict))) {
      issues.push(`无效的 verdict: ${output.verdict}`);
    }
    return { valid: issues.length === 0, issues };
  }

  onFailure(_ctx: StepContext, error: string): RecoverySuggestion {
    if (error.includes("timeout")) {
      return { action: "retry", reason: "复核超时，建议重试", maxRetries: 2 };
    }
    // 复核失败通常需要人工介入
    return { action: "escalate", reason: `复核失败需要人工介入: ${error}` };
  }
}

registerRole(new ReviewerRole());
