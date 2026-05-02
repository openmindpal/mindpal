/**
 * DAG Utilities — 通用有向无环图工具函数
 *
 * 权威实现：所有 DAG 验证、拓扑排序、循环检测、祖先/后代查询
 * 均由此模块提供。goalGraph.ts 和 apps/api/kernel/dagUtils.ts 委托调用本模块。
 *
 * P2-03: 通用 DAG 工具函数
 */

/* ================================================================== */
/*  类型                                                               */
/* ================================================================== */

/** 通用 DAG 节点（最小接口） */
export interface DagNode {
  id: string;
  dependsOn: string[];
}

/** DAG 验证结果 */
export interface DagValidationResult {
  valid: boolean;
  errors: string[];
  /** 检测到的循环依赖链 */
  cycles?: string[][];
  /** 孤立节点（无入度无出度，且节点数>1） */
  isolatedNodes?: string[];
  /** 悬空引用（依赖了不存在的节点） */
  danglingRefs?: Array<{ nodeId: string; missingDep: string }>;
}

/** DAG 修复操作记录（用于审计） */
export interface DagRepairAction {
  type: "remove_edge" | "attach_isolated";
  from: string;
  to: string;
  reason: string;
}

/* ================================================================== */
/*  核心算法                                                            */
/* ================================================================== */

/**
 * 验证 DAG 合法性
 * - 依赖闭合性（所有 dependsOn 引用的 id 必须存在）
 * - 循环依赖检测（Kahn 算法）
 * - 孤立节点检测
 */
