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

-- ============ merged from 026_metadata_registry.sql ============
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

-- ============ merged from 025_metadata_governance.sql ============
-- 028: Metadata Governance Foundation Tables
-- Migrate hardcoded metadata (tool category mappings, tool policy rules,
-- orchestrator rules) into configurable database tables.

-- ══════════════════════════════════════════════════════════════════════
-- Table 1: resource_type_profiles
-- Stores resourceType → category / priority / tags derivation config,
-- replacing hardcoded mappings in toolAutoDiscovery.ts.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS resource_type_profiles (
  tenant_id        TEXT        NOT NULL DEFAULT 'tenant_dev',
  resource_type    TEXT        NOT NULL,
  default_category TEXT        NOT NULL DEFAULT 'integration',
  default_priority INTEGER     NOT NULL DEFAULT 5 CHECK (default_priority BETWEEN 1 AND 10),
  default_tags     TEXT[]      NOT NULL DEFAULT ARRAY['tool'],
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, resource_type)
);

-- Seed: extracted from inferCategory / inferPriority / inferTags in toolAutoDiscovery.ts
INSERT INTO resource_type_profiles (tenant_id, resource_type, default_category, default_priority, default_tags)
VALUES
  ('tenant_dev', 'model',         'ai',            9, ARRAY['llm','model','generation']),
  ('tenant_dev', 'embedding',     'ai',            8, ARRAY['embedding','vector','ai']),
  ('tenant_dev', 'knowledge',     'ai',            8, ARRAY['knowledge','rag','search']),
  ('tenant_dev', 'memory',        'ai',            8, ARRAY['memory','context','recall']),
  ('tenant_dev', 'intent',        'ai',            9, ARRAY['intent','analysis','nlp']),
  ('tenant_dev', 'nl2ui',         'ai',            9, ARRAY['nl2ui','page-generation','frontend']),
  ('tenant_dev', 'media',         'ai',            7, ARRAY['media','multimodal','vision']),
  ('tenant_dev', 'schema',        'database',      9, ARRAY['schema','database','ddl']),
  ('tenant_dev', 'entity',        'database',      8, ARRAY['entity','data','crud']),
  ('tenant_dev', 'channel',       'communication', 7, ARRAY['channel','im','messaging']),
  ('tenant_dev', 'federation',    'integration',   7, ARRAY['federation','cross-tenant','bridge']),
  ('tenant_dev', 'rbac',          'governance',    8, ARRAY['rbac','permission','authorization']),
  ('tenant_dev', 'governance',    'governance',    9, ARRAY['governance','audit','compliance']),
  ('tenant_dev', 'agent_runtime', 'governance',    8, ARRAY['agent','runtime','orchestration']),
  ('tenant_dev', 'agent',         'workflow',      7, ARRAY['agent','reflection','learning']),
  ('tenant_dev', 'browser',       'integration',   6, ARRAY['browser','automation','web']),
  ('tenant_dev', 'desktop',       'integration',   6, ARRAY['desktop','automation','application']),
  ('tenant_dev', 'skill',         'governance',    7, ARRAY['skill','management']),
  ('tenant_dev', 'tool',          'integration',   6, ARRAY['tool','discovery']),
  ('tenant_dev', 'workbench',     'integration',   6, ARRAY['workbench','plugin'])
ON CONFLICT (tenant_id, resource_type) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
-- Table 2: tool_policy_rules
-- Stores tool sorting / visibility policies, replacing PINNED_TOOL_NAMES
-- and isPlannerVisibleTool hardcoding in agentContext.ts.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tool_policy_rules (
  tenant_id     TEXT        NOT NULL DEFAULT 'tenant_dev',
  rule_type     TEXT        NOT NULL CHECK (rule_type IN ('pinned', 'hidden')),
  match_field   TEXT        NOT NULL CHECK (match_field IN ('name', 'tag', 'prefix')),
  match_pattern TEXT        NOT NULL,
  effect        JSONB       NOT NULL DEFAULT '{}',
  enabled       BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rule_type, match_field, match_pattern)
);

