-- 007: Tools & Skills (merged 029_tool_category_priority, 030_tool_extra_permissions, 031_tool_rollout_grace)
-- Consolidated from: 006, 014, 017, 023, 024, 067, 080, 081, 082, 095, 120, 127, 132, 133, 134, 149a, 156(tool cols), 029, 030, 031

-- ── tool_definitions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_definitions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  display_name JSONB NULL,
  description JSONB NULL,
  risk_level TEXT NOT NULL DEFAULT 'low',
  approval_required BOOLEAN NOT NULL DEFAULT false,
  scope TEXT NULL,
  resource_type TEXT NULL,
  action TEXT NULL,
  idempotency_required BOOLEAN NULL,
  source_layer TEXT NOT NULL DEFAULT 'builtin',
  -- Affordance columns (from 156)
  preconditions JSONB DEFAULT '[]'::jsonb,
  effects JSONB DEFAULT '[]'::jsonb,
  estimated_cost FLOAT,
  required_capabilities JSONB DEFAULT '[]'::jsonb,
  avg_latency_ms INT,
  success_rate FLOAT DEFAULT 1.0,
  -- Category & priority (from 029)
  category VARCHAR(50) DEFAULT 'uncategorized',
  priority INT DEFAULT 5,
  tags TEXT[] DEFAULT '{}',
  usage_count INT DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  -- Extra permissions (from 030)
  extra_permissions JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS tool_definitions_contract_idx
  ON tool_definitions (tenant_id, scope, resource_type, action);

CREATE INDEX IF NOT EXISTS tool_definitions_source_layer_idx
  ON tool_definitions (tenant_id, source_layer);

CREATE INDEX IF NOT EXISTS idx_tool_category_priority
  ON tool_definitions (tenant_id, category, priority DESC, name ASC);

CREATE INDEX IF NOT EXISTS idx_tool_tags
  ON tool_definitions USING GIN (tags);

COMMENT ON COLUMN tool_definitions.source_layer IS
  'Classification layer: kernel (always auto-enabled), builtin (platform capability), extension (optional upper-layer)';
COMMENT ON COLUMN tool_definitions.category IS
  '工具分类：communication/file/database/analytics/ai/governance/custom 等，用户可自定义';
COMMENT ON COLUMN tool_definitions.priority IS
  '工具优先级：1-10，数值越大优先级越高，LLM 优先展示高优先级工具';
COMMENT ON COLUMN tool_definitions.tags IS
  '工具标签数组：用于语义搜索和分类过滤，如 ["email", "notification", "outbound"]';
COMMENT ON COLUMN tool_definitions.usage_count IS
  '工具调用次数统计：用于分析工具使用频率，辅助优化优先级';
COMMENT ON COLUMN tool_definitions.last_used_at IS
  '最后使用时间：用于识别闲置工具';
COMMENT ON COLUMN tool_definitions.extra_permissions IS
  '额外权限声明 [{resourceType, action}]，工具执行前动态检查';

-- ── tool_versions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  version INT NOT NULL,
  tool_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'released',
  deps_digest TEXT NULL,
  input_schema JSONB NULL,
  output_schema JSONB NULL,
  artifact_ref TEXT NULL,
  scan_summary JSONB NULL,
  trust_summary JSONB NULL,
  sbom_summary JSONB NULL,
  sbom_digest TEXT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name, version),
  UNIQUE (tenant_id, tool_ref)
);

CREATE INDEX IF NOT EXISTS tool_versions_tenant_name_version_idx
  ON tool_versions (tenant_id, name, version DESC);

CREATE INDEX IF NOT EXISTS tool_versions_tenant_artifact_idx
  ON tool_versions (tenant_id, name, artifact_ref);

-- ── tool_rollouts ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_rollouts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  tool_ref TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  -- Graceful disable (from 031)
  disable_mode TEXT NOT NULL DEFAULT 'immediate',
  grace_deadline TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, tool_ref)
);

COMMENT ON COLUMN tool_rollouts.disable_mode IS
  '停用模式: immediate(立即停用) | graceful(优雅停用，允许已有任务在宽限期内继续)';
COMMENT ON COLUMN tool_rollouts.grace_deadline IS
  '优雅停用的截止时间，仅在 disable_mode=graceful 时有意义';

CREATE INDEX IF NOT EXISTS tool_rollouts_lookup_idx
  ON tool_rollouts (tenant_id, tool_ref);

-- ── tool_active_versions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_active_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  active_tool_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);

-- ── tool_active_overrides ────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_active_overrides (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active_tool_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, name)
);

CREATE INDEX IF NOT EXISTS tool_active_overrides_lookup_idx
  ON tool_active_overrides (tenant_id, name, space_id);

