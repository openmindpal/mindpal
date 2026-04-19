import type { IntentClassification } from "./modules/intentClassifier";
import { classifyToolCalls, type InlineToolCall } from "./modules/inlineToolExecutor";
import type { EnabledTool } from "../../modules/agentContext";

export type ExecutionClass = "conversation" | "immediate_action" | "workflow" | "collab";

/** auto 模式进入 execute 的置信度阈值（可环境变量覆盖，默认 0.70） */
export const AUTO_EXECUTION_THRESHOLD = parseFloat(process.env.AUTO_EXECUTION_THRESHOLD ?? "0.70") || 0.70;

/** fast 规则高置信直接信任阈值（可环境变量覆盖，默认 0.85） */
export const FAST_RULE_HIGH_CONFIDENCE = parseFloat(process.env.FAST_RULE_HIGH_CONFIDENCE ?? "0.85") || 0.85;

export function shouldAutoEnterExecute(classification: IntentClassification): boolean {
  return classification.mode !== "answer"
    && classification.mode !== "intervene"
    && classification.needsTask
    && classification.confidence >= AUTO_EXECUTION_THRESHOLD;
}

export function resolveExecutionClassFromSuggestions(params: {
  toolCalls: InlineToolCall[];
  enabledTools: EnabledTool[];
  inlineWritableEntities: Set<string>;
}): {
  executionClass: ExecutionClass;
  inlineTools: InlineToolCall[];
  workflowTools: InlineToolCall[];
  separatePipelineTool: InlineToolCall | null;
} {
  const { inlineTools, upgradeTools, separatePipelineTool } = classifyToolCalls(
    params.toolCalls,
    params.enabledTools,
    params.inlineWritableEntities,
  );

  const executionClass: ExecutionClass = upgradeTools.length > 0
    ? "workflow"
    : (inlineTools.length > 0 || separatePipelineTool)
      ? "immediate_action"
      : "conversation";

  return {
    executionClass,
    inlineTools,
    workflowTools: upgradeTools,
    separatePipelineTool,
  };
}
