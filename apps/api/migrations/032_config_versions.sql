-- Config Versions for Hot Update with Rollback
-- 记录每次运行时配置变更的完整历史，支持版本回滚与审计追溯

CREATE TABLE IF NOT EXISTS config_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  changed_by TEXT NOT NULL DEFAULT 'system',
  tenant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_config_versions_key ON config_versions (key, version DESC);
CREATE INDEX IF NOT EXISTS idx_config_versions_tenant ON config_versions (tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_versions_key_version ON config_versions (key, version);
