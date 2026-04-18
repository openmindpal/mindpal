/**
 * P2-3: Planner 角色
 * 负责任务分解、步骤规划、依赖分析
 */
import type { CollabRole, StepContext, StepResult, RecoverySuggestion, RoleCapability } from "./index";
import { registerRole } from "./index";

export class PlannerRole implements CollabRole {
  readonly name = "planner";
  readonly capabilities: readonly RoleCapability[] = ["plan", "coordinate"] as const;
  readonly description = "任务分解与步骤规划角色，负责将用户意图拆解为可执行的步骤序列";

  canHandle(stepKind: string, _toolRef: string): boolean {
    return stepKind === "plan" || stepKind === "decompose" || stepKind === "replan";
  }

  async execute(ctx: StepContext): Promise<StepResult> {
    // Planner 执行逻辑：调用 planningKernel 生成步骤
    // 实际实现会调用 LLM 进行任务分解
    try {
      const planResult = {
        steps: ctx.input.steps ?? [],
        strategy: ctx.input.strategy ?? "sequential",
        estimatedDuration: ctx.input.estimatedDuration ?? null,
      };

      return {
        ok: true,
        output: planResult as unknown as Record<string, unknown>,
        evidenceDigest: `plan:${ctx.planStepId}`,
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
    if (!output.steps || !Array.isArray(output.steps)) {
      issues.push("规划结果缺少 steps 数组");
    }
    if (Array.isArray(output.steps) && output.steps.length === 0) {
      issues.push("规划结果步骤为空");
    }
    return { valid: issues.length === 0, issues };
  }

  onFailure(_ctx: StepContext, error: string): RecoverySuggestion {
    if (error.includes("model_error") || error.includes("timeout")) {
      return { action: "retry", reason: "模型调用失败，建议重试", maxRetries: 2 };
    }
    return { action: "escalate", reason: `规划失败: ${error}` };
  }
}

// 自动注册
registerRole(new PlannerRole());
