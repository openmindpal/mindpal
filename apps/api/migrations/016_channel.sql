-- 016: Channel & Event Reasoning
-- Consolidated from: 019, 020, 035, 077, 078, 085, 108, 122, 126

-- ── channel_webhook_configs ──────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_webhook_configs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  space_id TEXT NULL,
  secret_env_key TEXT NULL,
  tolerance_sec INT NOT NULL DEFAULT 300,
  delivery_mode TEXT NOT NULL DEFAULT 'sync',
  max_attempts INT NOT NULL DEFAULT 8,
  backoff_ms_base INT NOT NULL DEFAULT 500,
  provider_config JSONB NULL,
  secret_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, workspace_id)
);

CREATE INDEX IF NOT EXISTS channel_webhook_configs_lookup_idx
  ON channel_webhook_configs (tenant_id, provider, workspace_id, updated_at DESC);

-- ── channel_accounts ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_accounts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  space_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, workspace_id, channel_user_id)
);

CREATE INDEX IF NOT EXISTS channel_accounts_lookup_idx
  ON channel_accounts (tenant_id, provider, workspace_id, subject_id, updated_at DESC);

-- ── channel_chat_bindings ────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_chat_bindings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_chat_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  default_subject_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, workspace_id, channel_chat_id)
);

CREATE INDEX IF NOT EXISTS channel_chat_bindings_lookup_idx
  ON channel_chat_bindings (tenant_id, provider, workspace_id, space_id, updated_at DESC);

-- ── channel_ingress_events ───────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_ingress_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  request_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  response_status_code INT NULL,
  response_json JSONB NULL,
  body_json JSONB NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NULL,
  last_error_category TEXT NULL,
  last_error_digest JSONB NULL,
  deadlettered_at TIMESTAMPTZ NULL,
  space_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, workspace_id, event_id),
  UNIQUE (tenant_id, provider, workspace_id, nonce)
);

CREATE INDEX IF NOT EXISTS channel_ingress_events_status_idx
  ON channel_ingress_events (tenant_id, provider, workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS channel_ingress_events_space_idx
  ON channel_ingress_events (tenant_id, space_id, created_at DESC);

-- ── channel_outbox_messages ──────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_outbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_chat_id TEXT NOT NULL,
  to_user_id TEXT NULL,
  request_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  message_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivered_at TIMESTAMPTZ NULL,
  acked_at TIMESTAMPTZ NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NULL,
  last_error_category TEXT NULL,
  last_error_digest JSONB NULL,
  deadlettered_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_outbox_poll_idx
  ON channel_outbox_messages (tenant_id, provider, workspace_id, channel_chat_id, delivered_at, created_at ASC);
CREATE INDEX IF NOT EXISTS channel_outbox_request_idx
  ON channel_outbox_messages (tenant_id, request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS channel_outbox_status_attempt_idx
  ON channel_outbox_messages (tenant_id, status, next_attempt_at, created_at ASC);
CREATE INDEX IF NOT EXISTS channel_outbox_chat_time_idx
  ON channel_outbox_messages (tenant_id, provider, workspace_id, channel_chat_id, created_at DESC);

-- ── channel_binding_states ───────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_binding_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  target_subject_id TEXT NULL,
  state_hash TEXT NOT NULL,
  label TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  bound_channel_user_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_binding_states_hash_unique ON channel_binding_states (state_hash);
CREATE INDEX IF NOT EXISTS channel_binding_states_tenant_status_idx ON channel_binding_states (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS channel_binding_states_tenant_provider_idx ON channel_binding_states (tenant_id, provider, workspace_id, created_at DESC);

-- ── event_reasoning_logs ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_reasoning_logs (
  reasoning_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT,
  event_source_id TEXT,
  event_type TEXT NOT NULL,
  provider TEXT,
  workspace_id TEXT,
  event_payload JSONB,
  tier TEXT NOT NULL DEFAULT 'rule',
  decision TEXT NOT NULL DEFAULT 'ignore',
  confidence REAL,
  reasoning_text TEXT,
  action_kind TEXT,
  action_ref TEXT,
  action_input JSONB,
  run_id UUID,
  step_id UUID,
  matched_rule_id TEXT,
  match_digest JSONB,
  latency_ms INT,
  trace_id TEXT,
  error_category TEXT,
  error_digest JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_reasoning_logs_tenant_created_idx ON event_reasoning_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS event_reasoning_logs_tenant_decision_idx ON event_reasoning_logs (tenant_id, decision, created_at DESC);
CREATE INDEX IF NOT EXISTS event_reasoning_logs_event_source_idx ON event_reasoning_logs (tenant_id, event_source_id);

-- ── event_reasoning_rules ────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_reasoning_rules (
  rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'enabled',
  tier TEXT NOT NULL DEFAULT 'rule',
  priority INT NOT NULL DEFAULT 100,
  event_type_pattern TEXT,
  provider_pattern TEXT,
  condition_expr JSONB,
  decision TEXT NOT NULL DEFAULT 'execute',
  action_kind TEXT,
  action_ref TEXT,
  action_input_template JSONB,
  created_by_subject_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS event_reasoning_rules_tenant_status_idx
  ON event_reasoning_rules (tenant_id, status, priority ASC);

-- ============ merged from 030_channel_setup.sql ============
-- 030: Channel setup enhancements — QR-code auto-provisioning support
ALTER TABLE channel_webhook_configs
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_provisioned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admission_policy TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS display_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS setup_state JSONB NULL;

-- admission_policy: 'open' (所有人可用) | 'pairing' (需配对)
-- auto_provisioned: true 表示通过扫码自动创建
-- setup_state: 存储平台返回的额外状态（如 webhook_registration_id）

CREATE INDEX IF NOT EXISTS channel_webhook_configs_enabled_idx
  ON channel_webhook_configs (tenant_id, enabled, provider);

-- ============ merged from 031_outbox_external_msg_id.sql ============
ALTER TABLE channel_outbox_messages
  ADD COLUMN IF NOT EXISTS external_message_id TEXT NULL;

COMMENT ON COLUMN channel_outbox_messages.external_message_id
  IS '平台侧消息 ID，用于后续编辑/更新消息';
