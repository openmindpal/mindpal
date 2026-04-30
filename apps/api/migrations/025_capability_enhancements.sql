-- P4: 工具语义元数据 + P0: 重规划经验闭环
-- 025_capability_enhancements.sql

-- 1. 工具语义元数据：在 tool_definitions 表添加 semantic_meta JSONB 列
ALTER TABLE tool_definitions ADD COLUMN IF NOT EXISTS semantic_meta JSONB DEFAULT NULL;
COMMENT ON COLUMN tool_definitions.semantic_meta IS 'P4: ToolSemanticMeta — operationType/precisionLevel/sideEffects/semanticEquivalents/notEquivalentTo';

-- 2. 重规划经验表：记录 diagnose → strategy → outcome 闭环
CREATE TABLE IF NOT EXISTS replan_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  trace_id TEXT NOT NULL,
  collab_run_id TEXT,
  diagnosis JSONB NOT NULL,
  strategy TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  feasibility_score REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_replan_episodes_tenant_trace ON replan_episodes (tenant_id, trace_id);
CREATE INDEX IF NOT EXISTS idx_replan_episodes_type ON replan_episodes (tenant_id, (diagnosis->>'failureType'), created_at DESC);
