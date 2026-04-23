-- 030: 统一元数据注册表 metadata_registry
-- 收敛 tool/workflow/permission/connector 的元数据管理

CREATE TABLE IF NOT EXISTS metadata_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('tool', 'workflow', 'permission', 'connector')),
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  tenant_id TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'tenant' CHECK (scope_type IN ('tenant', 'space')),
  scope_id TEXT NOT NULL,
  schema_json JSONB,
  capabilities TEXT[],
  enabled BOOLEAN NOT NULL DEFAULT true,
  rollout_mode TEXT DEFAULT 'immediate' CHECK (rollout_mode IN ('immediate', 'graceful')),
  grace_deadline TIMESTAMPTZ,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, name, tenant_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_metadata_registry_tenant ON metadata_registry (tenant_id, kind);
CREATE INDEX IF NOT EXISTS idx_metadata_registry_scope ON metadata_registry (tenant_id, scope_type, scope_id, kind);
CREATE INDEX IF NOT EXISTS idx_metadata_registry_name ON metadata_registry (kind, name, tenant_id);
