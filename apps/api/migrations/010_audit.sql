-- 010: Audit System
-- Consolidated from: 003, 010, 028, 049, 070, 071, 099

-- ── audit_events ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject_id TEXT NULL,
  tenant_id TEXT NULL,
  space_id TEXT NULL,
  resource_type TEXT NOT NULL,
  action TEXT NOT NULL,
  tool_ref TEXT NULL,
  workflow_ref TEXT NULL,
  policy_decision JSONB NULL,
  input_digest JSONB NULL,
  output_digest JSONB NULL,
  idempotency_key TEXT NULL,
  result TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  run_id TEXT NULL,
  step_id TEXT NULL,
  error_category TEXT NULL,
  latency_ms INT NULL,
  request_id TEXT NULL,
  prev_hash TEXT NULL,
  event_hash TEXT NULL,
  outbox_id UUID NULL,
  CONSTRAINT audit_events_error_category_chk CHECK (
    error_category IS NULL
    OR error_category IN ('policy_violation', 'validation_error', 'rate_limited', 'upstream_error', 'internal_error')
  )
);

CREATE INDEX IF NOT EXISTS audit_events_trace_idx ON audit_events (trace_id);
CREATE INDEX IF NOT EXISTS audit_events_subject_time_idx ON audit_events (subject_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx ON audit_events (tenant_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_events_tenant_hash_idx ON audit_events (tenant_id, event_hash);
CREATE INDEX IF NOT EXISTS audit_events_request_idx ON audit_events (request_id);
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_outbox_id_uniq ON audit_events (outbox_id) WHERE outbox_id IS NOT NULL;

-- Immutability triggers
CREATE OR REPLACE FUNCTION audit_events_immutable_trigger()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events_is_append_only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION audit_events_immutable_trigger();

DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION audit_events_immutable_trigger();

-- ── audit_outbox ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_outbox (
  outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id TEXT NOT NULL,
  space_id TEXT NULL,
  event JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ NULL,
  CONSTRAINT audit_outbox_status_chk CHECK (status IN ('queued', 'processing', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS audit_outbox_ready_idx ON audit_outbox (status, next_attempt_at);

-- FK from audit_events.outbox_id → audit_outbox (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_outbox_id_fk'
  ) THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_outbox_id_fk
      FOREIGN KEY (outbox_id) REFERENCES audit_outbox (outbox_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- ── audit_legal_holds ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_legal_holds (
  hold_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  from_ts TIMESTAMPTZ NULL,
  to_ts TIMESTAMPTZ NULL,
  subject_id TEXT NULL,
  trace_id TEXT NULL,
  run_id TEXT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by TEXT NULL,
  released_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_legal_holds_tenant_status_idx ON audit_legal_holds (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_legal_holds_scope_idx ON audit_legal_holds (tenant_id, scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS audit_legal_holds_trace_idx ON audit_legal_holds (tenant_id, trace_id);

-- ── audit_exports ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_exports (
  export_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  filters JSONB NOT NULL,
  artifact_id UUID NULL REFERENCES artifacts(artifact_id),
  artifact_ref TEXT NULL,
  error_digest JSONB NULL
);

CREATE INDEX IF NOT EXISTS audit_exports_tenant_time_idx ON audit_exports (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_exports_tenant_status_idx ON audit_exports (tenant_id, status, created_at DESC);

-- ── audit_siem_destinations ──────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_siem_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  secret_id UUID NOT NULL REFERENCES secret_records(id),
  batch_size INT NOT NULL DEFAULT 200,
  timeout_ms INT NOT NULL DEFAULT 5000,
  max_attempts INT NOT NULL DEFAULT 8,
  backoff_ms_base INT NOT NULL DEFAULT 500,
  dlq_threshold INT NOT NULL DEFAULT 8,
  alert_threshold INT NOT NULL DEFAULT 3,
  alert_enabled BOOLEAN NOT NULL DEFAULT true,
  last_alert_at TIMESTAMPTZ NULL,
  last_alert_digest JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_siem_destinations_retry_chk CHECK (
    max_attempts BETWEEN 1 AND 50
    AND backoff_ms_base BETWEEN 0 AND 60000
    AND dlq_threshold BETWEEN 1 AND 50
    AND alert_threshold BETWEEN 1 AND 100
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS audit_siem_destinations_unique_name ON audit_siem_destinations (tenant_id, name);
CREATE INDEX IF NOT EXISTS audit_siem_destinations_by_tenant ON audit_siem_destinations (tenant_id, enabled);
CREATE INDEX IF NOT EXISTS audit_siem_destinations_tenant_updated_idx ON audit_siem_destinations (tenant_id, updated_at DESC);

-- ── audit_siem_cursors ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_siem_cursors (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  destination_id UUID NOT NULL REFERENCES audit_siem_destinations(id) ON DELETE CASCADE,
  last_ts TIMESTAMPTZ NULL,
  last_event_id UUID NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, destination_id)
);

-- ── audit_siem_outbox ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_siem_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  destination_id UUID NOT NULL REFERENCES audit_siem_destinations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  event_ts TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_digest JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS audit_siem_outbox_unique_event ON audit_siem_outbox (tenant_id, destination_id, event_id);
CREATE INDEX IF NOT EXISTS audit_siem_outbox_pending ON audit_siem_outbox (tenant_id, destination_id, next_attempt_at, event_ts, event_id);

-- ── audit_siem_dlq ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_siem_dlq (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  destination_id UUID NOT NULL REFERENCES audit_siem_destinations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  event_ts TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL,
  last_error_digest JSONB NULL,
  alert_triggered_at TIMESTAMPTZ NULL,
  alert_digest JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_siem_dlq_by_dest ON audit_siem_dlq (tenant_id, destination_id, created_at DESC);
