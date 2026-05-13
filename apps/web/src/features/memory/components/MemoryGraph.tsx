"use client";

import { useCallback, useEffect } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type NodeMouseHandler,
  type Node,
  type NodeTypes,
  type EdgeTypes,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { MemoryNode } from "./MemoryNode";
import { MemoryEdge } from "./MemoryEdge";
import type { MemoryNodeData } from "../types";
import { CLASS_COLORS } from "../types";
import { useMemoryGraph, type MemoryGraphFilter } from "../hooks/useMemoryGraph";

interface MemoryGraphProps {
  filter: MemoryGraphFilter;
  onNodeSelect: (node: MemoryNodeData | null) => void;
}

const nodeTypes: NodeTypes = { memoryNode: MemoryNode as unknown as NodeTypes[string] };
const edgeTypes: EdgeTypes = { memoryEdge: MemoryEdge as unknown as EdgeTypes[string] };

const defaultEdgeOptions = {
  markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
};

export function MemoryGraph({ filter, onNodeSelect }: MemoryGraphProps) {
  const { nodes: fetchedNodes, edges: fetchedEdges, total, isLoading, error } = useMemoryGraph(filter);

  const [nodes, setNodes, onNodesChange] = useNodesState(fetchedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(fetchedEdges);

  // Sync fetched data to state when query updates
  useEffect(() => {
    setNodes(fetchedNodes);
    setEdges(fetchedEdges);
  }, [fetchedNodes, fetchedEdges, setNodes, setEdges]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      onNodeSelect(node.data as unknown as MemoryNodeData);
    },
    [onNodeSelect],
  );

  const onPaneClick = useCallback(() => {
    onNodeSelect(null);
  }, [onNodeSelect]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[oklch(0.1_0.02_250)]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[oklch(0.4_0.1_250)] border-t-[oklch(0.7_0.15_250)] rounded-full animate-spin" />
          <span className="text-sm text-[oklch(0.5_0.02_250)]">加载记忆图谱…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[oklch(0.1_0.02_250)]">
        <div className="flex flex-col items-center gap-2 text-center px-4">
          <span className="text-sm text-[oklch(0.6_0.12_30)]">加载失败</span>
          <span className="text-xs text-[oklch(0.5_0.02_250)]">{error.message}</span>
        </div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[oklch(0.1_0.02_250)]">
        <span className="text-sm text-[oklch(0.5_0.02_250)]">暂无记忆数据</span>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full relative">
      {/* Node statistics bar */}
      {total > 0 && (
        <div className="absolute top-3 left-3 z-10 flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[oklch(0.15_0.02_250/0.85)] border border-[oklch(0.3_0.02_250)] backdrop-blur-sm">
          <span className="text-xs text-[oklch(0.7_0.02_250)]">
            显示 {nodes.length} / {total} 条记忆
          </span>
          {total > (filter.limit ?? 200) && (
            <span className="text-[10px] text-[oklch(0.5_0.02_250)]">
              请调整过滤条件查看更多
            </span>
          )}
        </div>
      )}
      {/* SVG marker definitions */}
      <svg className="absolute w-0 h-0">
        <defs>
          <marker
            id="arrowhead"
            markerWidth="12"
            markerHeight="12"
            refX="10"
            refY="6"
            orient="auto"
          >
            <path d="M0,0 L12,6 L0,12 Z" fill="oklch(0.6 0.05 250)" />
          </marker>
        </defs>
      </svg>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
        className="bg-[oklch(0.1_0.02_250)]"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="oklch(0.2 0.02 250)" />
        <Controls
          className="!bg-[oklch(0.18_0.02_250)] !border-[oklch(0.3_0.02_250)] !shadow-lg [&>button]:!bg-[oklch(0.2_0.02_250)] [&>button]:!border-[oklch(0.3_0.02_250)] [&>button]:!text-[oklch(0.7_0.02_250)] [&>button:hover]:!bg-[oklch(0.25_0.02_250)]"
        />
        <MiniMap
          nodeColor={(n) => {
            const data = n.data as MemoryNodeData | undefined;
            return data?.memoryClass ? CLASS_COLORS[data.memoryClass] : "oklch(0.4 0.02 250)";
          }}
          maskColor="oklch(0.05 0.02 250 / 0.7)"
          className="!bg-[oklch(0.12_0.02_250)] !border-[oklch(0.3_0.02_250)]"
        />
      </ReactFlow>
    </div>
  );
}
