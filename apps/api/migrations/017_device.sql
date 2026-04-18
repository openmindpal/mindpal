-- 017: Device Runtime
-- Consolidated from: 032, 041, 098, 118, 125(empty), 140, 028_device_metadata

-- ── device_records ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_records (
  device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  owner_scope TEXT NOT NULL,
  owner_subject_id TEXT NULL,
  space_id TEXT NULL REFERENCES spaces(id),
  device_type TEXT NOT NULL,
  os TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  status TEXT NOT NULL,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  device_token_hash TEXT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_records_owner_idx
  ON device_records (tenant_id, owner_scope, owner_subject_id, space_id, enrolled_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS device_records_token_hash_unique
  ON device_records (device_token_hash) WHERE device_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_device_records_metadata
  ON device_records USING GIN (metadata) WHERE metadata IS NOT NULL AND metadata != '{}'::jsonb;

-- ── device_pairings ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_pairings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id UUID NOT NULL REFERENCES device_records(device_id),
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS device_pairings_code_hash_unique ON device_pairings (code_hash);
CREATE INDEX IF NOT EXISTS device_pairings_expiry_idx ON device_pairings (expires_at);

-- ── device_policies ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_policies (
  device_id UUID PRIMARY KEY REFERENCES device_records(device_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  allowed_tools JSONB NULL,
  file_policy JSONB NULL,
  network_policy JSONB NULL,
  limits JSONB NULL,
  ui_policy JSONB NULL,
  evidence_policy JSONB NULL,
  policy_rules JSONB DEFAULT '{}'::jsonb,
  max_concurrency INT DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── device_executions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_executions (
  device_execution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  created_by_subject_id TEXT NULL,
  device_id UUID NOT NULL REFERENCES device_records(device_id),
  tool_ref TEXT NOT NULL,
  policy_snapshot_ref TEXT NULL,
  idempotency_key TEXT NULL,
  require_user_presence BOOLEAN NOT NULL DEFAULT false,
  input_json JSONB NULL,
  input_digest JSONB NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  output_digest JSONB NULL,
  evidence_refs JSONB NULL,
  error_category TEXT NULL,
  claimed_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  canceled_at TIMESTAMPTZ NULL,
  run_id TEXT NULL,
  step_id TEXT NULL,
  session_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_executions_lookup_idx
  ON device_executions (tenant_id, device_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS device_executions_space_idx
  ON device_executions (tenant_id, space_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS device_executions_run_step_idx
  ON device_executions (tenant_id, run_id, step_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_executions_completed_pending_resume_idx
  ON device_executions (tenant_id, status, completed_at)
  WHERE run_id IS NOT NULL AND status IN ('succeeded', 'failed');
CREATE INDEX IF NOT EXISTS idx_device_exec_session
  ON device_executions(tenant_id, session_id);

-- ── device_sessions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  phase TEXT NOT NULL DEFAULT 'init',
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_version TEXT,
  heartbeat_interval_ms INT NOT NULL DEFAULT 30000,
  session_timeout_ms INT NOT NULL DEFAULT 300000,
  current_concurrency INT NOT NULL DEFAULT 0,
  max_concurrency INT NOT NULL DEFAULT 5,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_sessions_device ON device_sessions(tenant_id, device_id, status);
CREATE INDEX IF NOT EXISTS idx_device_sessions_active ON device_sessions(tenant_id, status, last_activity_at) WHERE status = 'active';

-- ── device_states ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_states (
  state_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'offline',
  active_tasks INT NOT NULL DEFAULT 0,
  pending_tasks INT NOT NULL DEFAULT 0,
  resources JSONB,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INT NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_device_states_state ON device_states(tenant_id, state);

-- ── device_state_events ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_state_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id UUID NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_state_events ON device_state_events(tenant_id, device_id, created_at DESC);

-- ── device_pending_commands ──────────────────────────────────
CREATE TABLE IF NOT EXISTS device_pending_commands (
  command_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id UUID NOT NULL,
  message_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  sequence INT NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_device_commands_pending ON device_pending_commands(tenant_id, device_id, status, sequence) WHERE status = 'pending';
