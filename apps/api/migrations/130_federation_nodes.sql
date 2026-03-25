-- 130: System Link nodes - 智能体系统间互联 (远程节点管理)
-- 支持多个智能体系统之间的双向绑定与通信

-- 远程节点注册表
CREATE TABLE IF NOT EXISTS federation_nodes (
  node_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,                              -- 节点名称(用户可读)
  endpoint        TEXT NOT NULL,                              -- 远端 API 端点 (https://xxx/api)
  direction       TEXT NOT NULL DEFAULT 'bi',                 -- inbound_only | outbound_only | bi
  auth_method     TEXT NOT NULL DEFAULT 'bearer',             -- bearer | hmac | mtls | none
  auth_secret_id  UUID REFERENCES secret_records(id),         -- 关联的密钥记录
  status          TEXT NOT NULL DEFAULT 'pending',            -- pending | active | suspended | revoked
  trust_level     TEXT NOT NULL DEFAULT 'untrusted',          -- untrusted | trusted | verified
  metadata        JSONB DEFAULT '{}'::jsonb,                  -- 扩展元数据
  last_heartbeat  TIMESTAMPTZ,                                -- 最后心跳时间
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, endpoint)
);

CREATE INDEX IF NOT EXISTS federation_nodes_tenant_status ON federation_nodes (tenant_id, status);

-- 系统互联通信日志
CREATE TABLE IF NOT EXISTS federation_envelope_logs (
  log_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  node_id         UUID NOT NULL REFERENCES federation_nodes(node_id),
  direction       TEXT NOT NULL,                              -- inbound | outbound
  envelope_type   TEXT NOT NULL,                              -- proposal | question | answer | observation | command
  correlation_id  TEXT,
  payload_digest  JSONB,
  status          TEXT NOT NULL DEFAULT 'pending',            -- pending | delivered | failed | rejected
  error_message   TEXT,
  latency_ms      INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_envelope_logs_tenant_node ON federation_envelope_logs (tenant_id, node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS federation_envelope_logs_correlation ON federation_envelope_logs (tenant_id, correlation_id) WHERE correlation_id IS NOT NULL;

-- 远程节点能力声明
CREATE TABLE IF NOT EXISTS federation_node_capabilities (
  capability_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  node_id         UUID NOT NULL REFERENCES federation_nodes(node_id),
  capability_type TEXT NOT NULL,                              -- tool | skill | schema | workflow
  capability_ref  TEXT NOT NULL,                              -- 能力引用标识
  version         TEXT,
  status          TEXT NOT NULL DEFAULT 'available',          -- available | deprecated | revoked
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, node_id, capability_type, capability_ref)
);

CREATE INDEX IF NOT EXISTS federation_node_capabilities_node ON federation_node_capabilities (tenant_id, node_id);
