/**
 * World State Goal Evaluation — GoalGraph 条件评估器
 *
 * 根据当前 WorldState 评估 GoalGraph 中所有子目标的条件：
 * - 检查前置条件是否满足（解锁 pending 子目标）
 * - 检查后置条件是否满足（标记子目标完成候选）
 * - 更新成功标准的 met 状态
 */
import type {
  WorldState, GoalGraph, GoalCondition, SuccessCriterion,
} from "@mindpal/shared";
import { findEntityByName, findFactByKey } from "@mindpal/shared";

/* ================================================================== */
/*  GoalGraph 条件评估器                                                */
/* ================================================================== */

/**
 * 根据当前 WorldState 评估 GoalGraph 中所有子目标的条件
 * - 检查前置条件是否满足（解锁 pending 子目标）
 * - 检查后置条件是否满足（标记子目标完成候选）
 * - 更新成功标准的 met 状态
 */
export function evaluateGoalConditions(
  graph: GoalGraph,
  worldState: WorldState,
): GoalGraph {
  const now = new Date().toISOString();
  const updatedGraph = { ...graph, subGoals: [...graph.subGoals], updatedAt: now };

  for (let i = 0; i < updatedGraph.subGoals.length; i++) {
    const goal = { ...updatedGraph.subGoals[i] };

    // 评估前置条件
    goal.preconditions = goal.preconditions.map((pc) => ({
      ...pc,
      satisfied: evaluateCondition(pc, worldState),
      evaluatedAt: now,
    }));

    // 评估后置条件
    goal.postconditions = goal.postconditions.map((pc) => ({
      ...pc,
      satisfied: evaluateCondition(pc, worldState),
      evaluatedAt: now,
    }));

    // 评估成功标准
    goal.successCriteria = goal.successCriteria.map((sc) => ({
      ...sc,
      met: evaluateSuccessCriterion(sc, worldState),
    }));

    // ── 9.2 + 9.3: postconditions 纳入完成判定 + 软完成级别 ──
    const allRequiredCriteriaMet = goal.successCriteria
      .filter((sc) => sc.required)
      .every((sc) => sc.met);

    // postconditions 全为空时退化为仅看 criteria
    const postconditionsSatisfied = !goal.postconditions.length ||
      goal.postconditions.every((pc) => pc.satisfied);

    goal.completionLevel =
      allRequiredCriteriaMet && postconditionsSatisfied ? 'full' :
      allRequiredCriteriaMet && !postconditionsSatisfied ? 'partial' :
      'failed';

    goal.updatedAt = now;
    updatedGraph.subGoals[i] = goal;
  }

  // 更新全局成功标准
  updatedGraph.globalSuccessCriteria = updatedGraph.globalSuccessCriteria.map((sc) => ({
    ...sc,
    met: evaluateSuccessCriterion(sc, worldState),
  }));

  return updatedGraph;
}

/** 评估单个条件 */
function evaluateCondition(condition: GoalCondition, state: WorldState): boolean {
  if (!condition.assertionType || !condition.assertionParams) {
    // 纯自然语言条件无法自动评估，保持原状
    return condition.satisfied ?? false;
  }

  const params = condition.assertionParams;

  switch (condition.assertionType) {
    case "entity_exists": {
      const entityName = String(params.entityName ?? "");
      const found = findEntityByName(state, entityName);
      return found !== undefined && found.state !== "deleted";
    }
    case "entity_state": {
      const entityName = String(params.entityName ?? "");
      const expectedState = String(params.state ?? "");
      const found = findEntityByName(state, entityName);
      return found !== undefined && found.state === expectedState;
    }
    case "fact_true": {
      const factKey = String(params.factKey ?? "");
      return findFactByKey(state, factKey) !== undefined;
    }
    case "output_contains": {
      const pattern = String(params.pattern ?? "");
      return state.facts.some(
        (f) => f.valid && f.statement.includes(pattern),
      );
    }
    case "relation_holds": {
      // 通过实体名称解析 ID，在 relations 中查找匹配关系
      const fromName = String(params.fromEntity ?? "");
      const toName = String(params.toEntity ?? "");
      const relType = String(params.type ?? "");
      const fromEntity = findEntityByName(state, fromName);
      const toEntity = findEntityByName(state, toName);
      if (!fromEntity || !toEntity) return condition.satisfied ?? false;
      return state.relations.some(
        (r) =>
          r.fromEntityId === fromEntity.entityId &&
          r.toEntityId === toEntity.entityId &&
          r.type === relType,
      );
    }
    case "regex_match": {
      try {
        const regexPattern = new RegExp(String(params.pattern ?? ""));
        // 支持两种目标：实体属性值 或 事实内容
        let target = "";
        if (params.entityName && params.property) {
          const entity = findEntityByName(state, String(params.entityName));
          target = String(entity?.properties?.[String(params.property)] ?? "");
        } else if (params.factKey) {
          const fact = findFactByKey(state, String(params.factKey));
          target = fact ? String(fact.value ?? fact.statement) : "";
        } else {
          // 回退：在所有有效事实的 statement 中搜索
          return state.facts.some(
            (f) => f.valid && regexPattern.test(f.statement),
          );
        }
        return regexPattern.test(target);
      } catch {
        return condition.satisfied ?? false;
      }
    }
    case "numeric_range": {
      let numValue = NaN;
      if (params.entityName && params.property) {
        const entity = findEntityByName(state, String(params.entityName));
        numValue = Number(entity?.properties?.[String(params.property)] ?? NaN);
      } else if (params.factKey) {
        const fact = findFactByKey(state, String(params.factKey));
        numValue = Number(fact?.value ?? NaN);
      }
      if (Number.isNaN(numValue)) return condition.satisfied ?? false;
      const min = Number(params.min ?? -Infinity);
      const max = Number(params.max ?? Infinity);
      return numValue >= min && numValue <= max;
    }
    case "temporal_after": {
      const threshold = new Date(String(params.timestamp ?? "")).getTime();
      if (Number.isNaN(threshold)) return condition.satisfied ?? false;
      if (params.entityName) {
        const entity = findEntityByName(state, String(params.entityName));
        if (!entity) return condition.satisfied ?? false;
        return new Date(entity.updatedAt).getTime() > threshold;
      }
      if (params.factKey) {
        const fact = findFactByKey(state, String(params.factKey));
        if (!fact) return condition.satisfied ?? false;
        return new Date(fact.recordedAt).getTime() > threshold;
      }
      return condition.satisfied ?? false;
    }
    case "temporal_before": {
      const threshold = new Date(String(params.timestamp ?? "")).getTime();
      if (Number.isNaN(threshold)) return condition.satisfied ?? false;
      if (params.entityName) {
        const entity = findEntityByName(state, String(params.entityName));
        if (!entity) return condition.satisfied ?? false;
        return new Date(entity.updatedAt).getTime() < threshold;
      }
      if (params.factKey) {
        const fact = findFactByKey(state, String(params.factKey));
        if (!fact) return condition.satisfied ?? false;
        return new Date(fact.recordedAt).getTime() < threshold;
      }
      return condition.satisfied ?? false;
    }
    default:
      return condition.satisfied ?? false;
  }
}

