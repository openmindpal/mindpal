-- migration-aliases: 130_federation_nodes,131_federation_permissions
-- Domain: Federation — nodes, capabilities, permissions, content policies, audit

-- ═══ Federation Nodes ═══

CREATE TABLE IF NOT EXISTS federation_nodes (
  node_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  direction       TEXT NOT NULL DEFAULT 'bi',
  auth_method     TEXT NOT NULL DEFAULT 'bearer',
  auth_secret_id  UUID REFERENCES secret_records(id),
  status          TEXT NOT NULL DEFAULT 'pending',
  trust_level     TEXT NOT NULL DEFAULT 'untrusted',
  metadata        JSONB DEFAULT '{}'::jsonb,
  last_heartbeat  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, endpoint)
);

CREATE INDEX IF NOT EXISTS federation_nodes_tenant_status ON federation_nodes (tenant_id, status);

-- ═══ Federation Envelope Logs ═══

CREATE TABLE IF NOT EXISTS federation_envelope_logs (
  log_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  node_id         UUID NOT NULL REFERENCES federation_nodes(node_id),
  direction       TEXT NOT NULL,
  envelope_type   TEXT NOT NULL,
  correlation_id  TEXT,
  payload_digest  JSONB,
  status          TEXT NOT NULL DEFAULT 'pending',
  error_message   TEXT,
  latency_ms      INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_envelope_logs_tenant_node ON federation_envelope_logs (tenant_id, node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS federation_envelope_logs_correlation ON federation_envelope_logs (tenant_id, correlation_id) WHERE correlation_id IS NOT NULL;

-- ═══ Node Capabilities ═══

CREATE TABLE IF NOT EXISTS federation_node_capabilities (
  capability_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  node_id         UUID NOT NULL REFERENCES federation_nodes(node_id),
  capability_type TEXT NOT NULL,
  capability_ref  TEXT NOT NULL,
  version         TEXT,
  status          TEXT NOT NULL DEFAULT 'available',
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, node_id, capability_type, capability_ref)
);

CREATE INDEX IF NOT EXISTS federation_node_capabilities_node ON federation_node_capabilities (tenant_id, node_id);

-- ═══ Permission Declarations ═══

CREATE TABLE IF NOT EXISTS federation_permission_declarations (
  declaration_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  capability_id     UUID NOT NULL REFERENCES federation_node_capabilities(capability_id),
  permission_type   TEXT NOT NULL,
  required_trust    TEXT NOT NULL DEFAULT 'trusted',
  rate_limit        INT,
  description       TEXT,
  metadata          JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (capability_id, permission_type)
);

CREATE INDEX IF NOT EXISTS federation_permission_decl_tenant ON federation_permission_declarations (tenant_id);
CREATE INDEX IF NOT EXISTS federation_permission_decl_cap ON federation_permission_declarations (capability_id);

-- ═══ Permission Grants (node-level) ═══

CREATE TABLE IF NOT EXISTS federation_permission_grants (
  grant_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  node_id           UUID NOT NULL REFERENCES federation_nodes(node_id),
  capability_id     UUID NOT NULL REFERENCES federation_node_capabilities(capability_id),
  permission_type   TEXT NOT NULL,
  granted_by        TEXT,
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoke_reason     TEXT,
  metadata          JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS federation_perm_grants_unique_active
  ON federation_permission_grants (node_id, capability_id, permission_type)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS federation_perm_grants_tenant ON federation_permission_grants (tenant_id);
CREATE INDEX IF NOT EXISTS federation_perm_grants_node ON federation_permission_grants (node_id);
CREATE INDEX IF NOT EXISTS federation_perm_grants_active ON federation_permission_grants (tenant_id, node_id, expires_at)
  WHERE revoked_at IS NULL;

-- ═══ User Grants (cross-domain) ═══

CREATE TABLE IF NOT EXISTS federation_user_grants (
  user_grant_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  grantor_subject   TEXT NOT NULL,
  grantee_node_id   UUID NOT NULL REFERENCES federation_nodes(node_id),
  grantee_subject   TEXT NOT NULL,
  capability_id     UUID REFERENCES federation_node_capabilities(capability_id),
  permission_type   TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'specific',
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoke_reason     TEXT,
  metadata          JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_user_grants_grantor ON federation_user_grants (tenant_id, grantor_subject);
CREATE INDEX IF NOT EXISTS federation_user_grants_grantee ON federation_user_grants (tenant_id, grantee_node_id, grantee_subject);
CREATE INDEX IF NOT EXISTS federation_user_grants_active ON federation_user_grants (tenant_id, grantee_node_id, grantee_subject, expires_at)
  WHERE revoked_at IS NULL;

-- ═══ Content Policies ═══

CREATE TABLE IF NOT EXISTS federation_content_policies (
  policy_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  name              TEXT NOT NULL,
  policy_type       TEXT NOT NULL,
  target_type       TEXT NOT NULL DEFAULT 'all',
  target_id         TEXT,
  rules             JSONB NOT NULL,
  priority          INT NOT NULL DEFAULT 100,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_content_policies_tenant ON federation_content_policies (tenant_id);
CREATE INDEX IF NOT EXISTS federation_content_policies_type ON federation_content_policies (tenant_id, policy_type);
CREATE INDEX IF NOT EXISTS federation_content_policies_enabled ON federation_content_policies (tenant_id, enabled, priority);

-- ═══ Federation Audit Logs ═══

CREATE TABLE IF NOT EXISTS federation_audit_logs (
  log_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  correlation_id    TEXT,
  node_id           UUID REFERENCES federation_nodes(node_id),
  direction         TEXT NOT NULL,
  operation_type    TEXT NOT NULL,
  subject_id        TEXT,
  target_capability TEXT,
  permission_type   TEXT,
  decision          TEXT NOT NULL,
  decision_reason   TEXT,
  policy_ids        TEXT[],
  request_digest    JSONB,
  response_digest   JSONB,
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
