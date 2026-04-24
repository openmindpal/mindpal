-- State Events for Event Sourcing
-- Retention: call purgeStaleStateEvents(pool, 30) periodically to remove events older than 30 days
CREATE TABLE IF NOT EXISTS state_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  triggered_by TEXT NOT NULL DEFAULT 'system',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_state_events_run ON state_events (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_state_events_tenant ON state_events (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_state_events_status ON state_events (from_status, to_status);
