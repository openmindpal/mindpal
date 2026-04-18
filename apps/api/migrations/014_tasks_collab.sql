-- 014: Tasks & Multi-Agent Collaboration
-- Consolidated from: 030, 079, 100, 113, 139, 142, 155

-- ── tasks ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  created_by_subject_id TEXT NOT NULL,
  title TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_tenant_space_time_idx
  ON tasks (tenant_id, space_id, created_at DESC);

-- ── agent_messages ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  task_id UUID NOT NULL REFERENCES tasks(task_id),
  from_agent_id TEXT NULL,
  from_role TEXT NOT NULL,
  intent TEXT NOT NULL,
  correlation JSONB NULL,
  inputs JSONB NULL,
  outputs JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_messages_task_time_idx
  ON agent_messages (task_id, created_at DESC);

-- ── collab_runs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_runs (
  collab_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  task_id UUID NOT NULL REFERENCES tasks(task_id),
  created_by_subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  roles_json JSONB NULL,
  limits_json JSONB NULL,
  primary_run_id UUID NULL REFERENCES runs(run_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_runs_tenant_space_time_idx ON collab_runs (tenant_id, space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_runs_task_time_idx ON collab_runs (task_id, created_at DESC);

-- ── collab_run_events ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_run_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  collab_run_id UUID NOT NULL REFERENCES collab_runs(collab_run_id),
  task_id UUID NOT NULL REFERENCES tasks(task_id),
  type TEXT NOT NULL,
  actor_role TEXT NULL,
  run_id UUID NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  payload_digest JSONB NULL,
  policy_snapshot_ref TEXT NULL,
  correlation_id TEXT NULL,
  -- Responsibility chain (from 142)
  proposed_by TEXT NULL,
  executed_by TEXT NULL,
  reviewed_by TEXT NULL,
  approved_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_run_events_run_time_idx ON collab_run_events (collab_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_run_events_run_corr_time_idx ON collab_run_events (collab_run_id, correlation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_run_events_task_time_idx ON collab_run_events (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collab_run_events_proposed_by ON collab_run_events(tenant_id, proposed_by) WHERE proposed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collab_run_events_executed_by ON collab_run_events(tenant_id, executed_by) WHERE executed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collab_run_events_approved_by ON collab_run_events(tenant_id, approved_by) WHERE approved_by IS NOT NULL;

-- ── collab_envelopes ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_envelopes (
  envelope_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  collab_run_id UUID NOT NULL REFERENCES collab_runs(collab_run_id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  from_role TEXT NOT NULL,
  to_role TEXT NULL,
  broadcast BOOLEAN NOT NULL DEFAULT false,
  kind TEXT NOT NULL,
  correlation_id TEXT NULL,
  policy_snapshot_ref TEXT NULL,
  payload_digest JSONB NOT NULL,
  payload_redacted JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_envelopes_run_time_idx ON collab_envelopes (collab_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_envelopes_run_to_time_idx ON collab_envelopes (collab_run_id, to_role, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_envelopes_run_from_time_idx ON collab_envelopes (collab_run_id, from_role, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_envelopes_run_corr_time_idx ON collab_envelopes (collab_run_id, correlation_id, created_at DESC);

-- ── collab_agent_roles ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_agent_roles (
  agent_role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  role_name TEXT NOT NULL,
  agent_type TEXT NOT NULL DEFAULT 'llm',
  capabilities JSONB DEFAULT '[]'::jsonb,
  constraints JSONB DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  policy_snapshot_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, collab_run_id, role_name)
);

-- ── collab_task_assignments ──────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_task_assignments (
  assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  task_id UUID NOT NULL,
  assigned_role TEXT NOT NULL,
  assigned_by TEXT,
  priority INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  input_digest JSONB,
  output_digest JSONB,
  deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_task_assignments_run ON collab_task_assignments(tenant_id, collab_run_id, status);

-- ── collab_permission_contexts ───────────────────────────────
CREATE TABLE IF NOT EXISTS collab_permission_contexts (
  context_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  role_name TEXT NOT NULL,
  effective_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_rules JSONB,
  row_filters JSONB,
  policy_snapshot_ref TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, collab_run_id, role_name)
);

-- ── collab_turns (P2) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_turns (
  turn_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  turn_number INT NOT NULL,
  actor_role TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT,
  input_digest JSONB,
  output_digest JSONB,
  step_ids JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_turns_run ON collab_turns(tenant_id, collab_run_id, turn_number);

-- ── collab_coordination_events ───────────────────────────────
CREATE TABLE IF NOT EXISTS collab_coordination_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  turn_number INT NOT NULL,
  event_type TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  transition JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_coord_events_run ON collab_coordination_events(tenant_id, collab_run_id, created_at);

-- ── collab_replan_history ────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_replan_history (
  replan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  trigger TEXT NOT NULL,
  strategy TEXT NOT NULL,
  previous_step_count INT NOT NULL DEFAULT 0,
  new_step_count INT NOT NULL DEFAULT 0,
  success BOOLEAN NOT NULL DEFAULT false,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_replan_run ON collab_replan_history(tenant_id, collab_run_id, created_at);

-- ── collab_agent_capabilities ────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_agent_capabilities (
  capability_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  role_name TEXT NOT NULL,
  capability_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  input_schema JSONB,
  output_schema JSONB,
  available BOOLEAN NOT NULL DEFAULT true,
  load_factor DECIMAL(5,2) DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, collab_run_id, role_name, name)
);

CREATE INDEX IF NOT EXISTS idx_collab_caps_run ON collab_agent_capabilities(tenant_id, collab_run_id);

-- ── collab_agent_messages ────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_agent_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  from_role TEXT NOT NULL,
  to_role TEXT,
  message_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  reply_to UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_collab_messages_pending ON collab_agent_messages(tenant_id, collab_run_id, to_role, status, created_at)
  WHERE status IN ('pending', 'delivered');
CREATE INDEX IF NOT EXISTS idx_collab_messages_reply ON collab_agent_messages(tenant_id, reply_to);

-- ── collab_consensus_proposals ───────────────────────────────
CREATE TABLE IF NOT EXISTS collab_consensus_proposals (
  proposal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  proposer TEXT NOT NULL,
  proposal_type TEXT NOT NULL,
  proposal JSONB NOT NULL,
  required_voters JSONB NOT NULL DEFAULT '[]'::jsonb,
  votes JSONB NOT NULL DEFAULT '{}'::jsonb,
  deadline TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_consensus_run ON collab_consensus_proposals(tenant_id, collab_run_id, status);

-- ── collab_global_state ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_global_state (
  state_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  phase TEXT NOT NULL DEFAULT 'initializing',
  current_turn INT NOT NULL DEFAULT 0,
  active_role TEXT,
  role_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_step_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  failed_step_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_step_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  replan_count INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, collab_run_id)
);

-- ── collab_state_updates ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_state_updates (
  update_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  source_role TEXT NOT NULL,
  update_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_state_updates_run ON collab_state_updates(tenant_id, collab_run_id, created_at);

-- ── collab_state_snapshots ───────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_state_snapshots (
  snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  version INT NOT NULL,
  state_data JSONB NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_snapshots_run ON collab_state_snapshots(tenant_id, collab_run_id, version DESC);

-- ── collab_shared_state (P1-4) ───────────────────────────────
CREATE TABLE IF NOT EXISTS collab_shared_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  collab_run_id UUID NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}',
  updated_by_agent TEXT NOT NULL,
  updated_by_role TEXT,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_shared_state_key ON collab_shared_state (tenant_id, collab_run_id, key);
CREATE INDEX IF NOT EXISTS idx_collab_shared_state_run ON collab_shared_state (collab_run_id);

-- ── collab_role_permissions ──────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  collab_run_id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  allowed_tools TEXT[] DEFAULT NULL,
  allowed_resources TEXT[] DEFAULT NULL,
  max_budget INT DEFAULT NULL,
  used_budget INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_role_perm_agent ON collab_role_permissions (tenant_id, collab_run_id, agent_id);

-- ── collab_arbitration_log ───────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_arbitration_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  collab_run_id UUID NOT NULL,
  resource_key TEXT NOT NULL,
  competing_agents TEXT[] NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('priority', 'vote', 'escalate', 'first_writer_wins')),
  winner_agent TEXT,
  reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_arbitration_run ON collab_arbitration_log (collab_run_id);

-- ── collab_cross_validation_log ──────────────────────────────
CREATE TABLE IF NOT EXISTS collab_cross_validation_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  collab_run_id UUID NOT NULL,
  validated_agent TEXT NOT NULL,
  validated_run_id UUID NOT NULL,
  validator_agent TEXT NOT NULL,
  validator_run_id UUID,
  verdict TEXT NOT NULL CHECK (verdict IN ('approved', 'rejected', 'needs_revision')),
  confidence REAL,
  reasoning TEXT,
  revision_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_cross_validation_run ON collab_cross_validation_log (collab_run_id);

-- ── collab_role_performance ──────────────────────────────────
CREATE TABLE IF NOT EXISTS collab_role_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT,
  collab_run_id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  task_completion REAL NOT NULL DEFAULT 0.5,
  quality_score REAL NOT NULL DEFAULT 0.5,
  efficiency_score REAL NOT NULL DEFAULT 0.5,
  collaboration_score REAL NOT NULL DEFAULT 0.5,
  overall_score REAL NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collab_role_perf_tenant ON collab_role_performance (tenant_id, space_id, role, overall_score DESC);

-- ── Seed permissions for collab ──────────────────────────────
INSERT INTO permissions (resource_type, action)
VALUES
  ('agent_runtime', 'collab.create'),
  ('agent_runtime', 'collab.read'),
  ('agent_runtime', 'collab.events'),
  ('agent_runtime', 'collab.envelopes.write'),
  ('agent_runtime', 'collab.envelopes.read'),
  ('agent_runtime', 'collab.arbiter.commit')
ON CONFLICT (resource_type, action) DO NOTHING;