/** 评估成功标准（结构化求值 + all/any/threshold 策略） */
function evaluateSuccessCriterion(criterion: SuccessCriterion, state: WorldState): boolean {
  if (criterion.met) return true; // 已满足的不回退

  // ── 1. 优先：evidenceRef 查找匹配 fact，要求高置信度 ──
  if (criterion.evidenceRef) {
    const factByKey = findFactByKey(state, criterion.evidenceRef);
    if (factByKey && factByKey.valid) {
      return (factByKey.confidence ?? 0) >= 0.7;
    }
    // 回退：按 factId 查找
    const factById = state.facts.find((f) => f.factId === criterion.evidenceRef && f.valid);
    if (factById) {
      return (factById.confidence ?? 0) >= 0.7;
    }
    // evidenceRef 指定但未找到 → 不满足
    return false;
  }

  // ── 2. 次选：遍历 facts 用关键词 + 置信度匹配 ──
  const keywords = criterion.description.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
  if (keywords.length === 0) return false;

  // 在所有有效 facts 中搜索关键词匹配（不再限定 "succeeded" 文本）
  const matchingFacts = state.facts.filter((f) => {
    if (!f.valid) return false;
    const keyLower = (f.key ?? "").toLowerCase();
    const stmtLower = f.statement.toLowerCase();
    const valueLower = String(f.value ?? "").toLowerCase();
    return keywords.some((kw: string) =>
      keyLower.includes(kw) || stmtLower.includes(kw) || valueLower.includes(kw),
    );
  });

  if (matchingFacts.length > 0) {
    // 取最高置信度的匹配 fact
    const bestMatch = matchingFacts.reduce((a, b) =>
      (a.confidence ?? 0) > (b.confidence ?? 0) ? a : b,
    );
    const bestConfidence = bestMatch.confidence ?? 0;

    // 根据 strategy 选择聚合方式
    const strategy = criterion.strategy || 'all';
    switch (strategy) {
      case 'any':
        // 任一匹配且置信度 ≥ 0.5 即满足
        return bestConfidence >= 0.5;
      case 'threshold': {
        // 满足的关键词比例达到阈值（在高置信度 facts 中）
        const highConfFacts = matchingFacts.filter((f) => (f.confidence ?? 0) >= 0.5);
        const matchedCount = keywords.filter((kw: string) =>
          highConfFacts.some((f) => {
            const s = f.statement.toLowerCase();
            const k = (f.key ?? "").toLowerCase();
            return s.includes(kw) || k.includes(kw);
          }),
        ).length;
        return (matchedCount / keywords.length) >= (criterion.thresholdValue ?? 1.0);
      }
      case 'all':
      default:
        // 有匹配且最高置信度 ≥ 0.5
        return bestConfidence >= 0.5;
    }
  }

  // ── 3. 兜底：关键词在 fact statement 中的纯文本匹配（无置信度门槛） ──
  const anyTextMatch = state.facts.some((f) => {
    if (!f.valid) return false;
    const stmtLower = f.statement.toLowerCase();
    return keywords.some((kw: string) => stmtLower.includes(kw));
  });
  return anyTextMatch;
}