export function validateDAG(nodes: DagNode[]): DagValidationResult {
  const errors: string[] = [];
  const idSet = new Set(nodes.map((n) => n.id));

  // 1. 依赖闭合性检查
  const danglingRefs: Array<{ nodeId: string; missingDep: string }> = [];
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!idSet.has(dep)) {
        danglingRefs.push({ nodeId: node.id, missingDep: dep });
        errors.push(`Node "${node.id}" depends on non-existent node "${dep}"`);
      }
    }
  }

  // 2. 拓扑排序检测循环依赖 (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const node of nodes) {
    if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
    const validDeps = node.dependsOn.filter((d) => idSet.has(d));
    inDegree.set(node.id, validDeps.length);
    for (const dep of validDeps) {
      if (!adjList.has(dep)) adjList.set(dep, []);
      adjList.get(dep)!.push(node.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sortedOrder: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    sortedOrder.push(curr);
    for (const next of adjList.get(curr) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  const cycles: string[][] = [];
  if (sortedOrder.length < nodes.length) {
    const sortedSet = new Set(sortedOrder);
    const cycleNodes = nodes.filter((n) => !sortedSet.has(n.id)).map((n) => n.id);
    cycles.push(cycleNodes);
    errors.push(`DAG contains circular dependencies involving nodes: ${cycleNodes.join(", ")}`);
  }

  // 3. 孤立节点检测
  let isolatedNodes: string[] | undefined;
  if (nodes.length > 1) {
    const hasIncoming = new Set<string>();
    const hasOutgoing = new Set<string>();
    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        if (idSet.has(dep)) {
          hasIncoming.add(node.id);
          hasOutgoing.add(dep);
        }
      }
    }
    const isolated = nodes
      .filter((n) => !hasIncoming.has(n.id) && !hasOutgoing.has(n.id))
      .map((n) => n.id);
    if (isolated.length > 0 && isolated.length < nodes.length) {
      isolatedNodes = isolated;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    cycles: cycles.length > 0 ? cycles : undefined,
    isolatedNodes,
    danglingRefs: danglingRefs.length > 0 ? danglingRefs : undefined,
  };
}

/**
 * 检测 DAG 中参与循环的节点 ID 集合
 * 使用 Kahn 算法，拓扑排序后剩余未访问的节点即为环上节点。
 */
export function detectCycleNodes(nodes: DagNode[]): Set<string> {
  const result = validateDAG(nodes);
  if (!result.cycles || result.cycles.length === 0) return new Set();
  const cycleSet = new Set<string>();
  for (const cycle of result.cycles) {
    for (const id of cycle) cycleSet.add(id);
  }
  return cycleSet;
}

/**
 * 拓扑排序
 * 返回按依赖序排列的节点 ID 列表。
 * 如果有循环依赖，返回尽可能多的可执行节点。
 *
 * @param priorityFn 可选的优先级函数，数值越小越先执行
 */
export function topologicalSortGeneric(
  nodes: DagNode[],
  priorityFn?: (id: string) => number,
): string[] {
  const idSet = new Set(nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const node of nodes) {
    const validDeps = node.dependsOn.filter((d) => idSet.has(d));
    inDegree.set(node.id, validDeps.length);
    for (const dep of validDeps) {
      if (!adjList.has(dep)) adjList.set(dep, []);
      adjList.get(dep)!.push(node.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    // 有优先级时，找出最小优先级元素交换到队头（O(n)），避免每轮全排序 O(n log n)
    if (priorityFn && queue.length > 1) {
      let minIdx = 0;
      let minVal = priorityFn(queue[0]);
      for (let i = 1; i < queue.length; i++) {
        const v = priorityFn(queue[i]);
        if (v < minVal) { minVal = v; minIdx = i; }
      }
      if (minIdx !== 0) {
        const tmp = queue[0];
        queue[0] = queue[minIdx];
        queue[minIdx] = tmp;
      }
    }
    const curr = queue.shift()!;
    sorted.push(curr);
    for (const next of adjList.get(curr) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  return sorted;
}

/**
 * 检查添加新边是否会导致循环依赖
 * @param existingNodes 当前 DAG 所有节点
 * @param fromId 新边的起点（依赖方）
 * @param toId 新边的终点（被依赖方） — fromId 依赖 toId
 * @returns true 表示会导致循环
 */
export function wouldCreateCycle(
  existingNodes: DagNode[],
  fromId: string,
  toId: string,
): boolean {
  const idSet = new Set(existingNodes.map((n) => n.id));
  if (!idSet.has(fromId) || !idSet.has(toId)) return false;

  // BFS 从 fromId 沿 adjList（"谁依赖我"方向）看能否到达 toId
  const adjList = new Map<string, string[]>();
  for (const node of existingNodes) {
    for (const dep of node.dependsOn) {
      if (idSet.has(dep)) {
        if (!adjList.has(dep)) adjList.set(dep, []);
        adjList.get(dep)!.push(node.id);
      }
    }
  }

  const visited = new Set<string>();
  const queue = [fromId];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === toId) return true;
    if (visited.has(curr)) continue;
    visited.add(curr);
    for (const next of adjList.get(curr) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  return false;
}

/**
 * 获取节点的所有祖先节点（递归向上追溯依赖链）
 */
export function getAncestors(nodes: DagNode[], targetId: string): Set<string> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const ancestors = new Set<string>();
  const queue = [targetId];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const node = nodeMap.get(curr);
    if (!node) continue;
    for (const dep of node.dependsOn) {
      if (!ancestors.has(dep)) {
        ancestors.add(dep);
        queue.push(dep);
      }
    }
  }

  return ancestors;
}

/**
 * 获取节点的所有后代节点（递归向下追溯被依赖链）
 */
export function getDescendants(nodes: DagNode[], targetId: string): Set<string> {
  const adjList = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!adjList.has(dep)) adjList.set(dep, []);
      adjList.get(dep)!.push(node.id);
    }
  }

  const descendants = new Set<string>();
  const queue = [targetId];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const next of adjList.get(curr) ?? []) {
      if (!descendants.has(next)) {
        descendants.add(next);
        queue.push(next);
      }
    }
  }

  return descendants;
}

/* ================================================================== */
/*  DAG 自动修复                                                        */
/* ================================================================== */

/**
 * 验证 DAG 并自动修复检测到的问题：
 * 1. 环路检测 → 移除构成环路的边中优先级最低的那条边
 * 2. 孤立节点 → 关联到拓扑排序中最近的前驱节点
 *
 * @param nodes 原始 DAG 节点列表
 * @param priorityFn 可选的优先级函数（数值越小优先级越高）
 * @returns 修复后的 DAG 节点列表 + 修复操作列表
 */
