-- 003: 数据平面与离线同步

-- ═══ 通用实体记录 ═══
CREATE TABLE IF NOT EXISTS entity_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  entity_name TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  schema_version INT NOT NULL,
  payload JSONB NOT NULL,
  revision INT NOT NULL DEFAULT 1,
  owner_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entity_records_scope_entity_idx
  ON entity_records (tenant_id, space_id, entity_name, updated_at DESC);

CREATE INDEX IF NOT EXISTS entity_records_owner_idx
  ON entity_records (tenant_id, space_id, entity_name, owner_subject_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  record_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key, operation, entity_name)
);

-- ═══ Schema 迁移管理 ═══
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  target_version INT NOT NULL,
  kind TEXT NOT NULL,
  plan_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schema_migrations_tenant_schema_time_idx
  ON schema_migrations (tenant_id, schema_name, created_at DESC);

CREATE INDEX IF NOT EXISTS schema_migrations_scope_time_idx
  ON schema_migrations (tenant_id, scope_type, scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schema_migration_runs (
  migration_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  migration_id UUID NOT NULL REFERENCES schema_migrations(migration_id),
  status TEXT NOT NULL DEFAULT 'queued',
  progress_json JSONB NULL,
  job_id UUID NULL,
  run_id UUID NULL,
  step_id UUID NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  canceled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schema_migration_runs_tenant_migration_time_idx
  ON schema_migration_runs (tenant_id, migration_id, created_at DESC);

-- Schema 惰性迁移日志
CREATE TABLE IF NOT EXISTS schema_lazy_migration_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  schema_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  from_version INT NOT NULL,
  to_version INT NOT NULL,
  migration_kind TEXT NOT NULL DEFAULT 'lazy_read',
  patch_applied JSONB,
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schema_lazy_migration_log ON schema_lazy_migration_log(tenant_id, schema_name, record_id);

-- ═══ Yjs 协同文档 ═══
CREATE TABLE IF NOT EXISTS yjs_documents (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  state_b64 TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, entity_name, entity_id)
);

CREATE INDEX IF NOT EXISTS yjs_documents_updated_at_idx
  ON yjs_documents (tenant_id, space_id, entity_name, updated_at DESC);

-- ═══ 离线同步 ═══
CREATE TABLE IF NOT EXISTS sync_ops (
  cursor BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  op_id TEXT NOT NULL,
  client_id TEXT NULL,
  device_id TEXT NULL,
  schema_name TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  record_id UUID NOT NULL,
  base_revision INT NULL,
  patch JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  conflict_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space_id, op_id)
);

CREATE INDEX IF NOT EXISTS sync_ops_pull_idx
  ON sync_ops (tenant_id, space_id, cursor ASC);

CREATE INDEX IF NOT EXISTS sync_ops_record_idx
  ON sync_ops (tenant_id, space_id, entity_name, record_id, cursor DESC);

CREATE TABLE IF NOT EXISTS sync_watermarks (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  client_id TEXT NOT NULL,
  device_id TEXT NULL,
  last_pushed_cursor BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, client_id, device_id)
);

CREATE INDEX IF NOT EXISTS sync_watermarks_lookup_idx
  ON sync_watermarks (tenant_id, space_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sync_merge_runs (
  merge_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  actor_subject_id TEXT NULL,
  input_digest TEXT NOT NULL,
  merge_digest TEXT NOT NULL,
  accepted_count INT NOT NULL DEFAULT 0,
  rejected_count INT NOT NULL DEFAULT 0,
  conflicts_count INT NOT NULL DEFAULT 0,
  transcript_json JSONB NOT NULL,
  trace_id TEXT NULL,
  request_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_merge_runs_tenant_space_time_idx
  ON sync_merge_runs (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sync_merge_runs_tenant_space_input_digest_idx
  ON sync_merge_runs (tenant_id, space_id, input_digest);

CREATE TABLE IF NOT EXISTS sync_conflict_tickets (
  ticket_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  merge_id TEXT NOT NULL,
  status TEXT NOT NULL,
  conflicts_json JSONB NOT NULL,
  resolved_merge_id TEXT NULL,
  abandoned_reason TEXT NULL,
  trace_id TEXT NULL,
  request_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_conflict_tickets_tenant_space_status_time_idx
  ON sync_conflict_tickets (tenant_id, space_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS sync_conflict_tickets_merge_id_idx
  ON sync_conflict_tickets (merge_id);
