-- 029: Memory Global Scope — 跨会话全局记忆支持
-- 扩展 scope 值域，新增 'global' 表示跨会话持久记忆

-- ── 为全局记忆创建专用索引（跨会话检索性能优化） ──
-- scope='global' 的记忆不绑定特定用户（owner_subject_id 可为 NULL），需按 tenant 级别检索
CREATE INDEX IF NOT EXISTS idx_memory_entries_global_scope
  ON memory_entries (tenant_id, scope, memory_class, decay_score DESC)
  WHERE deleted_at IS NULL AND scope = 'global';

-- ── 全局记忆 + 蒸馏候选索引 ──
CREATE INDEX IF NOT EXISTS idx_memory_entries_global_distill_candidates
  ON memory_entries (tenant_id, memory_class, created_at DESC)
  WHERE deleted_at IS NULL AND distilled_to IS NULL AND scope = 'global';