-- Seed: pinned rules from PINNED_TOOL_NAMES (agentContext.ts L46-50)
INSERT INTO tool_policy_rules (tenant_id, rule_type, match_field, match_pattern, effect)
VALUES
  ('tenant_dev', 'pinned', 'name', 'knowledge.search', '{"pinnedOrder": 1}'),
  ('tenant_dev', 'pinned', 'name', 'memory.read',      '{"pinnedOrder": 2}'),
  ('tenant_dev', 'pinned', 'name', 'memory.write',     '{"pinnedOrder": 3}'),
  ('tenant_dev', 'pinned', 'name', 'nl2ui.generate',   '{"pinnedOrder": 4}'),
  ('tenant_dev', 'pinned', 'name', 'entity.create',    '{"pinnedOrder": 5}'),
  ('tenant_dev', 'pinned', 'name', 'entity.update',    '{"pinnedOrder": 6}'),
  ('tenant_dev', 'pinned', 'name', 'entity.delete',    '{"pinnedOrder": 7}')
ON CONFLICT (tenant_id, rule_type, match_field, match_pattern) DO NOTHING;

-- Seed: hidden rules from isPlannerVisibleTool (agentContext.ts L389-393)
INSERT INTO tool_policy_rules (tenant_id, rule_type, match_field, match_pattern, effect)
VALUES
  ('tenant_dev', 'hidden', 'prefix', 'device.', '{"visible": false, "reason": "device tools hidden from planner"}'),
  ('tenant_dev', 'hidden', 'tag', 'planner:hidden',    '{"visible": false, "reason": "tagged as planner:hidden"}'),
  ('tenant_dev', 'hidden', 'tag', 'internal-only',     '{"visible": false, "reason": "internal-only tool"}')
ON CONFLICT (tenant_id, rule_type, match_field, match_pattern) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
-- Table 3: orchestrator_rule_configs
-- Stores orchestrator rule configuration, replacing hardcoded rules in
-- orchestrator.ts and analyzer.ts.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS orchestrator_rule_configs (
  tenant_id  TEXT        NOT NULL DEFAULT 'tenant_dev',
  rule_group TEXT        NOT NULL CHECK (rule_group IN (
    'event_trigger', 'category_display', 'layer_display',
    'intent_pattern', 'action_intent_rescue'
  )),
  rules      JSONB       NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rule_group)
);

-- Seed: event_trigger — from EVENT_TRIGGER_PATTERNS (orchestrator.ts L59-65)
INSERT INTO orchestrator_rule_configs (tenant_id, rule_group, rules)
VALUES ('tenant_dev', 'event_trigger', '[
  {"pattern": "换个话题|说回|回到|继续(之前的|刚才的)", "reason": "topic_switch"},
  {"pattern": "总结一下|归纳一下|所以(结论是|结果是)", "reason": "conclusion"},
  {"pattern": "定稿|确认|就这样(吧|了)", "reason": "finalization"},
  {"pattern": "列(个|出|一下)(清单|列表|要点)", "reason": "listing"},
  {"pattern": "按(前面|之前|刚才)(的方式|的方法|的思路)", "reason": "reference"}
]'::jsonb)
ON CONFLICT (tenant_id, rule_group) DO NOTHING;

-- Seed: category_display — from categoryNames (orchestrator.ts L155-171)
INSERT INTO orchestrator_rule_configs (tenant_id, rule_group, rules)
VALUES ('tenant_dev', 'category_display', '{
  "nl2ui":         {"zh": "界面生成",       "en": "UI Generation"},
  "memory":        {"zh": "记忆管理",       "en": "Memory Management"},
  "knowledge":     {"zh": "知识检索",       "en": "Knowledge Retrieval"},
  "governance":    {"zh": "治理控制",       "en": "Governance Control"},
  "communication": {"zh": "通信集成",       "en": "Communication"},
  "file":          {"zh": "文件操作",       "en": "File Operations"},
  "database":      {"zh": "数据库",         "en": "Database"},
  "analytics":     {"zh": "数据分析",       "en": "Analytics"},
  "integration":   {"zh": "系统集成",       "en": "Integration"},
  "ai":            {"zh": "AI 增强",        "en": "AI Enhancement"},
  "device":        {"zh": "设备控制",       "en": "Device Control"},
  "collaboration": {"zh": "多智能体协作",   "en": "Multi-Agent Collaboration"},
  "testing":       {"zh": "测试工具",       "en": "Testing Tools"},
  "automation":    {"zh": "自动化",         "en": "Automation"},
  "uncategorized": {"zh": "其他工具",       "en": "Other Tools"}
}'::jsonb)
ON CONFLICT (tenant_id, rule_group) DO NOTHING;

