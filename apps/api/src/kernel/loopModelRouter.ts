/**
 * Agent Loop — 模型路由策略
 *
 * 根据上下文复杂度选择 purpose tier，并尝试动态能力画像路由。
 */
import type { Pool } from "pg";
import type { StepObservation } from "./loopTypes";
import { dynamicRouteModel, type TaskFeatures } from "../modules/modelGateway/routingPolicyRepo";

/* ================================================================== */
/*  Purpose Tier — 根据上下文复杂度选择模型路由策略                       */
/* ================================================================== */

/**
 * 根据当前观察和迭代次数动态选择 purpose（模型分级路由）。
 * - 简单推进（上一步成功 + 前3步）→ fast 模型
 * - 其他情况（失败恢复 / 复杂决策 / 首次迭代）→ standard 模型
 * 模型选择由 model gateway 的 routing policy 根据 purpose 决定，此处零硬编码。
 */
export function selectPurposeTier(observations: StepObservation[], iteration: number): string {
  if (iteration <= 1) return "agent.loop.think"; // 首轮用标准模型
  const last = observations.length > 0 ? observations[observations.length - 1] : null;
  // 上一步成功 + 总步骤较少 → 简单推进，用快速模型
  if (last && last.status === "succeeded" && observations.length <= 5) {
    return "agent.loop.think.fast";
  }
  // 有失败 / 迭代较多 → 标准模型
  return "agent.loop.think";
}

/* ================================================================== */
/*  P2-模型: 任务特征提取 + 动态能力画像路由                                */
/* ================================================================== */

/**
 * 从 Agent Loop 当前上下文中推断 TaskFeatures 向量。
 * 用于与 DB 模型能力画像矩阵做匹配打分。
 */
export function extractTaskFeatures(params: {
  observations: StepObservation[];
  iteration: number;
  goal: string;
  promptTokenEstimate: number;
}): TaskFeatures {
  const { observations, iteration, goal, promptTokenEstimate } = params;
  const hasFailed = observations.some(o => o.status === "failed" || o.status === "error");
  const hasToolCall = observations.some(o => o.toolRef);

  // 复杂度启发式推断
  let complexity: "low" | "medium" | "high" = "medium";
  if (iteration <= 2 && !hasFailed && observations.length <= 3) complexity = "low";
  if (hasFailed || iteration >= 8 || goal.length > 500) complexity = "high";

  // 模态推断
  const modalities: string[] = ["text"];
  const hasImageHint = observations.some(o =>
    typeof o.output === "string" && /image|screenshot|图片|截图|vision|visual/i.test(o.output),
  );
  if (hasImageHint) modalities.push("image");

  // 代码生成需求推断
  const requiresCodeGen = /代码|编程|code|program|script|函数|function|implement|实现/i.test(goal);

  // 推理深度推断
  const requiresReasoning = complexity === "high" ||
    /分析|推理|reasoning|analyze|explain|为什么|compare|评估|evaluate/i.test(goal);

  return {
    complexity,
    modalities,
    requiresToolCall: hasToolCall || /工具|tool|搜索|search|查询|query|execute|执行/i.test(goal),
    requiresStructuredOutput: false, // agent loop 输出为自由文本
    requiresReasoning,
    requiresCodeGen,
    latencySensitive: iteration > 5, // 后期迭代更敏感于延迟
    contextLengthNeeded: promptTokenEstimate > 0 ? promptTokenEstimate * 4 : undefined,
  };
}

/**
 * P2-模型: 尝试通过动态能力画像路由选择最优模型。
 * 当 DB 模型目录有数据时，根据 TaskFeatures × ModelCapabilities 矩阵评分选择。
 * 失败或无候选时返回 undefined，由原有 purpose-based 路由兜底。
 */
export async function tryDynamicModelRoute(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string;
  purpose: string;
  observations: StepObservation[];
  iteration: number;
  goal: string;
  promptTokenEstimate: number;
}): Promise<string | undefined> {
  try {
    const taskFeatures = extractTaskFeatures({
      observations: params.observations,
      iteration: params.iteration,
      goal: params.goal,
      promptTokenEstimate: params.promptTokenEstimate,
    });
    const result = await dynamicRouteModel({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      purpose: params.purpose,
      taskFeatures,
    });
    if (result.modelRef && result.candidates.length > 0) {
      return result.modelRef;
    }
  } catch {
    // 动态路由为可选增强，失败时静默回退
  }
  return undefined;
}
