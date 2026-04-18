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
