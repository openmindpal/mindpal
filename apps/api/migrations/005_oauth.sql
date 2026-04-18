-- 005: OAuth Gateway & Exchange Connector
-- Consolidated from: 031, 043, 099, 102, 103

-- ── oauth_states ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  subject_id TEXT NOT NULL,
  connector_instance_id UUID NOT NULL REFERENCES connector_instances(id),
  provider TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  nonce_hash TEXT NULL,
  -- PKCE fields (from 103)
  pkce_enc_format TEXT NULL,
  pkce_key_version INT NULL,
  pkce_encrypted_payload JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_state_hash_unique
  ON oauth_states (state_hash);

CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx
  ON oauth_states (expires_at);

-- ── oauth_grants ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_grants (
  grant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  connector_instance_id UUID NOT NULL REFERENCES connector_instances(id),
  provider TEXT NOT NULL,
  secret_record_id UUID NOT NULL REFERENCES secret_records(id),
  scopes TEXT NULL,
  token_expires_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_unique_instance_provider
  ON oauth_grants (tenant_id, connector_instance_id, provider);

CREATE INDEX IF NOT EXISTS oauth_grants_by_secret
  ON oauth_grants (tenant_id, secret_record_id);

CREATE INDEX IF NOT EXISTS oauth_grants_scope_updated_idx
  ON oauth_grants (tenant_id, space_id, updated_at DESC);

-- ── oauth_provider_configs ───────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_provider_configs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  connector_instance_id UUID NOT NULL REFERENCES connector_instances(id),
  provider TEXT NOT NULL,
  authorize_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  refresh_endpoint TEXT NULL,
  userinfo_endpoint TEXT NULL,
  client_id TEXT NOT NULL,
  client_secret_secret_id UUID NOT NULL REFERENCES secret_records(id),
  scopes TEXT NULL,
  pkce_enabled BOOLEAN NOT NULL DEFAULT true,
  token_auth_method TEXT NOT NULL DEFAULT 'client_secret_post',
  extra_authorize_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra_token_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_instance_id, provider)
);

CREATE INDEX IF NOT EXISTS oauth_provider_configs_lookup_idx
  ON oauth_provider_configs (tenant_id, connector_instance_id, provider);

-- exchange_connector_configs 已移除，统一使用 004 中的 connector_configs 表（type_name='mail.exchange'）
