-- 026_mfa.sql  —  Multi-Factor Authentication (TOTP + Recovery Codes)

CREATE TABLE IF NOT EXISTS mfa_enrollments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_id    TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  method        TEXT NOT NULL DEFAULT 'totp',
  secret_enc    TEXT NOT NULL,
  recovery_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_mfa_enrollments_tenant_subject
  ON mfa_enrollments (tenant_id, subject_id);