-- Seed: layer_display — from layerNames (orchestrator.ts L200-204)
INSERT INTO orchestrator_rule_configs (tenant_id, rule_group, rules)
VALUES ('tenant_dev', 'layer_display', '{
  "kernel":    {"zh": "Kernel 内核层",    "en": "Kernel Layer",    "examples": ["实体CRUD", "工具治理"]},
  "builtin":   {"zh": "Core 核心层",      "en": "Core Layer",      "examples": ["编排", "模型网关", "知识", "记忆", "安全"]},
  "extension": {"zh": "Extension 扩展层", "en": "Extension Layer", "examples": ["媒体", "自动化", "分析"]}
}'::jsonb)
ON CONFLICT (tenant_id, rule_group) DO NOTHING;

-- Seed: intent_pattern — rule-based intent detection from analyzer.ts L63-131
-- Context-dependent rules (L63-82) + standalone rules (L85-131)
INSERT INTO orchestrator_rule_configs (tenant_id, rule_group, rules)
VALUES ('tenant_dev', 'intent_pattern', '{
  "context_rules": [
    {"pattern": "^(继续|接着来|再多看几条|再看看|继续查|再查一些)$", "prevIntent": "query", "intent": "query", "confidence": 0.68, "tag": "context_query_follow_up"},
    {"pattern": "^(就用这个方案|按这个方案来|就按这个来|用这个方案)$", "prevIntent": "ui", "intent": "ui", "confidence": 0.67, "tag": "context_ui_follow_up"},
    {"pattern": "^(对，?执行吧|执行吧|开始吧|就这样执行)$", "prevIntent": "task", "intent": "task", "confidence": 0.72, "tag": "context_task_confirm"},
    {"pattern": "^(算了，不弄了|不要继续了|换个思路|先别弄了)$", "prevIntent": "task", "intent": "task", "confidence": 0.64, "tag": "context_task_cancel"},
    {"pattern": "^(和上次一样的格式|按上次那个格式|保持上次格式)$", "historyPattern": "(生成|报表|月报|导出|格式)", "intent": "task", "confidence": 0.62, "tag": "context_task_repeat"},
    {"pattern": "^搞定了没有$", "prevIntent": "task", "intent": "query", "confidence": 0.58, "tag": "context_status_query"}
  ],
  "standalone_rules": [
    {"pattern": "^[.…!！?？.]+$", "intent": "chat", "confidence": 0.05, "tag": "punctuation_only"},
    {"pattern": "^(你好|您好|hello|hi|hey)$", "intent": "chat", "confidence": 0.85, "tag": "greeting"},
    {"pattern": "^(谢谢|感谢).*(清楚|明白|解释|帮助|啦)?$|^(好的|好吧|明白了|我知道了|收到|可以吗|行吗)([，,。.!！]|$)", "intent": "chat", "confidence": 0.85, "tag": "acknowledgement"},
    {"pattern": "什么是|区别|怎么|怎样|为什么|缺点|优点|详细|例子|展开讲讲|还有其他方法|跟上一个方案比|天气怎么样|架构是怎样|我想了解|解释一下|你觉得.+更好|推荐.+框架", "intent": "chat", "confidence": 0.72, "tag": "chat_qa_pattern"},
    {"pattern": "协作|多智能体|多角色|多个 agent|多个智能体|一起调查|一起评审|并行处理|团队讨论|组织一场.+讨论|发起.+讨论", "intent": "collab", "confidence": 0.78, "tag": "collab_pattern"},
    {"pattern": "查询并.*(删除|创建|审批|通知)|删除然后创建|执行审批最后发通知|把.+改为.+|改成发邮件|约一下|安排一下|排查一下|弄一下吧|换个思路|不要继续了", "intent": "task", "confidence": 0.76, "tag": "task_explicit_pattern"},
    {"pattern": "^有个东西需要你帮忙$", "intent": "task", "confidence": 0.46, "tag": "task_vague_request"},
    {"pattern": "^帮我看看数据$", "intent": "query", "confidence": 0.45, "tag": "query_vague_data"},
    {"pattern": "弄一下报表|做一下报表|生成报表|报表界面", "intent": "ui", "confidence": 0.66, "tag": "ui_report_pattern"},
    {"pattern": "上个月的报表|查一下.+报表|按时间排序|上个月的数据|这个月的数据|搞定了没有|把.+联系方式给我|查.+联系方式|结果有问题", "intent": "query", "confidence": 0.72, "tag": "query_explicit_pattern"},
    {"pattern": "生成.+(面板|页面|界面)|显示.+(看板|dashboard|图表|面板)|show me.+(dashboard|page|panel)|左边.+右边.+|上面.+下面.+|三栏布局|仪表盘|dashboard", "intent": "ui", "confidence": 0.82, "tag": "ui_explicit_pattern"},
    {"pattern": "界面|页面|面板|布局|表单|仪表盘|dashboard|图表|看板|左边.*右边|上面.*下面", "intent": "ui", "confidence": 0.76, "tag": "ui_pattern"},
    {"pattern": "查询|查找|搜索|列出|统计|汇总|找下|找找|看看|看下|拉一下|找出来|翻翻|有哪些|还在不在|历史订单|最近\\d+条|数据不对劲|给我拉|帮我看下|报表|联系方式|再多看几条", "intent": "query", "confidence": 0.72, "tag": "query_pattern"},
    {"pattern": "创建|新建|更新|修改|删除|审批|发送|发一封|导入|安排|处理|转给|设置|发布|标记|撤回|重新来过|停止|取消|暂停|回滚|执行|通知|跳过审批|继续这个任务|排查|约一下|弄一下|改成|换个思路", "intent": "task", "confidence": 0.74, "tag": "task_pattern"}
  ],
  "keywords": {
    "ui":    ["显示","展示","界面","页面","dashboard","看板","图表","可视化","生成页面","创建界面","ui","view","page","layout"],
    "query": ["查询","查找","搜索","查看","列出","统计","汇总","query","search","find","list","count","get"],
    "task":  ["执行","运行","创建","更新","删除","审批","提交","execute","run","create","update","delete","approve","submit"],
    "collab":["协作","讨论","辩论","多智能体","团队","分配","collaborate","discuss","debate","assign","team"],
    "chat":  []
  }
}'::jsonb)
ON CONFLICT (tenant_id, rule_group) DO NOTHING;

