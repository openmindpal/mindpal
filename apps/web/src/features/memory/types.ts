export type MemoryClass = 'episodic' | 'semantic' | 'procedural';

export interface MemoryNodeData extends Record<string, unknown> {
  id: string;
  title: string;
  memoryClass: MemoryClass;
  confidence: number;
  decayScore: number;
  createdAt: string;
}

export interface MemoryEdgeData {
  id: string;
  source: string;
  target: string;
  type: 'distillation' | 'association';
  weight: number;
}

// 颜色映射
export const CLASS_COLORS: Record<MemoryClass, string> = {
  episodic: 'oklch(0.65 0.18 250)',   // 蓝
  semantic: 'oklch(0.65 0.18 145)',   // 绿
  procedural: 'oklch(0.65 0.18 55)', // 橙
};