-- ── tool_network_policies ────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_network_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  tool_ref TEXT NOT NULL,
  allowed_domains JSONB NOT NULL DEFAULT '[]'::jsonb,
  rules_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, tool_ref)
);

CREATE INDEX IF NOT EXISTS tool_network_policies_lookup_idx
  ON tool_network_policies (tenant_id, scope_type, scope_id, tool_ref);

-- ── tool_governance ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_governance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT NULL,
  tool_ref TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_governance_tenant_tool_idx
  ON tool_governance (tenant_id, tool_ref);

CREATE INDEX IF NOT EXISTS tool_governance_space_idx
  ON tool_governance (tenant_id, space_id) WHERE space_id IS NOT NULL;

COMMENT ON TABLE tool_governance IS '工具治理策略：控制各工具在租户/空间级别的启用状态和审批要求';

-- ── runner_egress_audit_log ──────────────────────────────────
CREATE TABLE IF NOT EXISTS runner_egress_audit_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool_ref TEXT NOT NULL,
  host TEXT NOT NULL,
  method TEXT NOT NULL,
  allowed BOOLEAN NOT NULL,
  policy_match JSONB NULL,
  status INT NULL,
  error_category TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runner_egress_audit_log_tenant_time_idx
  ON runner_egress_audit_log (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runner_egress_audit_log_host_idx
  ON runner_egress_audit_log (tenant_id, host, created_at DESC);

CREATE INDEX IF NOT EXISTS runner_egress_audit_log_request_idx
  ON runner_egress_audit_log (request_id);

COMMENT ON TABLE runner_egress_audit_log IS 'Skill 执行期间的出站网络请求审计日志，由 Runner 服务批量写入';

-- ── skill_runtime_runners ────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_runtime_runners (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  runner_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  auth_secret_id TEXT NULL,
  capabilities JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, runner_id)
);

CREATE INDEX IF NOT EXISTS skill_runtime_runners_enabled_idx
  ON skill_runtime_runners (tenant_id, enabled);

-- ── skill_trusted_keys ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_trusted_keys (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  rotated_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key_id)
);

CREATE INDEX IF NOT EXISTS skill_trusted_keys_status_idx
  ON skill_trusted_keys (tenant_id, status);

-- ── skill_configs ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_configs (
  config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  skill_name TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_value JSONB NOT NULL DEFAULT '{}',
  scope_type TEXT NOT NULL DEFAULT 'tenant',
  scope_id TEXT NOT NULL,
  changed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT skill_configs_unique UNIQUE (tenant_id, skill_name, config_key, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_configs_lookup
  ON skill_configs(tenant_id, skill_name, scope_type, scope_id);

CREATE INDEX IF NOT EXISTS idx_skill_configs_skill
  ON skill_configs(tenant_id, skill_name);

COMMENT ON TABLE skill_configs IS 'Skill运行时配置参数，支持多级作用域覆盖';
COMMENT ON COLUMN skill_configs.scope_type IS '作用域类型: user=用户级, space=空间级, tenant=租户级';

-- ── skill_drafts ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_drafts (
  draft_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  skill_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  manifest JSONB NOT NULL DEFAULT '{}',
  index_code TEXT NOT NULL DEFAULT '',
  routes_code TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skill_drafts_tenant ON skill_drafts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_skill_drafts_creator ON skill_drafts(tenant_id, created_by);
CREATE INDEX IF NOT EXISTS idx_skill_drafts_status ON skill_drafts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_skill_drafts_name ON skill_drafts(tenant_id, skill_name);

COMMENT ON TABLE skill_drafts IS 'Skill草稿存储，支持用户自定义技能的创建和审核发布流程';

-- ── skill_semantics ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_semantics (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  skill_name TEXT NOT NULL,
  display_name JSONB,
  description JSONB,
  semantic_text TEXT NOT NULL DEFAULT '',
  semantic_minhash INT[] NOT NULL DEFAULT '{}',
  layer TEXT NOT NULL DEFAULT 'extension',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, skill_name)
);

CREATE INDEX IF NOT EXISTS idx_skill_semantics_tenant_enabled
  ON skill_semantics (tenant_id, enabled);

CREATE INDEX IF NOT EXISTS idx_skill_semantics_minhash
  ON skill_semantics USING GIN (semantic_minhash);

COMMENT ON TABLE skill_semantics IS '技能语义向量表，用于相似度检索和重复检测';

-- ── 触发器：自动更新 tool_definitions.updated_at ─────────
CREATE OR REPLACE FUNCTION update_tool_definitions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tool_definitions_updated_at ON tool_definitions;
CREATE TRIGGER trg_tool_definitions_updated_at
  BEFORE UPDATE ON tool_definitions
  FOR EACH ROW
  EXECUTE FUNCTION update_tool_definitions_updated_at();
