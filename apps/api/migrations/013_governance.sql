-- 013: Governance (merged 028_abac_enhanced)
-- Consolidated from: 015, 016, 017, 018, 027, 066, 093a, 104, 110, 128, 028

-- ── governance_changesets ────────────────────────────────────
CREATE TABLE IF NOT EXISTS governance_changesets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NULL,
  approved_by TEXT NULL,
  approved_at TIMESTAMPTZ NULL,
  released_by TEXT NULL,
  released_at TIMESTAMPTZ NULL,
  rollback_of UUID NULL REFERENCES governance_changesets(id),
  rollback_data JSONB NULL,
  required_approvals INT NOT NULL DEFAULT 1,
  risk_level TEXT NOT NULL DEFAULT 'low',
  canary_targets JSONB NULL,
  canary_released_at TIMESTAMPTZ NULL,
  promoted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS governance_changesets_scope_idx
  ON governance_changesets (tenant_id, scope_type, scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS governance_changesets_canary_idx
  ON governance_changesets (tenant_id, canary_released_at DESC);

-- ── governance_changeset_items ───────────────────────────────
CREATE TABLE IF NOT EXISTS governance_changeset_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  changeset_id UUID NOT NULL REFERENCES governance_changesets(id),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS governance_changeset_items_idx
  ON governance_changeset_items (changeset_id, created_at ASC);

-- ── governance_changeset_approvals ───────────────────────────
CREATE TABLE IF NOT EXISTS governance_changeset_approvals (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  changeset_id UUID NOT NULL REFERENCES governance_changesets(id),
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, changeset_id, approved_by)
);

CREATE INDEX IF NOT EXISTS governance_changeset_approvals_idx
  ON governance_changeset_approvals (tenant_id, changeset_id, approved_at ASC);

-- ── eval_suites ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_suites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  description TEXT NULL,
  cases_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS eval_suites_tenant_idx
  ON eval_suites (tenant_id, created_at DESC);

-- ── eval_runs ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  suite_id UUID NOT NULL REFERENCES eval_suites(id),
  changeset_id UUID NULL REFERENCES governance_changesets(id),
  status TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_digest JSONB NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_runs_suite_idx ON eval_runs (tenant_id, suite_id, created_at DESC);
CREATE INDEX IF NOT EXISTS eval_runs_changeset_idx ON eval_runs (tenant_id, changeset_id, created_at DESC);

-- ── changeset_eval_bindings ──────────────────────────────────
CREATE TABLE IF NOT EXISTS changeset_eval_bindings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  changeset_id UUID NOT NULL REFERENCES governance_changesets(id),
  suite_id UUID NOT NULL REFERENCES eval_suites(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, changeset_id, suite_id)
);

CREATE INDEX IF NOT EXISTS changeset_eval_bindings_lookup_idx
  ON changeset_eval_bindings (tenant_id, changeset_id, created_at ASC);

-- ── policy_snapshots ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policy_snapshots (
  snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_id TEXT NOT NULL,
  space_id TEXT NULL,
  resource_type TEXT NOT NULL,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NULL,
  matched_rules JSONB NULL,
  row_filters JSONB NULL,
  field_rules JSONB NULL,
  policy_name TEXT NOT NULL DEFAULT 'default',
  policy_version INT NOT NULL DEFAULT 1,
  policy_cache_epoch JSONB NULL,
  explain_v1 JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policy_snapshots_tenant_subject_time_idx
  ON policy_snapshots (tenant_id, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS policy_snapshots_tenant_space_time_idx
  ON policy_snapshots (tenant_id, space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS policy_snapshots_tenant_time_idx
  ON policy_snapshots (tenant_id, created_at DESC, snapshot_id DESC);
CREATE INDEX IF NOT EXISTS policy_snapshots_tenant_policyref_time_idx
  ON policy_snapshots (tenant_id, policy_name, policy_version, created_at DESC, snapshot_id DESC);

-- ── policy_versions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  policy_json JSONB NOT NULL,
  digest TEXT NOT NULL,
  policy_type TEXT DEFAULT 'rbac' CHECK (policy_type IN ('rbac', 'abac', 'hybrid')),
  abac_policy_set_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  UNIQUE (tenant_id, name, version)
);

COMMENT ON COLUMN policy_versions.policy_type IS '策略类型: rbac=传统角色, abac=属性基, hybrid=混合';
COMMENT ON COLUMN policy_versions.abac_policy_set_id IS '关联的 ABAC 策略集ID';

CREATE INDEX IF NOT EXISTS policy_versions_tenant_name_status_version_idx
  ON policy_versions (tenant_id, name, status, version DESC);

-- ── policy_cache_epochs ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS policy_cache_epochs (
  tenant_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant','space')),
  scope_id TEXT NOT NULL,
  epoch BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS policy_cache_epochs_tenant_idx
  ON policy_cache_epochs (tenant_id, updated_at DESC);

-- ── safety_policies ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS safety_policies (
  policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  policy_type TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, policy_type, name)
);

CREATE TABLE IF NOT EXISTS safety_policy_versions (
  policy_id UUID NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  policy_json JSONB NOT NULL,
  policy_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  PRIMARY KEY (policy_id, version),
  CONSTRAINT safety_policy_versions_policy_fk
    FOREIGN KEY (policy_id) REFERENCES safety_policies(policy_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS safety_policy_versions_status_idx
  ON safety_policy_versions (policy_id, status, version DESC);

CREATE TABLE IF NOT EXISTS safety_policy_active_versions (
  tenant_id TEXT NOT NULL,
  policy_id UUID NOT NULL,
  active_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, policy_id),
  CONSTRAINT safety_policy_active_versions_policy_fk
    FOREIGN KEY (policy_id) REFERENCES safety_policies(policy_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS safety_policy_active_overrides (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  policy_id UUID NOT NULL,
  active_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, policy_id),
  CONSTRAINT safety_policy_active_overrides_policy_fk
    FOREIGN KEY (policy_id) REFERENCES safety_policies(policy_id) ON DELETE CASCADE
);

-- ── governance_checkpoints ───────────────────────────────────
CREATE TABLE IF NOT EXISTS governance_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  run_id UUID NOT NULL,
  step_id UUID,
  phase TEXT NOT NULL,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  overall_passed BOOLEAN NOT NULL DEFAULT true,
  blocking_failures INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gov_checkpoints_run ON governance_checkpoints(tenant_id, run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_gov_checkpoints_failed ON governance_checkpoints(tenant_id, overall_passed, created_at) WHERE overall_passed = false;

-- ── runtime_config_overrides ─────────────────────────────────
CREATE TABLE IF NOT EXISTS runtime_config_overrides (
  tenant_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_value TEXT NOT NULL,
  description TEXT DEFAULT '',
  updated_by TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, config_key)
);

CREATE INDEX IF NOT EXISTS idx_runtime_config_overrides_tenant
  ON runtime_config_overrides (tenant_id);

-- ── config_change_audit_log ──────────────────────────────────
CREATE TABLE IF NOT EXISTS config_change_audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT DEFAULT '',
  change_type TEXT NOT NULL DEFAULT 'set',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_config_change_audit_tenant_key
  ON config_change_audit_log (tenant_id, config_key, created_at DESC);

-- ═══ ABAC 策略引擎增强（原 028_abac_enhanced）═══

-- ── ABAC 属性定义表 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS abac_attribute_definitions (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('subject', 'resource', 'action', 'environment')),
  value_type      TEXT NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'string[]', 'json')),
  required        BOOLEAN DEFAULT false,
  default_value   TEXT,
  description     TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, name, category)
);