-- Seed: action_intent_rescue — from orchestrator.ts L722
INSERT INTO orchestrator_rule_configs (tenant_id, rule_group, rules)
VALUES ('tenant_dev', 'action_intent_rescue', '{
  "pattern": "执行|(帮我.{0,8}创建)|(帮我.{0,8}删除)|(帮我.{0,8}更新)|(帮我.{0,8}发送)|(帮我.{0,8}关闭)|(请.{0,8}创建)|(请.{0,8}删除)",
  "description": "Detect action intent in reply text when tool_call is missing, trigger secondary LLM validation"
}'::jsonb)
ON CONFLICT (tenant_id, rule_group) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
-- Extra: Tag nl2ui tools with execution:separate-pipeline
-- ══════════════════════════════════════════════════════════════════════

UPDATE tool_definitions
SET tags = array_append(tags, 'execution:separate-pipeline')
WHERE resource_type = 'nl2ui'
  AND NOT ('execution:separate-pipeline' = ANY(tags));

-- ============ merged from 023_approval_rules.sql ============
-- 024: Approval Rules — 动态审批规则注册表
--
-- 将审批判断逻辑从代码硬编码提升为数据驱动：
-- 1. 工具执行级审批规则（替代 assessOperationRisk 中的硬编码正则）
-- 2. 变更集门禁规则（替代 computeApprovalGate 中的硬编码 kind 前缀 if/else）
-- 3. Eval 准入触发规则（替代 EVAL_ADMISSION_REQUIRED_KINDS 环境变量）
--
-- 所有规则存于 approval_rules 表，通过 API 增删改，运行时动态匹配。

