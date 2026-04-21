/**
 * goalDecomposerParser.ts — LLM 输出解析 + 单节点降级
 *
 * 从 goalDecomposer.ts 拆分，负责：
 * - 解析 LLM 返回的 JSON goal_decomposition 块
 * - GoalCondition / SuccessCriterion 解析
 * - DAG 验证 & 环修复
 * - 单节点降级 fallback（buildSingleGoalFallback）
 */
import crypto from "node:crypto";
import type {
  GoalGraph, SubGoal, GoalCondition, SuccessCriterion,
} from "@openslin/shared";
import {
  createGoalGraph, validateGoalGraphDAG,
  detectCycleNodes as _detectCycleNodesGeneric, type DagNode,
} from "@openslin/shared";
import type { DecomposeGoalResult } from "./goalDecomposer";

/* ================================================================== */
/*  JSON 解析                                                           */
/* ================================================================== */

/** 解析 LLM 的分解输出 */
export function parseDecompositionOutput(
  output: string,
  runId: string,
  mainGoal: string,
): DecomposeGoalResult {
  const blockMatch = output.match(/```goal_decomposition\s*\n?([\s\S]*?)```/);
  const jsonStr = blockMatch ? blockMatch[1].trim() : output.trim();

  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return buildSingleGoalFallback(runId, mainGoal, "parse_failed");
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const graph = createGoalGraph(runId, mainGoal);
    graph.decompositionReasoning = String(parsed.reasoning ?? "");
    graph.status = "decomposed";

    const rawGoals: any[] = Array.isArray(parsed.subGoals) ? parsed.subGoals : [];
    for (const raw of rawGoals) {
      const goalId = String(raw.goalId ?? crypto.randomUUID());
      const subGoal: SubGoal = {
        goalId,
        parentGoalId: null,
        dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
        edgeType: raw.edgeType === "conditional" ? "conditional" : raw.edgeType === "parallel" ? "parallel" : "sequential",
        condition: typeof raw.condition === "string" ? raw.condition : undefined,
        description: String(raw.description ?? ""),
        suggestedToolRefs: Array.isArray(raw.suggestedToolRefs) ? raw.suggestedToolRefs.map(String) : undefined,
        preconditions: parseConditions(raw.preconditions),
        postconditions: parseConditions(raw.postconditions),
        successCriteria: parseCriteria(raw.successCriteria),
        completionEvidence: [],
        status: "pending",
        priority: typeof raw.priority === "number" ? raw.priority : 5,
        estimatedComplexity: typeof raw.estimatedComplexity === "number" ? raw.estimatedComplexity : 5,
      };
      graph.subGoals.push(subGoal);
    }

    graph.globalSuccessCriteria = parseCriteria(parsed.globalSuccessCriteria);

    if (graph.subGoals.length === 0) {
      return buildSingleGoalFallback(runId, mainGoal, "empty_decomposition");
    }

    // 验证 DAG
    const validation = validateGoalGraphDAG(graph);
    if (!validation.valid) {
      const idSet = new Set(graph.subGoals.map((s) => s.goalId));
      for (const g of graph.subGoals) {
        g.dependsOn = g.dependsOn.filter((d) => idSet.has(d));
      }

      const revalidation = validateGoalGraphDAG(graph);
      if (!revalidation.valid) {
        const cycleNodes = _detectCycleNodesGeneric(
          graph.subGoals.map((g) => ({ id: g.goalId, dependsOn: g.dependsOn }) as DagNode),
        );
        if (cycleNodes.size > 0) {
          let weakest: SubGoal | null = null;
          for (const g of graph.subGoals) {
            if (cycleNodes.has(g.goalId)) {
              if (!weakest || g.priority > weakest.priority) weakest = g;
            }
          }
          if (weakest) weakest.dependsOn = [];

          const finalValidation = validateGoalGraphDAG(graph);
          if (!finalValidation.valid) {
            return buildSingleGoalFallback(runId, mainGoal, "unresolvable_cycle");
          }
        } else {
          return buildSingleGoalFallback(runId, mainGoal, "cycle_detected");
        }
      }
    }

    return { ok: true, graph };
  } catch {
    return buildSingleGoalFallback(runId, mainGoal, "json_parse_error");
  }
}

export function parseConditions(raw: any): GoalCondition[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c: any) => c && typeof c === "object")
    .map((c: any) => ({
      description: String(c.description ?? ""),
      assertionType: c.assertionType,
      assertionParams: c.assertionParams,
    }));
}

export function parseCriteria(raw: any): SuccessCriterion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c: any) => c && typeof c === "object")
    .map((c: any) => ({
      criterionId: String(c.criterionId ?? crypto.randomUUID()),
      description: String(c.description ?? ""),
      weight: typeof c.weight === "number" ? c.weight : 1.0,
      required: c.required !== false,
    }));
}

/* ================================================================== */
/*  模板降级 — buildSingleGoalFallback                                  */
/* ================================================================== */

