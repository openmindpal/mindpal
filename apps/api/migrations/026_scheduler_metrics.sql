-- 026: Scheduler Metrics Snapshots
-- P2-G7: 调度器指标定期快照持久化

CREATE TABLE IF NOT EXISTS scheduler_metrics_snapshots (
  snapshot_id    TEXT PRIMARY KEY DEFAULT 'singleton',
  metrics        JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 历史快照（可选，按需启用 retention）
CREATE TABLE IF NOT EXISTS scheduler_metrics_history (
  id             BIGSERIAL PRIMARY KEY,
  metrics        JSONB NOT NULL,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduler_metrics_history_at
  ON scheduler_metrics_history (snapshot_at DESC);

-- 保留最近 7 天快照（由应用层或 cron 清理）
COMMENT ON TABLE scheduler_metrics_snapshots IS '调度器指标最新快照（单行 UPSERT）';
COMMENT ON TABLE scheduler_metrics_history IS '调度器指标历史快照（定期追加，用于趋势分析）';
