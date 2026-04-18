"use client";

/**
 * FlowRenderer — 基于 @xyflow/react 的流程图可视化组件
 *
 * NL2UI 2.0 核心组件之一：
 * - 支持自然语言描述的流程自动转换为可视化节点+边
 * - 支持交互式编辑（拖拽、连线、缩放）
 * - 与 NL2UI 数据绑定系统集成
 */
import React, { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type OnConnect,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// ─── 类型定义 ──────────────────────────────────────────────────

/** NL2UI 流程节点数据 */
export interface FlowNodeData {
  label: string;
  description?: string;
  status?: "pending" | "active" | "completed" | "error";
  icon?: string;
  color?: string;
  /** 数据绑定引用 */
  dataBindingId?: string;
  /** 动作绑定引用 */
  actionBindingId?: string;
  /** 自定义元数据 */
  meta?: Record<string, unknown>;
}

/** 流程图配置 (由 NL2UI generator 生成) */
export interface FlowConfig {
  /** 节点列表 */
  nodes: Array<{
    id: string;
    type?: "default" | "input" | "output" | "step" | "decision" | "action";
    label: string;
    description?: string;
    status?: FlowNodeData["status"];
    position?: { x: number; y: number };
    color?: string;
    meta?: Record<string, unknown>;
  }>;
  /** 边/连线列表 */
  edges: Array<{
    id?: string;
    source: string;
    target: string;
    label?: string;
    animated?: boolean;
    type?: "default" | "straight" | "step" | "smoothstep";
  }>;
  /** 布局方向 */
  direction?: "TB" | "LR" | "BT" | "RL";
  /** 是否允许交互编辑 */
  interactive?: boolean;
  /** 是否显示小地图 */
  showMiniMap?: boolean;
}

export interface FlowRendererProps {
  /** 流程图配置 */
  config: FlowConfig;
  /** 容器宽度 */
  width?: string | number;
  /** 容器高度 */
  height?: string | number;
  /** 节点点击回调 */
  onNodeClick?: (nodeId: string, data: FlowNodeData) => void;
  /** 连线变更回调 */
  onEdgesChange?: (edges: Edge[]) => void;
  /** 样式覆盖 */
  className?: string;
}

// ─── 自定义节点 ──────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: "#94a3b8",
  active: "#3b82f6",
  completed: "#22c55e",
  error: "#ef4444",
};

function StepNode({ data }: { data: FlowNodeData }) {
  const borderColor = data.color ?? STATUS_COLORS[data.status ?? "pending"] ?? "#e2e8f0";
  const bgColor = data.status === "active" ? `${borderColor}10` : "#ffffff";
  return (
    <div style={{
      padding: "12px 20px",
      borderRadius: 10,
      border: `2px solid ${borderColor}`,
      background: bgColor,
      minWidth: 140,
      maxWidth: 280,
      textAlign: "center",
      fontSize: 13,
      fontFamily: "inherit",
      boxShadow: data.status === "active" ? `0 0 12px ${borderColor}30` : "0 1px 3px rgba(0,0,0,0.05)",
      transition: "all 0.2s ease",
    }}>
      <Handle type="target" position={Position.Top} style={{ background: borderColor }} />
      <div style={{ fontWeight: 600, marginBottom: data.description ? 4 : 0 }}>{data.label}</div>
      {data.description && (
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{data.description}</div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: borderColor }} />
    </div>
  );
}

function DecisionNode({ data }: { data: FlowNodeData }) {
  const borderColor = data.color ?? "#f59e0b";
  return (
    <div style={{
      padding: "14px 24px",
      borderRadius: 4,
      border: `2px solid ${borderColor}`,
      background: `${borderColor}08`,
      minWidth: 100,
      textAlign: "center",
      transform: "rotate(0deg)",
      fontSize: 13,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: borderColor }} />
      <div style={{ fontWeight: 600 }}>◆ {data.label}</div>
      {data.description && (
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{data.description}</div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: borderColor }} />
    </div>
  );
}

function ActionNode({ data }: { data: FlowNodeData }) {
  const borderColor = data.color ?? "#8b5cf6";
  return (
    <div style={{
      padding: "10px 18px",
      borderRadius: 20,
      border: `2px solid ${borderColor}`,
      background: `${borderColor}08`,
      minWidth: 120,
      textAlign: "center",
      fontSize: 13,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: borderColor }} />
      <div style={{ fontWeight: 600 }}>⚡ {data.label}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: borderColor }} />
    </div>
  );
}

