-- 131: Federation Permissions - 联邦权限声明与授权
-- 支持细粒度权限控制（读/写/转发/审计）与用户级跨域授权

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. 节点级权限声明 - 声明本节点对外暴露的能力及权限要求
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS federation_permission_declarations (
  declaration_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  capability_id     UUID NOT NULL REFERENCES federation_node_capabilities(capability_id),
  permission_type   TEXT NOT NULL,                              -- read | write | forward | audit | invoke | subscribe
  required_trust    TEXT NOT NULL DEFAULT 'trusted',            -- untrusted | trusted | verified
  rate_limit        INT,                                        -- 每分钟调用次数限制（可选）
  description       TEXT,                                       -- 权限说明
  metadata          JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (capability_id, permission_type)
);

CREATE INDEX IF NOT EXISTS federation_permission_decl_tenant ON federation_permission_declarations (tenant_id);
CREATE INDEX IF NOT EXISTS federation_permission_decl_cap ON federation_permission_declarations (capability_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. 节点级权限授权 - 授予远程节点访问本地能力的权限
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS federation_permission_grants (
  grant_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  node_id           UUID NOT NULL REFERENCES federation_nodes(node_id),
  capability_id     UUID NOT NULL REFERENCES federation_node_capabilities(capability_id),
  permission_type   TEXT NOT NULL,                              -- read | write | forward | audit | invoke | subscribe
  granted_by        TEXT,                                       -- 授权人 subject_id
  expires_at        TIMESTAMPTZ,                                -- 过期时间（可选）
  revoked_at        TIMESTAMPTZ,                                -- 撤销时间
  revoke_reason     TEXT,                                       -- 撤销原因
  metadata          JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (node_id, capability_id, permission_type) WHERE revoked_at IS NULL
);

CREATE INDEX IF NOT EXISTS federation_perm_grants_tenant ON federation_permission_grants (tenant_id);
CREATE INDEX IF NOT EXISTS federation_perm_grants_node ON federation_permission_grants (node_id);
CREATE INDEX IF NOT EXISTS federation_perm_grants_active ON federation_permission_grants (tenant_id, node_id) 
  WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. 用户级跨域授权 - 用户 A 授权用户 B 访问特定能力
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS federation_user_grants (
  user_grant_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  grantor_subject   TEXT NOT NULL,                              -- 授权人 subject_id
  grantee_node_id   UUID NOT NULL REFERENCES federation_nodes(node_id),
  grantee_subject   TEXT NOT NULL,                              -- 被授权人 subject_id（远程）
  capability_id     UUID REFERENCES federation_node_capabilities(capability_id),  -- 特定能力（NULL 表示全部）
  permission_type   TEXT NOT NULL,                              -- read | write | forward | audit
  scope             TEXT NOT NULL DEFAULT 'specific',           -- specific | all_capabilities
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoke_reason     TEXT,
  metadata          JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_user_grants_grantor ON federation_user_grants (tenant_id, grantor_subject);
CREATE INDEX IF NOT EXISTS federation_user_grants_grantee ON federation_user_grants (tenant_id, grantee_node_id, grantee_subject);
CREATE INDEX IF NOT EXISTS federation_user_grants_active ON federation_user_grants (tenant_id, grantee_node_id, grantee_subject)
  WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. 内容策略 - 数据用途限制、生命周期约束、脱敏规则
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS federation_content_policies (
  policy_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  name              TEXT NOT NULL,                              -- 策略名称
  policy_type       TEXT NOT NULL,                              -- usage_restriction | lifecycle | redaction | encryption
  target_type       TEXT NOT NULL DEFAULT 'all',                -- all | capability | node | user
  target_id         TEXT,                                       -- 目标 ID（根据 target_type）
  rules             JSONB NOT NULL,                             -- 策略规则 JSON
  priority          INT NOT NULL DEFAULT 100,                   -- 优先级（越小越高）
  enabled           BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_content_policies_tenant ON federation_content_policies (tenant_id);
CREATE INDEX IF NOT EXISTS federation_content_policies_type ON federation_content_policies (tenant_id, policy_type);
CREATE INDEX IF NOT EXISTS federation_content_policies_enabled ON federation_content_policies (tenant_id, enabled, priority);

-- 内容策略规则示例:
-- usage_restriction: { "allowed_purposes": ["display", "analytics"], "denied_purposes": ["resale", "training"] }
-- lifecycle: { "retention_days": 30, "auto_delete": true, "require_explicit_delete": false }
-- redaction: { "fields": ["email", "phone"], "method": "mask", "pattern": "***" }
-- encryption: { "algorithm": "AES-256-GCM", "key_rotation_days": 90 }

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. 跨域操作审计日志（增强）
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS federation_audit_logs (
  log_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  correlation_id    TEXT,                                       -- 关联 ID（跨请求追踪）
  node_id           UUID REFERENCES federation_nodes(node_id),
  direction         TEXT NOT NULL,                              -- inbound | outbound | internal
  operation_type    TEXT NOT NULL,                              -- permission_check | data_access | capability_invoke | grant_change
  subject_id        TEXT,                                       -- 操作人
  target_capability TEXT,                                       -- 目标能力
  permission_type   TEXT,                                       -- 请求的权限类型
  decision          TEXT NOT NULL,                              -- allowed | denied | rate_limited | policy_blocked
  decision_reason   TEXT,                                       -- 决策原因
  policy_ids        TEXT[],                                     -- 生效的策略 ID 列表
  request_digest    JSONB,                                      -- 请求摘要
  response_digest   JSONB,                                      -- 响应摘要
  latency_ms        INT,
  client_ip         TEXT,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_audit_logs_tenant_time ON federation_audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS federation_audit_logs_node ON federation_audit_logs (tenant_id, node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS federation_audit_logs_correlation ON federation_audit_logs (tenant_id, correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS federation_audit_logs_subject ON federation_audit_logs (tenant_id, subject_id, created_at DESC) WHERE subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS federation_audit_logs_decision ON federation_audit_logs (tenant_id, decision, created_at DESC);
