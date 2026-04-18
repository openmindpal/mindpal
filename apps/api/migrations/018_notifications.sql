-- migration-aliases: 033_subscriptions,034_notification_templates,040_notification_outbox_delivery,044_subscriptions_next_run_at,045_subscription_runs_error_digest,148_notification_queue_subscriptions,158_notification_preferences
-- Domain: Notifications — subscriptions, templates, outbox, queue, preferences, ws connections

-- ═══ Subscriptions (polling-based) ═══

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  provider TEXT NOT NULL,
  connector_instance_id UUID NULL REFERENCES connector_instances(id),
  status TEXT NOT NULL,
  poll_interval_sec INT NOT NULL,
  watermark JSONB NULL,
  last_run_at TIMESTAMPTZ NULL,
  next_run_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_scope_status_idx
  ON subscriptions (tenant_id, space_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS subscriptions_due_idx
  ON subscriptions (tenant_id, status, last_run_at);

CREATE INDEX IF NOT EXISTS subscriptions_next_run_idx
  ON subscriptions (tenant_id, status, next_run_at);

CREATE TABLE IF NOT EXISTS subscription_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(subscription_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  status TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  watermark_before JSONB NULL,
  watermark_after JSONB NULL,
  event_count INT NOT NULL DEFAULT 0,
  error_category TEXT NULL,
  error_digest JSONB NULL,
  backoff_ms INT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_runs_by_sub_time_idx
  ON subscription_runs (tenant_id, subscription_id, started_at DESC);

-- ═══ Notification Templates ═══

CREATE TABLE IF NOT EXISTS notification_templates (
  template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope_type, scope_id, key, channel)
);

CREATE INDEX IF NOT EXISTS notification_templates_scope_idx
  ON notification_templates (tenant_id, scope_type, scope_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS notification_template_versions (
  template_id UUID NOT NULL REFERENCES notification_templates(template_id),
  version INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  content_i18n JSONB NOT NULL,
  params_schema JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  PRIMARY KEY (template_id, version)
);

CREATE INDEX IF NOT EXISTS notification_template_versions_lookup_idx
  ON notification_template_versions (template_id, status, version DESC);

-- ═══ Notification Outbox ═══

CREATE TABLE IF NOT EXISTS notification_outbox (
  outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  channel TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  template_id UUID NOT NULL REFERENCES notification_templates(template_id),
  template_version INT NOT NULL,
  locale TEXT NOT NULL,
  params_digest JSONB NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  connector_instance_id UUID NULL REFERENCES connector_instances(id),
  delivery_status TEXT NOT NULL DEFAULT 'queued',
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NULL,
  last_error_category TEXT NULL,
  last_error_digest JSONB NULL,
  deadlettered_at TIMESTAMPTZ NULL,
  content_ciphertext JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  canceled_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS notification_outbox_scope_status_idx
  ON notification_outbox (tenant_id, space_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS notification_outbox_delivery_status_idx
  ON notification_outbox (tenant_id, space_id, delivery_status, created_at DESC);

-- ═══ Notification Subscriptions (event-driven) ═══

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  subject_id TEXT NULL,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  channel TEXT NOT NULL,
  channel_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_subs_tenant ON notification_subscriptions(tenant_id, enabled);
CREATE INDEX IF NOT EXISTS idx_notif_subs_lookup ON notification_subscriptions(tenant_id, space_id, subject_id, enabled);

-- ═══ Notification Queue ═══

CREATE TABLE IF NOT EXISTS notification_queue (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  subject_id TEXT NULL,
  subscription_id UUID NOT NULL REFERENCES notification_subscriptions(subscription_id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notif_queue_pending ON notification_queue(tenant_id, status, created_at)
  WHERE status IN ('queued', 'sending');
CREATE INDEX IF NOT EXISTS idx_notif_queue_subject ON notification_queue(tenant_id, subject_id, created_at DESC);

-- ═══ Notification Preferences ═══

CREATE TABLE IF NOT EXISTS notification_preferences (
  preference_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_id TEXT NOT NULL,
  channel_email BOOLEAN NOT NULL DEFAULT true,
  channel_inapp BOOLEAN NOT NULL DEFAULT true,
  channel_im BOOLEAN NOT NULL DEFAULT true,
  channel_webhook BOOLEAN NOT NULL DEFAULT true,
  dnd_enabled BOOLEAN NOT NULL DEFAULT false,
  dnd_start_time TIME,
  dnd_end_time TIME,
  dnd_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  digest_enabled BOOLEAN NOT NULL DEFAULT false,
  digest_interval_minutes INT NOT NULL DEFAULT 60,
  digest_max_batch INT NOT NULL DEFAULT 20,
  rate_limit_per_hour INT NOT NULL DEFAULT 100,
  rate_limit_per_day INT NOT NULL DEFAULT 500,
  min_severity TEXT NOT NULL DEFAULT 'info' CHECK (min_severity IN ('debug', 'info', 'warn', 'error', 'critical')),
  muted_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_notif_pref_lookup ON notification_preferences(tenant_id, subject_id);

-- ═══ Notification Read Status ═══

CREATE TABLE IF NOT EXISTS notification_read_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES notification_queue(notification_id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id, notification_id)
);

CREATE INDEX IF NOT EXISTS idx_notif_read_subject ON notification_read_status(tenant_id, subject_id, notification_id);

-- ═══ Real-time WS Connections ═══

CREATE TABLE IF NOT EXISTS notification_ws_connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT,
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_notif_ws_subject ON notification_ws_connections(tenant_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_notif_ws_node ON notification_ws_connections(node_id);
CREATE INDEX IF NOT EXISTS idx_notif_ws_heartbeat ON notification_ws_connections(last_heartbeat_at);
