-- 004: 连接器与密钥管理 (merged 024_unified_connector_configs)

-- ═══ 连接器类型注册 ═══
CREATE TABLE IF NOT EXISTS connector_types (
  name TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  default_risk_level TEXT NOT NULL,
  default_egress_policy JSONB NULL,
  config_schema JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN connector_types.config_schema IS '连接器配置 JSON Schema（用于校验 connector_configs.config）';

CREATE TABLE IF NOT EXISTS connector_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type_name TEXT NOT NULL REFERENCES connector_types(name),
  status TEXT NOT NULL,
  egress_policy JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_instances_unique_name
  ON connector_instances (tenant_id, scope_type, scope_id, name);

CREATE INDEX IF NOT EXISTS connector_instances_by_type
  ON connector_instances (tenant_id, type_name);

-- ═══ 密钥管理 ═══
CREATE TABLE IF NOT EXISTS secret_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  connector_instance_id UUID NOT NULL REFERENCES connector_instances(id),
  status TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  encrypted_payload JSONB NOT NULL,
  enc_format TEXT NOT NULL DEFAULT 'a256gcm',
  key_ref JSONB NULL,
  credential_version INT NOT NULL DEFAULT 1,
  rotated_from_id UUID NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ NULL,
  grace_period_sec INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS secret_records_by_instance
  ON secret_records (tenant_id, connector_instance_id);

CREATE INDEX IF NOT EXISTS secret_records_by_scope
  ON secret_records (tenant_id, scope_type, scope_id);

CREATE UNIQUE INDEX IF NOT EXISTS secret_records_unique_instance_credential_version
  ON secret_records (tenant_id, connector_instance_id, credential_version);

-- 分区密钥
CREATE TABLE IF NOT EXISTS partition_keys (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_version INT NOT NULL,
  status TEXT NOT NULL,
  encrypted_key JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ NULL,
  PRIMARY KEY (tenant_id, scope_type, scope_id, key_version)
);

CREATE INDEX IF NOT EXISTS partition_keys_active_idx
  ON partition_keys (tenant_id, scope_type, scope_id, status, key_version DESC);

-- 密钥使用事件
CREATE TABLE IF NOT EXISTS secret_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  connector_instance_id UUID NOT NULL,
  secret_id UUID NOT NULL,
  credential_version INT NOT NULL,
  scene TEXT NOT NULL,
  result TEXT NOT NULL,
  trace_id TEXT NULL,
  request_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS secret_usage_events_by_connector_time
  ON secret_usage_events (tenant_id, connector_instance_id, created_at DESC);

CREATE INDEX IF NOT EXISTS secret_usage_events_by_secret_time
  ON secret_usage_events (tenant_id, secret_id, created_at DESC);

-- ═══ Seed: 连接器类型 ═══
INSERT INTO connector_types (name, provider, auth_method, default_risk_level, default_egress_policy)
VALUES
  ('generic.api_key', 'generic', 'api_key', 'medium', '{"allowedDomains":[]}'::jsonb),
  ('model.openai', 'openai', 'api_key', 'high', '{"allowedDomains":["api.openai.com"]}'::jsonb),
  ('mail.imap', 'imap', 'password', 'high', '{"allowedDomains":[]}'::jsonb),
  ('mail.smtp', 'smtp', 'password', 'high', '{"allowedDomains":[]}'::jsonb),
  ('mail.exchange', 'exchange', 'oauth', 'high', '{"allowedDomains":["graph.microsoft.com"]}'::jsonb),
  ('webhook.generic', 'webhook', 'none', 'low', '{"allowedDomains":[]}'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- ═══ 统一连接器配置表（原 024_unified_connector_configs）═══
-- 注：imap/smtp/exchange 协议专用表已移除，全部通过 type_name + JSONB config 元数据驱动

CREATE TABLE IF NOT EXISTS connector_configs (
  connector_instance_id UUID PRIMARY KEY REFERENCES connector_instances(id),
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  type_name             TEXT NOT NULL,
  config                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connector_configs_tenant_type_idx
  ON connector_configs (tenant_id, type_name);

COMMENT ON TABLE connector_configs IS '统一连接器配置表：type_name + JSONB config 元数据驱动';
COMMENT ON COLUMN connector_configs.type_name IS '连接器类型名（与 connector_types.name / connector_instances.type_name 对齐）';
COMMENT ON COLUMN connector_configs.config IS '连接器配置 JSONB（结构由 connector_types 的 configSchema 元数据校验）';

-- Seed: config_schema for connector_types

UPDATE connector_types SET config_schema = '{
  "type": "object",
  "properties": {
    "host": {"type": "string"},
    "port": {"type": "integer"},
    "useTls": {"type": "boolean"},
    "username": {"type": "string"},
    "passwordSecretId": {"type": "string", "format": "uuid"},
    "mailbox": {"type": "string"},
    "fetchWindowDays": {"type": "integer"}
  },
  "required": ["host", "port", "useTls", "username", "passwordSecretId", "mailbox"]
}'::jsonb WHERE name = 'mail.imap';

UPDATE connector_types SET config_schema = '{
  "type": "object",
  "properties": {
    "host": {"type": "string"},
    "port": {"type": "integer"},
    "useTls": {"type": "boolean"},
    "username": {"type": "string"},
    "passwordSecretId": {"type": "string", "format": "uuid"},
    "fromAddress": {"type": "string"}
  },
  "required": ["host", "port", "useTls", "username", "passwordSecretId", "fromAddress"]
}'::jsonb WHERE name = 'mail.smtp';

UPDATE connector_types SET config_schema = '{
  "type": "object",
  "properties": {
    "oauthGrantId": {"type": "string", "format": "uuid"},
    "mailbox": {"type": "string"},
    "fetchWindowDays": {"type": "integer"}
  },
  "required": ["oauthGrantId", "mailbox"]
}'::jsonb WHERE name = 'mail.exchange';
