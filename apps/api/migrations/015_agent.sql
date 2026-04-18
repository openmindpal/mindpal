-- 015: Agent Loop & Goal System
-- Consolidated from: 152, 153

-- ── agent_loop_checkpoints ───────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_loop_checkpoints (
  loop_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT,
  run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  job_id UUID NOT NULL,
  task_id UUID,
  iteration INT NOT NULL DEFAULT 0,
  current_seq INT NOT NULL DEFAULT 1,
  succeeded_steps INT NOT NULL DEFAULT 0,
  failed_steps INT NOT NULL DEFAULT 0,
  observations_digest JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_decision JSONB,
  decision_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  goal TEXT NOT NULL,
  max_iterations INT NOT NULL DEFAULT 15,
  max_wall_time_ms BIGINT NOT NULL DEFAULT 600000,
  subject_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  "authorization" TEXT,
  trace_id TEXT,
  default_model_ref TEXT,
  tool_discovery_cache JSONB,
  memory_context TEXT,
  task_history TEXT,
  knowledge_context TEXT,
  node_id TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','paused','resuming','succeeded','failed','interrupted','expired')),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  resumed_from UUID REFERENCES agent_loop_checkpoints(loop_id),
  resume_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alc_status_heartbeat ON agent_loop_checkpoints (status, heartbeat_at) WHERE status IN ('running', 'resuming');
CREATE INDEX IF NOT EXISTS idx_alc_run_id ON agent_loop_checkpoints (run_id);
CREATE INDEX IF NOT EXISTS idx_alc_tenant ON agent_loop_checkpoints (tenant_id, status);

-- ── agent_processes ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_processes (
  process_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT,
  run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  loop_id UUID REFERENCES agent_loop_checkpoints(loop_id) ON DELETE SET NULL,
  priority INT NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 10),
  resource_quota JSONB NOT NULL DEFAULT '{}'::jsonb,
  parent_process_id UUID REFERENCES agent_processes(process_id) ON DELETE SET NULL,
  node_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','paused','succeeded','failed','interrupted','preempted')),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ap_status_priority ON agent_processes (status, priority DESC) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_ap_parent ON agent_processes (parent_process_id) WHERE parent_process_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ap_tenant_status ON agent_processes (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_ap_run_id ON agent_processes (run_id);

-- ── goal_graphs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goal_graphs (
  graph_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT,
  run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  loop_id UUID REFERENCES agent_loop_checkpoints(loop_id) ON DELETE SET NULL,
  main_goal TEXT NOT NULL,
  graph_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  decomposition_reasoning TEXT,
  decomposed_by_model TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','decomposed','executing','verifying','completed','failed','replanning')),
  version INT NOT NULL DEFAULT 1,
  verification_verdict TEXT CHECK (verification_verdict IN ('verified','rejected','needs_more_info')),
  verification_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goal_graphs_run_id ON goal_graphs (run_id);
CREATE INDEX IF NOT EXISTS idx_goal_graphs_tenant_status ON goal_graphs (tenant_id, status);

-- ── world_state_snapshots ────────────────────────────────────
CREATE TABLE IF NOT EXISTS world_state_snapshots (
  state_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  graph_id UUID REFERENCES goal_graphs(graph_id) ON DELETE SET NULL,
  state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_iteration INT NOT NULL DEFAULT 0,
  after_step_seq INT NOT NULL DEFAULT 0,
  entity_count INT NOT NULL DEFAULT 0,
  relation_count INT NOT NULL DEFAULT 0,
  fact_count INT NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_world_state_snapshots_run ON world_state_snapshots (run_id, after_iteration);

-- ── goal_verification_log ────────────────────────────────────
CREATE TABLE IF NOT EXISTS goal_verification_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  graph_id UUID REFERENCES goal_graphs(graph_id) ON DELETE SET NULL,
  loop_id UUID REFERENCES agent_loop_checkpoints(loop_id) ON DELETE SET NULL,
  iteration INT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('verified','rejected','needs_more_info')),
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  reasoning TEXT,
  criteria_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_fixes JSONB,
  missing_info JSONB,
  verified_by_model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goal_verification_log_run ON goal_verification_log (run_id, created_at);
