-- migration-aliases: 007_ui_config,018b_nl2ui_generation_cache,046_ui_page_template_ui_json,092_workbench_plugins,106_ui_component_registry_versions
-- Domain: UI — page templates, nl2ui, component registry, workbench plugins

-- ═══ Page Templates ═══

CREATE TABLE IF NOT EXISTS page_templates (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, name)
);

CREATE TABLE IF NOT EXISTS page_template_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  page_type TEXT NOT NULL,
  title JSONB NULL,
  params JSONB NULL,
  data_bindings JSONB NULL,
  action_bindings JSONB NULL,
  ui_json JSONB NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, name, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS page_template_versions_one_draft_idx
  ON page_template_versions (tenant_id, scope_type, scope_id, name)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS page_template_versions_latest_released_idx
  ON page_template_versions (tenant_id, scope_type, scope_id, name, version DESC)
  WHERE status = 'released';

-- ═══ NL2UI Generation Cache ═══

CREATE TABLE IF NOT EXISTS nl2ui_generation_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  user_input_hash VARCHAR(64) NOT NULL,
  generated_config JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT unique_tenant_user_input UNIQUE (tenant_id, user_id, user_input_hash)
);

CREATE INDEX IF NOT EXISTS idx_nl2ui_cache_tenant_user
  ON nl2ui_generation_cache(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_nl2ui_cache_expires
  ON nl2ui_generation_cache(expires_at);

COMMENT ON TABLE nl2ui_generation_cache IS 'NL2UI 生成结果缓存表，存储自然语言到 UI 配置的映射，TTL=7 天';
COMMENT ON COLUMN nl2ui_generation_cache.generated_config IS '完整的 UI 配置 JSON，包含 layout、blocks、dataBindings 等';

-- ═══ UI Component Registry Versions ═══

CREATE TABLE IF NOT EXISTS ui_component_registry_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  component_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_subject_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (scope_type IN ('tenant', 'space')),
  CHECK (status IN ('draft', 'released')),
  CHECK ((status = 'draft' AND version = 0) OR (status = 'released' AND version > 0)),
  PRIMARY KEY (tenant_id, scope_type, scope_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS ui_component_registry_versions_one_draft_idx
  ON ui_component_registry_versions (tenant_id, scope_type, scope_id)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS ui_component_registry_versions_latest_released_idx
  ON ui_component_registry_versions (tenant_id, scope_type, scope_id, version DESC)
  WHERE status = 'released';

INSERT INTO permissions (resource_type, action)
VALUES
  ('governance', 'ui.component_registry.read'),
  ('governance', 'ui.component_registry.write'),
  ('governance', 'ui.component_registry.publish'),
  ('governance', 'ui.component_registry.rollback')
ON CONFLICT (resource_type, action) DO NOTHING;

-- ═══ Workbench Plugins ═══

CREATE TABLE IF NOT EXISTS workbench_plugins (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  workbench_key TEXT NOT NULL,
  display_name JSONB NULL,
  description JSONB NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, workbench_key)
);

CREATE TABLE IF NOT EXISTS workbench_plugin_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  workbench_key TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  manifest_json JSONB NOT NULL,
  manifest_digest TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, workbench_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS workbench_plugin_versions_one_draft_idx
  ON workbench_plugin_versions (tenant_id, scope_type, scope_id, workbench_key)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS workbench_plugin_versions_latest_released_idx
  ON workbench_plugin_versions (tenant_id, scope_type, scope_id, workbench_key, version DESC)
  WHERE status = 'released';

CREATE TABLE IF NOT EXISTS workbench_active_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  workbench_key TEXT NOT NULL,
  active_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, workbench_key)
);

CREATE TABLE IF NOT EXISTS workbench_canary_configs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  workbench_key TEXT NOT NULL,
  canary_version INT NOT NULL,
  canary_subject_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, workbench_key)
);
