/**
 * P2-3: Guard 角色
 * 负责安全检查、权限校验、风险拦截
 */
import type { CollabRole, StepContext, StepResult, RecoverySuggestion, RoleCapability } from "./index";
import { registerRole } from "./index";

export class GuardRole implements CollabRole {
  readonly name = "guard";
  readonly capabilities: readonly RoleCapability[] = ["guard", "audit"] as const;
  readonly description = "安全守卫角色，负责在执行前后进行安全检查、权限校验和风险拦截";

  canHandle(stepKind: string, toolRef: string): boolean {
    return stepKind === "guard" || stepKind === "safety_check" || toolRef.startsWith("collab.guard");
  }

  async execute(ctx: StepContext): Promise<StepResult> {
    try {
      // 实际实现会调用 safety-policy 模块进行安全校验
      const targetToolRef = ctx.input.targetToolRef ?? "";
      const riskLevel = ctx.input.riskLevel ?? "low";

      return {
        ok: true,
        output: {
          checked: true,
          targetToolRef,
          riskLevel,
          decision: "allow", // allow | deny | needs_approval
          policyRefs: [],
          violations: [],
        },
        evidenceDigest: `guard:${ctx.planStepId}`,
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
    if (!output.decision) {
      issues.push("安全检查结果缺少 decision 字段");
    }
    const validDecisions = ["allow", "deny", "needs_approval"];
    if (output.decision && !validDecisions.includes(String(output.decision))) {
      issues.push(`无效的 decision: ${output.decision}`);
    }
    return { valid: issues.length === 0, issues };
  }

  onFailure(_ctx: StepContext, error: string): RecoverySuggestion {
    // 安全检查失败不能重试，必须上报
    return { action: "abort", reason: `安全检查异常，中止执行: ${error}` };
  }
}

registerRole(new GuardRole());