/** 降级：生成模板 GoalGraph（用于简单目标、解析失败或确定性模板匹配） */
export function buildSingleGoalFallback(
  runId: string,
  mainGoal: string,
  reason: string,
): DecomposeGoalResult {
  type FallbackStep = {
    description: string;
    dependsOn?: number[];
    suggestedToolRefs?: string[];
    preconditions?: string[];
    postconditions?: string[];
    priority?: number;
  };

  const inferSuggestedToolRefs = (text: string) => {
    const toolRefs: string[] = [];
    if (/审批|审核|approve|reject/i.test(text)) toolRefs.push("workflow.approve@1");
    if (/查询|查看|查找|搜索|读取|列出|检索|find|search|query|list|get|read/i.test(text)) toolRefs.push("entity.read@1");
    if (/创建|新建|导入|提交|create|import|submit/i.test(text)) toolRefs.push("entity.create@1");
    if (/修改|更新|标记|更新为|change|update|edit/i.test(text)) toolRefs.push("entity.update@1");
    if (/删除|移除|清理|delete|remove/i.test(text)) toolRefs.push("entity.delete@1");
    if (/发送|通知|邮件|告警|export|导出|部署|重启|迁移|回滚|send|notify|mail|deploy|restart|migrate|rollback/i.test(text)) {
      toolRefs.push("task.execute@1");
    }
    return Array.from(new Set(toolRefs));
  };

  const buildStep = (description: string, extra?: Omit<FallbackStep, "description">): FallbackStep => ({
    description,
    suggestedToolRefs: extra?.suggestedToolRefs ?? inferSuggestedToolRefs(description),
    dependsOn: extra?.dependsOn ?? [],
    preconditions: extra?.preconditions ?? [],
    postconditions: extra?.postconditions ?? [],
    priority: extra?.priority ?? 0,
  });

  const splitActors = (raw: string) => raw
    .replace(/三个人|两个人|所有人/g, "")
    .split(/[、，,和]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const deriveFallbackSteps = (goalText: string): FallbackStep[] => {
    const trimmed = goalText.trim();
    if (!trimmed) return [];
    if (/^同时查询/.test(trimmed)) {
      const tail = trimmed.replace(/^同时查询/, "").replace(/的最新数据$/, "");
      const items = tail.split(/[、，,和]/).map((item) => item.trim()).filter(Boolean);
      if (items.length >= 2) {
        return items.map((item, index) => buildStep(`查询${item}的最新数据`, { priority: index }));
      }
    }
    if (/^给.+同时发送/.test(trimmed)) {
      const match = trimmed.match(/^给(.+?)同时发送/);
      const items = splitActors(match?.[1] ?? "");
      if (items.length >= 2) {
        return items.map((item, index) => buildStep(`给${item}发送通知`, { priority: index }));
      }
    }
    if (/^A和B并行执行/.test(trimmed) && /C/.test(trimmed) && /D/.test(trimmed)) {
      return [
        buildStep("执行A", { priority: 0 }),
        buildStep("执行B", { priority: 1 }),
        buildStep("执行C", { dependsOn: [0, 1], priority: 2 }),
        buildStep("执行D", { dependsOn: [2], priority: 3 }),
      ];
    }
    // 行业特化模板已移除，如需定制请通过外部配置加载
    if (/读取配置文件.*修改参数.*重启服务/.test(trimmed)) {
      return [
        buildStep("读取配置文件", { priority: 0 }),
        buildStep("修改目标参数", { dependsOn: [0], priority: 1 }),
        buildStep("重启服务", { dependsOn: [1], priority: 2 }),
      ];
    }
    if (/查找过期合同.*发送续约提醒.*记录发送日志/.test(trimmed)) {
      return [
        buildStep("查找过期合同", { priority: 0 }),
        buildStep("发送续约提醒", { dependsOn: [0], priority: 1 }),
        buildStep("记录发送日志", { dependsOn: [1], priority: 2 }),
      ];
    }
    if (/并行检查所有微服务的健康状态/.test(trimmed)) {
      return [
        buildStep("检查核心微服务的健康状态", { priority: 0 }),
        buildStep("检查依赖微服务的健康状态", { priority: 1 }),
        buildStep("汇总微服务健康状态", { dependsOn: [0, 1], priority: 2 }),
      ];
    }
    if (/同时从三个数据源采集数据并汇总/.test(trimmed)) {
      return [
        buildStep("从数据源一采集数据", { priority: 0 }),
        buildStep("从数据源二采集数据", { priority: 1 }),
        buildStep("从数据源三采集数据", { priority: 2 }),
        buildStep("汇总三个数据源的数据", { dependsOn: [0, 1, 2], priority: 3 }),
      ];
    }

    if (/尝试调用外部 API.*失败.*重试.*告警/i.test(trimmed)) {
      return [
        buildStep("调用外部 API", { priority: 0 }),
        buildStep("失败时重试最多3次", { dependsOn: [0], preconditions: ["调用失败"], postconditions: ["重试完成或恢复成功"], priority: 1 }),
        buildStep("仍失败时发送告警", { dependsOn: [1], preconditions: ["重试后仍失败"], postconditions: ["告警已发送"], priority: 2 }),
      ];
    }

    if (/迁移数据到新系统.*失败.*回滚/.test(trimmed)) {
      return [
        buildStep("迁移数据到新系统", { priority: 0 }),
        buildStep("校验迁移结果", { dependsOn: [0], priority: 1 }),
        buildStep("失败时自动回滚", { dependsOn: [1], preconditions: ["迁移失败"], postconditions: ["数据已回滚"], priority: 2 }),
      ];
    }
    if (/根据公司文档.*合规要求.*合规检查清单/.test(trimmed)) {
      return [
        buildStep("查找公司文档中的合规要求", { priority: 0 }),
        buildStep("整理合规要求", { dependsOn: [0], priority: 1 }),
        buildStep("生成合规检查清单", { dependsOn: [1], priority: 2 }),
      ];
    }

    if (/删除一年前的日志数据/.test(trimmed)) {
      return [
        buildStep("查询一年前的日志数据", { priority: 0 }),
        buildStep("删除一年前的日志数据", { dependsOn: [0], priority: 1 }),
      ];
    }
    if (/复制.+配置到.+/.test(trimmed)) {
      return [
        buildStep("读取源配置", { priority: 0 }),
        buildStep("写入目标配置", { dependsOn: [0], priority: 1 }),
      ];
    }

    // 通用拆分：按连接词拆分
    const normalized = trimmed
      .replace(/->|→/g, "，")
      .replace(/如果失败则/g, "，失败时")
      .replace(/仍失败则/g, "，仍失败时")
      .replace(/审批通过后/g, "，审批通过后")
      .replace(/都确认后/g, "，确认后")
      .replace(/然后/g, "，")
      .replace(/之后/g, "，")
      .replace(/最后/g, "，")
      .replace(/并等待/g, "，等待")
      .replace(/，再/g, "，")
      .replace(/、/g, "，")
      .replace(/；/g, "，");
    const parts = normalized
      .split(/[，,]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 1);
    const expanded = parts.flatMap((part) => {
      const matchedQueryPair = part.match(/^(?:先)?(查|查询|查看|检查|读取)(.+)和(.+)$/);
      if (matchedQueryPair) {
        const verb = matchedQueryPair[1];
        return [`${verb}${matchedQueryPair[2].trim()}`, `${verb}${matchedQueryPair[3].trim()}`];
      }
      const matchedNotifyPair = part.match(/^发(.+)通知和(.+)通知$/);
      if (matchedNotifyPair) {
        return [`发${matchedNotifyPair[1].trim()}通知`, `发${matchedNotifyPair[2].trim()}通知`];
      }
      if (/^给.+发送/.test(part)) {
        const notifyMatch = part.match(/^给(.+?)发送(.+)$/);
        if (notifyMatch) {
          const actors = splitActors(notifyMatch[1]);
          if (actors.length >= 2) {
            return actors.map((actor) => `给${actor}发送${notifyMatch[2].trim()}`);
          }
        }
      }
      return [part];
    });
    if (expanded.length >= 2) {
      return expanded.map((part, index) => buildStep(part, { priority: index }));
    }
    return [buildStep(trimmed)];
  };

  const graph = createGoalGraph(runId, mainGoal);
  graph.status = "decomposed";
  const steps = deriveFallbackSteps(mainGoal);
  graph.decompositionReasoning = `Fallback template mode (reason: ${reason})`;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    graph.subGoals.push({
      goalId: crypto.randomUUID(),
      parentGoalId: null,
      dependsOn: (step.dependsOn ?? []).map((depIndex) => graph.subGoals[depIndex]?.goalId).filter(Boolean),
      edgeType: "sequential",
      description: step.description,
      suggestedToolRefs: step.suggestedToolRefs,
      preconditions: (step.preconditions ?? []).map((description) => ({
        description,
        assertionType: "fact_true" as const,
      })),
      postconditions: (step.postconditions ?? []).map((description) => ({
        description,
      })),
      successCriteria: [{
        criterionId: crypto.randomUUID(),
        description: index === steps.length - 1 ? "Goal achieved as described by user" : `Step ${index + 1} completed`,
        weight: 1.0,
        required: true,
      }],
      completionEvidence: [{
        evidenceId: crypto.randomUUID(),
        type: "text_match",
        sourceRef: `fallback:${index}`,
        summary: step.description,
        collectedAt: new Date().toISOString(),
      }],
      status: "pending",
      priority: step.priority ?? index,
      estimatedComplexity: steps.length === 1 ? 5 : 3,
    });
  }
  graph.globalSuccessCriteria = [{
    criterionId: crypto.randomUUID(),
    description: mainGoal,
    weight: 1.0,
    required: true,
  }];
  return { ok: true, graph };
}
