-- 008: Artifacts & Backups
-- Consolidated from: 025, 026, 068, 069, 157

-- ── artifacts ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  type TEXT NOT NULL,
  format TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INT NOT NULL,
  content_text TEXT NOT NULL,
  source JSONB NULL,
  run_id UUID NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  created_by_subject_id TEXT NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifacts_scope_time_idx
  ON artifacts (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS artifacts_type_time_idx
  ON artifacts (tenant_id, space_id, type, created_at DESC);

-- ── artifact_download_tokens ─────────────────────────────────
CREATE TABLE IF NOT EXISTS artifact_download_tokens (
  token_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  artifact_id UUID NOT NULL REFERENCES artifacts(artifact_id),
  issued_by_subject_id TEXT REFERENCES subjects(id),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INT NOT NULL DEFAULT 1,
  used_count INT NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_download_tokens_hash_uidx
  ON artifact_download_tokens (token_hash);

CREATE INDEX IF NOT EXISTS artifact_download_tokens_lookup_idx
  ON artifact_download_tokens (tenant_id, space_id, artifact_id, expires_at);

-- ── artifact_policies ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifact_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  download_token_expires_in_sec INT NOT NULL DEFAULT 300,
  download_token_max_uses INT NOT NULL DEFAULT 1,
  watermark_headers_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS artifact_policies_lookup_idx
  ON artifact_policies (tenant_id, scope_type, scope_id);

-- ── backups ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backups (
  backup_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  status TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'space',
  schema_name TEXT NOT NULL,
  entity_names JSONB NULL,
  format TEXT NOT NULL,
  backup_artifact_id UUID NULL REFERENCES artifacts(artifact_id),
  report_artifact_id UUID NULL REFERENCES artifacts(artifact_id),
  policy_snapshot_ref TEXT NULL,
  run_id UUID NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backups_scope_time_idx
  ON backups (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS backups_status_time_idx
  ON backups (tenant_id, space_id, status, created_at DESC);

-- ── db_backups ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS db_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_type TEXT NOT NULL CHECK (backup_type IN ('full', 'incremental')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired', 'verified', 'verify_failed')),
  storage_backend TEXT NOT NULL DEFAULT 'local' CHECK (storage_backend IN ('local', 's3')),
  storage_path TEXT NOT NULL,
  file_size_bytes BIGINT,
  sha256_checksum TEXT,
  pg_dump_format TEXT NOT NULL DEFAULT 'custom' CHECK (pg_dump_format IN ('custom', 'directory', 'plain')),
  pg_version TEXT,
  database_name TEXT NOT NULL,
  scope_schemas JSONB,
  scope_tenants JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  error_message TEXT,
  worker_id TEXT,
  verified_at TIMESTAMPTZ,
  verify_toc_ok BOOLEAN,
  verify_checksum_ok BOOLEAN,
  verify_error TEXT,
  retention_policy TEXT NOT NULL DEFAULT 'standard',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS db_backups_type_status_idx
  ON db_backups (backup_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS db_backups_expires_at_idx
  ON db_backups (expires_at)
  WHERE expires_at IS NOT NULL AND status NOT IN ('expired');

CREATE INDEX IF NOT EXISTS db_backups_completed_idx
  ON db_backups (backup_type, finished_at DESC)
  WHERE status IN ('completed', 'verified');
