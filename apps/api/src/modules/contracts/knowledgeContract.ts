/**
 * knowledgeContract.ts — Knowledge RAG 跨层契约
 *
 * 目的：解耦 modules/agentContext 对 skills/knowledge-rag 的直接依赖。
 * agentContext 通过此契约间接调用知识混合检索，skills 在启动时注册实现。
 *
 * 依赖方向：
 *   modules/agentContext → modules/contracts (✓)
 *   skills/knowledge-rag → modules/contracts (✓，skills 可 import modules)
 */
import type { Pool } from "pg";

// ─── 检索参数与结果类型 ───

export interface SearchChunksHybridParams {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  query: string;
  limit: number;
  lexicalLimit?: number;
  embedLimit?: number;
  documentIds?: string[];
  tags?: string[];
  sourceTypes?: string[];
  strategyRef?: string | null;
  strategyConfig?: any | null;
}

export interface SearchChunksHybridResult {
  hits: Array<{ snippet: string; [k: string]: any }>;
  searchMode?: string;
  [k: string]: any;
}

// ─── 契约接口 ───

export interface KnowledgeContract {
  searchChunksHybrid(params: SearchChunksHybridParams): Promise<SearchChunksHybridResult>;
}

// ─── 注册 / 获取 ───

let _impl: KnowledgeContract | null = null;

export function registerKnowledgeContract(impl: KnowledgeContract): void {
  if (_impl) throw new Error("[knowledgeContract] 重复注册");
  _impl = impl;
}

export function getKnowledgeContract(): KnowledgeContract {
  if (!_impl) throw new Error("[knowledgeContract] 未注册 — 请确保 skills/knowledge-rag 已初始化");
  return _impl;
}
