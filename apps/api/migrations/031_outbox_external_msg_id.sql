ALTER TABLE channel_outbox_messages
  ADD COLUMN IF NOT EXISTS external_message_id TEXT NULL;

COMMENT ON COLUMN channel_outbox_messages.external_message_id
  IS '平台侧消息 ID，用于后续编辑/更新消息';