const customNodeTypes: NodeTypes = {
  step: StepNode,
  decision: DecisionNode,
  action: ActionNode,
};

// ─── 自动布局 ──────────────────────────────────────────────────

function autoLayout(
  nodes: FlowConfig["nodes"],
  edges: FlowConfig["edges"],
  direction: FlowConfig["direction"] = "TB",
): Node[] {
  const isVertical = direction === "TB" || direction === "BT";
  const xGap = isVertical ? 200 : 180;
  const yGap = isVertical ? 120 : 160;

  // 拓扑排序
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, []);
    inDeg.set(n.id, 0);
  }
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }

  const levels: string[][] = [];
  let queue = nodes.filter(n => (inDeg.get(n.id) ?? 0) === 0).map(n => n.id);
  const visited = new Set<string>();

  while (queue.length > 0) {
    levels.push([...queue]);
    const next: string[] = [];
    for (const id of queue) {
      visited.add(id);
      for (const target of adj.get(id) ?? []) {
        if (!visited.has(target)) {
          const deg = (inDeg.get(target) ?? 1) - 1;
          inDeg.set(target, deg);
          if (deg === 0) next.push(target);
        }
      }
    }
    queue = next;
  }

  // 未被排序到的节点放最后一层
  const remaining = nodes.filter(n => !visited.has(n.id)).map(n => n.id);
  if (remaining.length > 0) levels.push(remaining);

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const result: Node[] = [];

  for (let li = 0; li < levels.length; li++) {
    const level = levels[li]!;
    const totalWidth = (level.length - 1) * xGap;
    const startX = -totalWidth / 2;

    for (let ni = 0; ni < level.length; ni++) {
      const nId = level[ni]!;
      const orig = nodeMap.get(nId);
      if (!orig) continue;

      const x = isVertical ? startX + ni * xGap : li * xGap;
      const y = isVertical ? li * yGap : startX + ni * yGap;

      result.push({
        id: nId,
        type: orig.type === "decision" ? "decision" : orig.type === "action" ? "action" : "step",
        position: orig.position ?? { x, y },
        data: {
          label: orig.label,
          description: orig.description,
          status: orig.status,
          color: orig.color,
          meta: orig.meta,
        } satisfies FlowNodeData,
      });
    }
  }

  return result;
}

// ─── 主组件 ──────────────────────────────────────────────────

export function FlowRenderer({
  config,
  width = "100%",
  height = 480,
  onNodeClick,
  className,
}: FlowRendererProps) {
  const initialNodes = useMemo(() => autoLayout(config.nodes, config.edges, config.direction), [config]);
  const initialEdges = useMemo<Edge[]>(() =>
    config.edges.map((e, i) => ({
      id: e.id ?? `e-${e.source}-${e.target}-${i}`,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: e.animated ?? false,
      type: e.type ?? "smoothstep",
      style: { strokeWidth: 2, stroke: "#94a3b8" },
      labelStyle: { fontSize: 11, fill: "#64748b" },
    })),
    [config.edges],
  );

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => setEdges((eds: Edge[]) => addEdge({ ...connection, type: "smoothstep" }, eds)),
    [setEdges],
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onNodeClick?.(node.id, node.data as unknown as FlowNodeData);
    },
    [onNodeClick],
  );

  return (
    <div
      className={className}
      style={{
        width,
        height,
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        overflow: "hidden",
        background: "#fafbfc",
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={config.interactive ? handleConnect : undefined}
        onNodeClick={handleNodeClick}
        nodeTypes={customNodeTypes}
        fitView
        attributionPosition="bottom-left"
        nodesDraggable={config.interactive !== false}
        nodesConnectable={config.interactive === true}
      >
        <Background color="#e2e8f0" gap={20} size={1} />
        <Controls showInteractive={false} />
        {config.showMiniMap && (
          <MiniMap
            nodeStrokeWidth={3}
            zoomable
            pannable
            style={{ borderRadius: 8 }}
          />
        )}
      </ReactFlow>
    </div>
  );
}

export default FlowRenderer;
