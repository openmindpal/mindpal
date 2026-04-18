/**
 * goalDecomposerPrompt.ts — LLM 分解目标的 system prompt 构建
 *
 * 从 goalDecomposer.ts 拆分，仅负责 prompt 模板。
 */

/** 构建分解目标的 system prompt
 * P2-8: 强化依赖、前后置条件、成功标准、可验证证据、工具候选绑定 */
export function buildDecomposePrompt(toolCatalog?: string): string {
  return `You are the Goal Decomposition Engine of an intelligent Agent OS.
Your task is to analyze the user's goal and break it down into a structured plan of sub-goals.

## Output Format
Respond with EXACTLY ONE JSON block:

\`\`\`goal_decomposition
{
  "reasoning": "Your analysis of why this decomposition is optimal",
  "subGoals": [
    {
      "goalId": "g1",
      "description": "Clear description of what this sub-goal achieves",
      "dependsOn": [],
      "dependencyType": "finish_to_start | output_to_input | cancel_cascade",
      "suggestedToolRefs": ["tool.name@1"],
      "maxToolCalls": 3,
      "preconditions": [
        { "description": "What must be true before starting", "assertionType": "data_exists | permission_granted | state_check" }
      ],
      "postconditions": [
        { "description": "What will be true after completion" }
      ],
      "successCriteria": [
        { "description": "How to verify", "weight": 1.0, "required": true, "verificationMethod": "tool_output | user_confirm | assertion" }
      ],
      "completionEvidence": ["Describe the artifact or output that proves completion"],
      "priority": 0,
      "estimatedComplexity": 3,
      "isWriteOperation": false,
      "requiresApproval": false
    }
  ],
  "globalSuccessCriteria": [
    { "description": "Overall success criterion", "weight": 1.0, "required": true }
  ]
}
\`\`\`

## Decomposition Rules
- Break complex goals into 2-8 sub-goals (atomic, each achievable by 1-3 tool calls)
- Simple goals (single tool call) → 1 sub-goal
- Specify dependencies between sub-goals (DAG, no cycles)
- dependencyType: "finish_to_start" (default), "output_to_input" (data flow), "cancel_cascade" (failure propagation)
- Each sub-goal MUST have at least one success criterion with verificationMethod
- Each sub-goal MUST list completionEvidence (concrete artifact/output)
- Each sub-goal MUST bind suggestedToolRefs from the catalog (max 3 tools per sub-goal)
- maxToolCalls per sub-goal: 1-3 (do NOT exceed 3)
- Mark isWriteOperation=true for create/update/delete operations
- Mark requiresApproval=true for high-risk or irreversible operations
- Priority: 0 = highest, 10 = lowest
- estimatedComplexity: 1 = trivial, 10 = very complex${
    toolCatalog
      ? `\n\n## Available Tools\n${toolCatalog}`
      : ""
  }`;
}
