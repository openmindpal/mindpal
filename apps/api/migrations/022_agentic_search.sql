-- migration-aliases: 026_agentic_search.sql
-- 023: Agentic Search — 多轮搜索验证持久化 (renumbered from 026)
-- 关联: knowledge-rag/modules/agenticSearch.ts
-- 实现 RAG + Agentic Search 混合范式

-- ── agentic_search_sessions ─────────────────────────────────────
-- 搜索会话主表：记录一次完整的 Agentic Search 生命周期
CREATE TABLE IF NOT EXISTS agentic_search_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  subject_id TEXT NULL,
  -- 原始查询
  original_query TEXT NOT NULL,
  -- 搜索策略: simple=单次RAG, agentic=多轮验证搜索
  strategy TEXT NOT NULL DEFAULT 'simple'
    CHECK (strategy IN ('simple', 'agentic', 'hybrid')),
  -- 搜索状态
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'searching', 'verifying', 'completed', 'failed', 'timeout')),
  -- 总轮次
  total_rounds INT NOT NULL DEFAULT 0,
  max_rounds INT NOT NULL DEFAULT 5,
  -- 最终置信度 (0~1)
  final_confidence NUMERIC(4,3) NULL,
  -- 是否需要审批（敏感数据查询）
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  -- 搜索元数据
  metadata JSONB NULL DEFAULT '{}',
  -- 总耗时(ms)
  total_duration_ms INT NULL,
  -- 追踪
  trace_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agentic_search_sessions_tenant
  ON agentic_search_sessions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agentic_search_sessions_status
  ON agentic_search_sessions(tenant_id, status);

-- ── agentic_search_steps ────────────────────────────────────────
-- 搜索步骤：每一轮搜索-验证的详细记录
CREATE TABLE IF NOT EXISTS agentic_search_steps (
  step_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES agentic_search_sessions(session_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  -- 轮次编号（0-based）
  round INT NOT NULL DEFAULT 0,
  -- 步骤类型: query_rewrite=查询改写, search=执行搜索, verify=结果验证, synthesize=综合
  step_type TEXT NOT NULL
    CHECK (step_type IN ('query_rewrite', 'search', 'verify', 'cross_check', 'synthesize', 'tool_call')),
  -- 步骤输入
  input JSONB NOT NULL DEFAULT '{}',
  -- 步骤输出
  output JSONB NULL,
  -- 使用的子查询（查询改写后的变体）
  sub_queries JSONB NULL DEFAULT '[]',
  -- 本步骤命中的证据引用
  evidence_refs JSONB NULL DEFAULT '[]',
  -- 步骤状态
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  -- 置信度评分 (0~1)
  confidence NUMERIC(4,3) NULL,
  -- 耗时(ms)
  duration_ms INT NULL,
  -- 错误信息
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agentic_search_steps_session
  ON agentic_search_steps(session_id, round, step_type);

-- ── agentic_search_evidence ─────────────────────────────────────
-- 搜索证据聚合表：跨轮次去重与评分
CREATE TABLE IF NOT EXISTS agentic_search_evidence (
  evidence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES agentic_search_sessions(session_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  -- 来源 chunk
  chunk_id UUID NULL,
  document_id UUID NULL,
  -- 证据摘要
  snippet TEXT NOT NULL,
  -- 来源引用
  source_ref JSONB NOT NULL DEFAULT '{}',
  -- 综合评分 (0~1): 多轮搜索+验证后的最终可信度
  aggregate_score NUMERIC(4,3) NOT NULL DEFAULT 0,
  -- 被多少轮搜索命中
  hit_count INT NOT NULL DEFAULT 1,
  -- 验证状态: unverified/verified/contradicted/uncertain
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'verified', 'contradicted', 'uncertain')),
  -- 交叉验证引用（哪些其他证据支持/矛盾）
  cross_refs JSONB NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agentic_search_evidence_session
  ON agentic_search_evidence(session_id, aggregate_score DESC);
CREATE INDEX IF NOT EXISTS idx_agentic_search_evidence_chunk
  ON agentic_search_evidence(chunk_id) WHERE chunk_id IS NOT NULL;