CREATE INDEX IF NOT EXISTS idx_abac_attr_defs_tenant
  ON abac_attribute_definitions (tenant_id, category);

COMMENT ON TABLE abac_attribute_definitions IS 'ABAC 属性定义注册表';

-- ── ABAC 策略集表 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS abac_policy_sets (
  policy_set_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  resource_type   TEXT NOT NULL,
  combining_algorithm TEXT NOT NULL DEFAULT 'deny_overrides' CHECK (combining_algorithm IN (
    'deny_overrides', 'permit_overrides', 'first_applicable', 'deny_unless_permit', 'permit_unless_deny'
  )),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'deprecated')),
  description     TEXT DEFAULT '',
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_abac_policy_sets_tenant
  ON abac_policy_sets (tenant_id, resource_type, status);

COMMENT ON TABLE abac_policy_sets IS 'ABAC 策略集，包含冲突解决算法配置';

-- ── ABAC 策略规则表 ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS abac_policy_rules (
  rule_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_set_id   UUID NOT NULL REFERENCES abac_policy_sets(policy_set_id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  resource_type   TEXT NOT NULL,
  actions         JSONB NOT NULL DEFAULT '[]',
  priority        INTEGER NOT NULL DEFAULT 100,
  effect          TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  condition_expr  JSONB NOT NULL,
  enabled         BOOLEAN DEFAULT true,
  space_id        TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_abac_rules_policy_set
  ON abac_policy_rules (policy_set_id, tenant_id, enabled, priority);

CREATE INDEX IF NOT EXISTS idx_abac_rules_resource
  ON abac_policy_rules (tenant_id, resource_type, enabled);

COMMENT ON TABLE abac_policy_rules IS 'ABAC 策略规则，包含 PolicyExpr v2 条件表达式';

-- ── ABAC 评估日志表 ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS abac_evaluation_logs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  action          TEXT NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason          TEXT DEFAULT '',
  matched_rules   JSONB DEFAULT '[]',
  combining_algorithm TEXT,
  evaluation_ms   INTEGER DEFAULT 0,
  environment     JSONB DEFAULT '{}',
  trace_id        TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_abac_eval_logs_tenant
  ON abac_evaluation_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_abac_eval_logs_subject
  ON abac_evaluation_logs (tenant_id, subject_id, created_at DESC);

COMMENT ON TABLE abac_evaluation_logs IS 'ABAC 策略评估审计日志';

-- ── 资源层级表 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS abac_resource_hierarchy (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_path   TEXT NOT NULL,
  parent_path     TEXT,
  depth           INTEGER NOT NULL DEFAULT 0,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, resource_type, resource_path)
);

CREATE INDEX IF NOT EXISTS idx_abac_hierarchy_parent
  ON abac_resource_hierarchy (tenant_id, resource_type, parent_path);

CREATE INDEX IF NOT EXISTS idx_abac_hierarchy_path
  ON abac_resource_hierarchy USING gist (resource_path gist_trgm_ops);

COMMENT ON TABLE abac_resource_hierarchy IS 'ABAC 资源层级树，支持层级继承策略';