export function autoRepairDAG(
  nodes: DagNode[],
  priorityFn?: (id: string) => number,
): { repairedNodes: DagNode[]; repairs: DagRepairAction[]; validation: DagValidationResult } {
  const repairs: DagRepairAction[] = [];
  // 深拷贝节点以避免修改原始数据
  let workingNodes: DagNode[] = nodes.map(n => ({ id: n.id, dependsOn: [...n.dependsOn] }));
  const idSet = new Set(workingNodes.map(n => n.id));

  // ── 阶段 1: 环路检测与修复 ──
  // 反复检测环路并移除最低优先级边，直到无环
  let maxRepairIterations = workingNodes.length; // 防止无限循环
  while (maxRepairIterations-- > 0) {
    const result = validateDAG(workingNodes);
    if (!result.cycles || result.cycles.length === 0) break;

    // 找出环上的所有边，选择优先级最低的边移除
    const cycleNodeIds = new Set(result.cycles[0]!);
    let worstEdge: { from: string; to: string; score: number } | null = null;

    for (const node of workingNodes) {
      if (!cycleNodeIds.has(node.id)) continue;
      for (const dep of node.dependsOn) {
        if (!cycleNodeIds.has(dep)) continue;
        // 边 node.id -> dep (node.id 依赖 dep)
        // 优先级：取两端节点优先级的最大值（越大越低优先级）
        const edgeScore = priorityFn
          ? Math.max(priorityFn(node.id), priorityFn(dep))
          : 0;
        // 无优先级时，选依赖列表中最后出现的边（启发式：后添加的边更可能是错误）
        const effectiveScore = priorityFn ? edgeScore : (worstEdge ? 1 : 0);
        if (!worstEdge || effectiveScore >= worstEdge.score) {
          worstEdge = { from: node.id, to: dep, score: effectiveScore };
        }
      }
    }

    if (!worstEdge) break; // 安全退出

    // 移除该边
    const targetNode = workingNodes.find(n => n.id === worstEdge!.from);
    if (targetNode) {
      targetNode.dependsOn = targetNode.dependsOn.filter(d => d !== worstEdge!.to);
      repairs.push({
        type: "remove_edge",
        from: worstEdge.from,
        to: worstEdge.to,
        reason: `PlanDAG cycle detected and auto-repaired: removed edge ${worstEdge.from} -> ${worstEdge.to}`,
      });
    }
  }

  // ── 阶段 2: 孤立节点修复 ──
  if (workingNodes.length > 1) {
    // 先做一次拓扑排序获取有效序列
    const sorted = topologicalSortGeneric(workingNodes, priorityFn);
    const sortedIndex = new Map(sorted.map((id, i) => [id, i]));

    const hasIncoming = new Set<string>();
    const hasOutgoing = new Set<string>();
    for (const node of workingNodes) {
      for (const dep of node.dependsOn) {
        if (idSet.has(dep)) {
          hasIncoming.add(node.id);
          hasOutgoing.add(dep);
        }
      }
    }

    // 根节点 = 拓扑序中排在第一位的节点（无入边）
    const rootCandidates = workingNodes.filter(n => n.dependsOn.filter(d => idSet.has(d)).length === 0);
    const rootIds = new Set(rootCandidates.map(n => n.id));

    for (const node of workingNodes) {
      if (hasIncoming.has(node.id) || hasOutgoing.has(node.id)) continue;
      if (rootIds.has(node.id) && rootCandidates.length <= 1) continue; // 唯一根节点不处理

      // 找拓扑排序中位于该节点之前的最近节点作为前驱
      const myIdx = sortedIndex.get(node.id) ?? sorted.length;
      let bestPredecessor: string | null = null;
      let bestDist = Infinity;
      for (let i = myIdx - 1; i >= 0; i--) {
        const dist = myIdx - i;
        if (dist < bestDist) {
          bestDist = dist;
          bestPredecessor = sorted[i]!;
          break;
        }
      }

      if (bestPredecessor) {
        node.dependsOn.push(bestPredecessor);
        repairs.push({
          type: "attach_isolated",
          from: node.id,
          to: bestPredecessor,
          reason: `Isolated node "${node.id}" auto-attached to nearest predecessor "${bestPredecessor}"`,
        });
      }
    }
  }

  // 最终验证
  const finalValidation = validateDAG(workingNodes);
  return { repairedNodes: workingNodes, repairs, validation: finalValidation };
}
