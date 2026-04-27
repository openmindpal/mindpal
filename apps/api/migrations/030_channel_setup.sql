-- 030: Channel setup enhancements — QR-code auto-provisioning support
ALTER TABLE channel_webhook_configs
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_provisioned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admission_policy TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS display_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS setup_state JSONB NULL;

-- admission_policy: 'open' (所有人可用) | 'pairing' (需配对)
-- auto_provisioned: true 表示通过扫码自动创建
-- setup_state: 存储平台返回的额外状态（如 webhook_registration_id）

CREATE INDEX IF NOT EXISTS channel_webhook_configs_enabled_idx
  ON channel_webhook_configs (tenant_id, enabled, provider);
