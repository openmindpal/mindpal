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
