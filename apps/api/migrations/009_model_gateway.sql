-- 009: Model Gateway
-- Consolidated from: 009, 032(provider_protocol_family), 048a, 074, 076, 093, 096, 101(skip data), 109, 117(skip data), 123, 147, 156
-- Skipped: 083/129 (model_budgets created then dropped), 101/117 (data migration UPDATE only)

-- ── provider_bindings ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  connector_instance_id UUID NOT NULL REFERENCES connector_instances(id),
  secret_id UUID NOT NULL REFERENCES secret_records(id),
  secret_ids JSONB NOT NULL,
  base_url TEXT NULL,
  chat_completions_path TEXT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_bindings_unique_scope_model
  ON provider_bindings (tenant_id, scope_type, scope_id, model_ref);

CREATE INDEX IF NOT EXISTS provider_bindings_by_connector
  ON provider_bindings (tenant_id, connector_instance_id);

-- ── model_usage_events ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT NULL,
  subject_id TEXT NULL,
  user_id TEXT NULL,
  scene TEXT NULL,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  prompt_tokens INT NULL,
  completion_tokens INT NULL,
  total_tokens INT NULL,
  latency_ms INT NULL,
  result TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_usage_events_tenant_time_idx
  ON model_usage_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS model_usage_events_tenant_space_time_idx
  ON model_usage_events (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS model_usage_events_tenant_model_time_idx
  ON model_usage_events (tenant_id, model_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS model_usage_events_tenant_user_time_idx
  ON model_usage_events (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS model_usage_events_tenant_scene_time_idx
  ON model_usage_events (tenant_id, scene, created_at DESC);

-- ── routing_policies ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routing_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  purpose TEXT NOT NULL,
  primary_model_ref TEXT NOT NULL,
  fallback_model_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, purpose)
);

CREATE INDEX IF NOT EXISTS routing_policies_lookup_idx
  ON routing_policies (tenant_id, purpose);

-- ── routing_policies_overrides ───────────────────────────────
CREATE TABLE IF NOT EXISTS routing_policies_overrides (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  purpose TEXT NOT NULL,
  primary_model_ref TEXT NOT NULL,
  fallback_model_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, purpose)
);

CREATE INDEX IF NOT EXISTS routing_policies_overrides_lookup_idx
  ON routing_policies_overrides (tenant_id, space_id, purpose);

-- ── quota_limits ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quota_limits (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  model_chat_rpm INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS quota_limits_lookup_idx
  ON quota_limits (tenant_id, scope_type, scope_id);

-- ── tool_limits ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_limits (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  tool_ref TEXT NOT NULL,
  default_max_concurrency INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tool_ref)
);

CREATE INDEX IF NOT EXISTS tool_limits_lookup_idx
  ON tool_limits (tenant_id, tool_ref);

-- ── tool_limits_overrides ────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_limits_overrides (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  tool_ref TEXT NOT NULL,
  default_max_concurrency INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, tool_ref)
);

CREATE INDEX IF NOT EXISTS tool_limits_overrides_lookup_idx
  ON tool_limits_overrides (tenant_id, space_id, tool_ref);

-- ── model_provider_registry ──────────────────────────────────
CREATE TABLE IF NOT EXISTS model_provider_registry (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NULL,
  protocol_family TEXT NOT NULL DEFAULT 'openai',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NULL,
  PRIMARY KEY (tenant_id, provider)
);

COMMENT ON COLUMN model_provider_registry.protocol_family IS
  '协议族: openai(OpenAI兼容)/anthropic(Anthropic原生)/gemini(Google Gemini原生)';

INSERT INTO model_provider_registry (tenant_id, provider, status, reason, protocol_family)
SELECT t.id, p.provider, 'enabled', NULL, p.family
FROM tenants t
CROSS JOIN (
  VALUES
    ('openai',             'openai'),
    ('mock',               'openai'),
    ('openai_compatible',  'openai'),
    ('deepseek',           'openai'),
    ('hunyuan',            'openai'),
    ('qianwen',            'openai'),
    ('zhipu',              'openai'),
    ('doubao',             'openai'),
    ('kimi',               'openai'),
    ('kimimax',            'openai'),
    ('anthropic',          'anthropic'),
    ('custom_anthropic',   'anthropic'),
    ('custom_gemini',      'gemini')
) AS p(provider, family)
ON CONFLICT (tenant_id, provider) DO NOTHING;

-- ── model_catalog ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  model_ref TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  display_name TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  performance_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  last_probed_at TIMESTAMPTZ,
  probe_result JSONB,
  degradation_score FLOAT NOT NULL DEFAULT 0.0,
  endpoint_host TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, model_ref)
);

CREATE INDEX IF NOT EXISTS idx_model_catalog_tenant_status
  ON model_catalog (tenant_id, status);

-- ── model_probe_log ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_probe_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  model_ref TEXT NOT NULL,
  probe_type TEXT NOT NULL,
  probe_input JSONB,
  probe_output JSONB,
  success BOOLEAN NOT NULL DEFAULT false,
  latency_ms INT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_probe_log_tenant_model
  ON model_probe_log (tenant_id, model_ref, created_at DESC);

-- ── model_degradation_alerts ─────────────────────────────────
CREATE TABLE IF NOT EXISTS model_degradation_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  model_ref TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  details JSONB,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_degradation_alerts_active
  ON model_degradation_alerts (tenant_id, resolved, created_at DESC);

-- ── routing_decisions_log ────────────────────────────────────
CREATE TABLE IF NOT EXISTS routing_decisions_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT,
  purpose TEXT NOT NULL,
  task_features JSONB,
  candidates JSONB NOT NULL,
  selected_model_ref TEXT NOT NULL,
  selection_reason TEXT,
  actual_latency_ms INT,
  actual_success BOOLEAN,
  actual_quality FLOAT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routing_decisions_log_tenant
  ON routing_decisions_log (tenant_id, purpose, created_at DESC);
