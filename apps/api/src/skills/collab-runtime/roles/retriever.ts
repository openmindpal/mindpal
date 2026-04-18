/**
 * P2-3: Retriever 角色
 * 负责知识检索、上下文收集、证据收集
 */
import type { CollabRole, StepContext, StepResult, RecoverySuggestion, RoleCapability } from "./index";
import { registerRole } from "./index";

export class RetrieverRole implements CollabRole {
  readonly name = "retriever";
  readonly capabilities: readonly RoleCapability[] = ["retrieve"] as const;
  readonly description = "知识检索角色，负责从知识库/向量库/外部源收集执行所需的上下文与证据";

  canHandle(stepKind: string, toolRef: string): boolean {
    return stepKind === "retrieve" || stepKind === "search" || toolRef.startsWith("knowledge.");
  }

  async execute(ctx: StepContext): Promise<StepResult> {
    try {
      // 实际实现会调用 knowledge.search 等工具
      return {
        ok: true,
        output: {
          query: ctx.input.query ?? "",
          results: [],
          resultCount: 0,
          searchMode: "semantic",
        },
        evidenceDigest: `retrieve:${ctx.planStepId}`,
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
    if (output.resultCount === 0 && !output.fallbackUsed) {
      issues.push("检索结果为空，可能需要扩大搜索范围");
    }
    return { valid: issues.length === 0, issues };
  }

  onFailure(_ctx: StepContext, error: string): RecoverySuggestion {
    if (error.includes("timeout") || error.includes("network")) {
      return { action: "retry", reason: "检索超时，建议重试", maxRetries: 3 };
    }
    return { action: "skip", reason: `检索失败但非关键: ${error}` };
  }
}

registerRole(new RetrieverRole());
