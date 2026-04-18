/**
 * P2-3: Executor 角色
 * 负责实际的工具调用和任务执行
 */
import type { CollabRole, StepContext, StepResult, RecoverySuggestion, RoleCapability } from "./index";
import { registerRole } from "./index";

export class ExecutorRole implements CollabRole {
  readonly name = "executor";
  readonly capabilities: readonly RoleCapability[] = ["execute"] as const;
  readonly description = "执行角色，负责调用工具完成具体的业务操作（如实体创建、数据处理等）";

  canHandle(stepKind: string, _toolRef: string): boolean {
    return stepKind === "execute" || stepKind === "tool_call" || stepKind === "action";
  }

  async execute(ctx: StepContext): Promise<StepResult> {
    try {
      // 实际实现会通过 processStep 执行工具调用
      // 这里提供框架，具体执行委托给 Worker
      return {
        ok: true,
        output: {
          toolRef: ctx.toolRef,
          executed: true,
          stepId: ctx.stepId,
        },
        evidenceDigest: `exec:${ctx.toolRef}:${ctx.planStepId}`,
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
    if (!output.executed) {
      issues.push("执行结果标记为未执行");
    }
    return { valid: issues.length === 0, issues };
  }

  onFailure(ctx: StepContext, error: string): RecoverySuggestion {
    if (error.includes("policy_violation")) {
      return { action: "escalate", reason: `安全策略阻止执行 ${ctx.toolRef}: ${error}` };
    }
    if (error.includes("timeout")) {
      return { action: "retry", reason: "执行超时，建议重试", maxRetries: 2 };
    }
    if (error.includes("rate_limit")) {
      return { action: "retry", reason: "频率限制，稍后重试", maxRetries: 3 };
    }
    return { action: "replan", reason: `执行失败需要重新规划: ${error}` };
  }
}

registerRole(new ExecutorRole());