-- ── approval_rules ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_rules (
  rule_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  -- 规则分类：
  --   tool_execution   = 工具执行时的审批判断
  --   changeset_gate   = 变更集提交时的门禁（风险等级 + 审批人数）
  --   eval_admission   = eval 准入门禁触发条件
  rule_type       TEXT NOT NULL CHECK (rule_type IN ('tool_execution', 'changeset_gate', 'eval_admission')),
  -- 规则名称（人类可读）
  name            TEXT NOT NULL,
  -- 规则描述（用于审批自描述：告诉用户"为什么需要审批"）
  description     TEXT NOT NULL DEFAULT '',
  -- 规则优先级（数值越小越高，同类规则按此排序）
  priority        INT NOT NULL DEFAULT 100,
  -- 是否启用
  enabled         BOOLEAN NOT NULL DEFAULT true,
  -- 匹配条件（JSON 结构，由 approvalRuleEngine 解析）
  -- tool_execution 类型示例: {"match":"tool_name","pattern":"delete|remove|drop","flags":"i"}
  -- changeset_gate 类型示例: {"match":"item_kind_prefix","pattern":"ui."}
  -- eval_admission 类型示例: {"match":"item_kind_prefix","pattern":"tool.enable"}
  match_condition JSONB NOT NULL,
  -- 匹配后的效果
  -- tool_execution: {"riskLevel":"high","approvalRequired":true}
  -- changeset_gate: {"riskLevel":"high","requiredApprovals":2}
  -- eval_admission: {"evalRequired":true}
  effect          JSONB NOT NULL,
  -- 适用的 scope（null = 全局）
  scope_type      TEXT CHECK (scope_type IN ('tenant', 'space') OR scope_type IS NULL),
  scope_id        TEXT,
  -- 元数据（可存放行业标签、来源等）
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_rules_tenant_type
  ON approval_rules (tenant_id, rule_type, enabled, priority);

CREATE INDEX IF NOT EXISTS idx_approval_rules_tenant_scope
  ON approval_rules (tenant_id, scope_type, scope_id);

COMMENT ON TABLE approval_rules IS '动态审批规则注册表 — OS 级可配置审批策略';
COMMENT ON COLUMN approval_rules.match_condition IS '匹配条件 JSON，由 approvalRuleEngine 解析执行';
COMMENT ON COLUMN approval_rules.effect IS '匹配后的效果（风险等级、审批要求等）';
COMMENT ON COLUMN approval_rules.description IS '人类可读描述，用于审批自描述（告诉用户为什么需要审批）';

-- ── 确保 __default__ 租户存在 ────────────────────────────────
INSERT INTO tenants (id, created_at)
VALUES ('__default__', now())
ON CONFLICT (id) DO NOTHING;

-- ── 预置默认规则（等效于原硬编码逻辑，用户可通过 API 修改/禁用）────

-- == tool_execution 类规则（替代 assessOperationRisk 硬编码正则）==

INSERT INTO approval_rules (tenant_id, rule_type, name, description, priority, match_condition, effect)
VALUES
  ('__default__', 'tool_execution', '高风险工具名称关键词',
   '工具名称包含 delete/remove/drop/truncate/destroy/erase/force/override/bypass/admin/root 时标记为高风险',
   10,
   '{"match":"tool_name_regex","pattern":"delete|remove|drop|truncate|destroy|erase|force|override|bypass|admin|root","flags":"i"}',
   '{"riskLevel":"high","approvalRequired":true}'
  ),
  ('__default__', 'tool_execution', '中风险工具名称关键词',
   '工具名称包含 update/modify/change/edit/write/create/insert/add/enable/disable 时标记为中风险',
   20,
   '{"match":"tool_name_regex","pattern":"update|modify|change|edit|write|create|insert|add|enable|disable","flags":"i"}',
   '{"riskLevel":"medium","approvalRequired":false}'
  ),
  ('__default__', 'tool_execution', '输入包含敏感信息',
   '输入内容包含密码、密钥、Token、凭证等敏感信息时提升风险等级',
   30,
   '{"match":"input_content_regex","pattern":"password|密码|secret|密钥|token|credential","flags":"i"}',
   '{"riskLevel":"medium","approvalRequired":false}'
  ),
  ('__default__', 'tool_execution', '批量操作检测',
   '输入中包含超过 10 条批量项时提升风险等级',
   40,
   '{"match":"input_batch_size","threshold":10}',
   '{"riskLevel":"medium","approvalRequired":false}'
  )
ON CONFLICT DO NOTHING;

-- == changeset_gate 类规则（替代 computeApprovalGate 硬编码 kind 前缀）==

INSERT INTO approval_rules (tenant_id, rule_type, name, description, priority, match_condition, effect)
VALUES
  ('__default__', 'changeset_gate', 'UI 页面变更',
   '涉及 UI 页面发布/回滚时标记为高风险，需双人审批',
   10,
   '{"match":"item_kind_prefix","pattern":"ui."}',
   '{"riskLevel":"high","requiredApprovals":2}'
  ),
  ('__default__', 'changeset_gate', 'Schema 变更',
   '涉及 Schema 发布/回滚时标记为高风险，需双人审批',
   11,
   '{"match":"item_kind_prefix","pattern":"schema."}',
   '{"riskLevel":"high","requiredApprovals":2}'
  ),
  ('__default__', 'changeset_gate', 'Workbench 插件变更',
   '涉及 Workbench 插件发布/回滚时标记为高风险，需双人审批',
   12,
   '{"match":"item_kind_prefix","pattern":"workbench."}',
   '{"riskLevel":"high","requiredApprovals":2}'
  ),
  ('__default__', 'changeset_gate', '策略变更',
   '涉及策略发布/回滚/覆盖时标记为高风险，需双人审批',
   13,
   '{"match":"item_kind_prefix","pattern":"policy."}',
   '{"riskLevel":"high","requiredApprovals":2}'
  ),
  ('__default__', 'changeset_gate', '模型路由变更',
   '涉及模型路由配置时标记为中风险',
   20,
   '{"match":"item_kind_prefix","pattern":"model_routing."}',
   '{"riskLevel":"medium","requiredApprovals":1}'
  )
ON CONFLICT DO NOTHING;

-- == eval_admission 类规则（替代 EVAL_ADMISSION_REQUIRED_KINDS 环境变量）==

INSERT INTO approval_rules (tenant_id, rule_type, name, description, priority, match_condition, effect)
VALUES
  ('__default__', 'eval_admission', '工具激活需评测准入',
   '启用/激活工具时需通过评测套件验证',
   10,
   '{"match":"item_kind_prefix","pattern":"tool.set_active"}',
   '{"evalRequired":true}'
  ),
  ('__default__', 'eval_admission', '工具启用需评测准入',
   '启用工具时需通过评测套件验证',
   11,
   '{"match":"item_kind_prefix","pattern":"tool.enable"}',
   '{"evalRequired":true}'
  ),
  ('__default__', 'eval_admission', '策略变更需评测准入',
   '策略相关变更需通过评测套件验证',
   12,
   '{"match":"item_kind_prefix","pattern":"policy."}',
   '{"evalRequired":true}'
  ),
  ('__default__', 'eval_admission', '模型路由需评测准入',
   '模型路由变更需通过评测套件验证',
   13,
   '{"match":"item_kind_prefix","pattern":"model_routing."}',
   '{"evalRequired":true}'
  )
ON CONFLICT DO NOTHING;

-- ============ merged from 029_approval_rule_audit.sql ============
-- Approval rule change audit trail (OS governance infrastructure)
CREATE TABLE IF NOT EXISTS approval_rule_audit (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES approval_rules(rule_id),
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  prev_snapshot JSONB,
  new_snapshot JSONB,
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rule_audit_rule ON approval_rule_audit(rule_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rule_audit_tenant ON approval_rule_audit(tenant_id, changed_at DESC);
