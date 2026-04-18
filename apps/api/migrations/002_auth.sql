-- 002: 认证与授权 — 多租户、RBAC、ABAC、SSO/SCIM、组织架构

-- ═══ 多租户基础 ═══
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  default_locale TEXT NOT NULL DEFAULT 'zh-CN',
  workflow_step_payload_retention_days INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NULL,
  default_locale TEXT NOT NULL DEFAULT 'zh-CN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══ RBAC ═══
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS roles_name_tenant_id_unique
  ON roles (name, tenant_id);

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT NOT NULL,
  action TEXT NOT NULL,
  field_rules_read JSONB NULL,
  field_rules_write JSONB NULL,
  row_filters_read JSONB NULL,
  row_filters_write JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_type, action)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id),
  permission_id UUID NOT NULL REFERENCES permissions(id),
  field_rules_read JSONB NULL,
  field_rules_write JSONB NULL,
  row_filters_read JSONB NULL,
  row_filters_write JSONB NULL,
  field_rules_condition JSONB NULL,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS role_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS role_bindings_subject_scope_idx
  ON role_bindings (subject_id, scope_type, scope_id);

-- ═══ Auth Tokens ═══
CREATE TABLE IF NOT EXISTS auth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  name TEXT NULL,
  token_hash TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'pat',
  family_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS auth_tokens_tenant_subject_created_idx
  ON auth_tokens (tenant_id, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_tokens_tenant_space_created_idx
  ON auth_tokens (tenant_id, space_id, created_at DESC);

INSERT INTO permissions (resource_type, action)
VALUES
  ('auth', 'token.self'),
  ('auth', 'token.admin')
ON CONFLICT (resource_type, action) DO NOTHING;

-- ═══ ABAC 策略属性定义 ═══
CREATE TABLE IF NOT EXISTS policy_attribute_definitions (
  attr_def_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  attr_namespace TEXT NOT NULL,
  attr_key TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  description JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, attr_namespace, attr_key)
);

CREATE TABLE IF NOT EXISTS policy_time_conditions (
  condition_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  policy_name TEXT NOT NULL,
  policy_version INT NOT NULL DEFAULT 1,
  time_zone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  allowed_days JSONB,
  allowed_hours_start TEXT,
  allowed_hours_end TEXT,
  ip_ranges JSONB,
  geo_countries JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_policy_time_conditions_tenant ON policy_time_conditions(tenant_id, policy_name);

CREATE TABLE IF NOT EXISTS abac_policies (
  policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  policy_name TEXT NOT NULL,
  description JSONB,
  resource_type TEXT NOT NULL DEFAULT '*',
  action TEXT NOT NULL DEFAULT '*',
  priority INT NOT NULL DEFAULT 100,
  effect TEXT NOT NULL DEFAULT 'deny',
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, policy_name)
);
CREATE INDEX IF NOT EXISTS idx_abac_policies_lookup
  ON abac_policies(tenant_id, resource_type, action, enabled, priority);

-- ═══ SSO/OIDC ═══
CREATE TABLE IF NOT EXISTS sso_provider_configs (
  provider_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider_type TEXT NOT NULL DEFAULT 'oidc',
  issuer_url TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_ref TEXT,
  scopes TEXT NOT NULL DEFAULT 'openid profile email',
  redirect_uri TEXT,
  jwks_uri TEXT,
  userinfo_endpoint TEXT,
  claim_mappings JSONB DEFAULT '{}'::jsonb,
  auto_provision BOOLEAN NOT NULL DEFAULT false,
  default_role_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, issuer_url)
);

CREATE TABLE IF NOT EXISTS sso_login_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sso_login_states_expires_idx
  ON sso_login_states (expires_at) WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS sso_login_states_tenant_idx
  ON sso_login_states (tenant_id, created_at DESC);

-- ═══ SCIM ═══
CREATE TABLE IF NOT EXISTS scim_configs (
  scim_config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  bearer_token_hash TEXT NOT NULL,
  allowed_operations JSONB DEFAULT '["Users.list","Users.get","Users.create","Users.update","Users.delete","Groups.list","Groups.get","Groups.create","Groups.update","Groups.delete"]'::jsonb,
  auto_provision BOOLEAN NOT NULL DEFAULT true,
  default_role_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS scim_provisioned_users (
  scim_user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  external_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_scim_provisioned_users_subject ON scim_provisioned_users(tenant_id, subject_id);

CREATE TABLE IF NOT EXISTS scim_provisioned_groups (
  scim_group_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  members JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_scim_provisioned_groups_tenant ON scim_provisioned_groups(tenant_id);

CREATE TABLE IF NOT EXISTS scim_group_role_mappings (
  mapping_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scim_group_id UUID NOT NULL REFERENCES scim_provisioned_groups(scim_group_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id),
  scope_type TEXT NOT NULL DEFAULT 'tenant',
  scope_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scim_group_id, role_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_scim_group_role_mappings_group ON scim_group_role_mappings(tenant_id, scim_group_id);

-- ═══ 组织架构 ═══
CREATE TABLE IF NOT EXISTS space_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_space_members_subject ON space_members(tenant_id, subject_id);

CREATE TABLE IF NOT EXISTS org_units (
  org_unit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  parent_id UUID REFERENCES org_units(org_unit_id),
  org_name TEXT NOT NULL,
  org_path TEXT NOT NULL DEFAULT '/',
  depth INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, org_path)
);
CREATE INDEX IF NOT EXISTS idx_org_units_parent ON org_units(tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS subject_org_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_id TEXT NOT NULL,
  org_unit_id UUID NOT NULL REFERENCES org_units(org_unit_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id, org_unit_id)
);
CREATE INDEX IF NOT EXISTS idx_subject_org_assignments_org ON subject_org_assignments(tenant_id, org_unit_id);

CREATE TABLE IF NOT EXISTS org_space_access_policies (
  policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  org_unit_id UUID NOT NULL REFERENCES org_units(org_unit_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  inherited_role TEXT NOT NULL DEFAULT 'member',
  include_descendants BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, org_unit_id, space_id)
);
CREATE INDEX IF NOT EXISTS idx_org_space_access_policies_space ON org_space_access_policies(tenant_id, space_id);
CREATE INDEX IF NOT EXISTS idx_org_space_access_policies_org ON org_space_access_policies(tenant_id, org_unit_id);

-- ═══ 多身份关联 ═══
CREATE TABLE IF NOT EXISTS subject_identity_links (
  link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  primary_subject_id TEXT NOT NULL,
  linked_subject_id TEXT NOT NULL,
  identity_label TEXT NOT NULL DEFAULT 'default',
  provider_type TEXT,
  provider_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, primary_subject_id, linked_subject_id)
);
CREATE INDEX IF NOT EXISTS idx_subject_identity_links_primary ON subject_identity_links(tenant_id, primary_subject_id, status);

CREATE INDEX IF NOT EXISTS auth_tokens_tenant_subject_type_created_idx
  ON auth_tokens (tenant_id, subject_id, token_type, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_tokens_family_idx
  ON auth_tokens (family_id)
  WHERE family_id IS NOT NULL;
