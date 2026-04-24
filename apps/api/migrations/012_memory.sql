-- 012: Memory System
-- Consolidated from: 012, 013, 097, 124, 136, 137, 138, 141, 143, 150a, 154, 159, 160

-- ── memory_entries ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  owner_subject_id TEXT NULL,
  scope TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NULL,
  content_text TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  write_policy TEXT NOT NULL,
  source_ref JSONB NULL,
  deleted_at TIMESTAMPTZ NULL,
  -- Retention (from 013)
  expires_at TIMESTAMPTZ NULL,
  retention_days INT NULL,
  -- Embedding (from 124)
  embedding_model_ref TEXT NULL,
  embedding_minhash INT[] NULL,
  embedding_updated_at TIMESTAMPTZ NULL,
  -- Write proof (from 136)
  write_proof JSONB DEFAULT NULL,
  -- Quality governance (from 137)
  source_trust SMALLINT DEFAULT 50,
  fact_version INT DEFAULT 1,
  confidence REAL DEFAULT 0.5,
  salience REAL DEFAULT 0.5,
  conflict_marker UUID DEFAULT NULL,
  resolution_status TEXT DEFAULT NULL,
  -- Memory OS: three-tier classification (from 154)
  memory_class TEXT NOT NULL DEFAULT 'semantic'
    CHECK (memory_class IN ('episodic', 'semantic', 'procedural')),
  access_count INT NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  decay_score REAL NOT NULL DEFAULT 1.0,
  decay_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Distillation chain (from 154)
  distilled_from UUID[] DEFAULT NULL,
  distilled_to UUID DEFAULT NULL,
  distillation_generation INT NOT NULL DEFAULT 0,
  -- Arbitration (from 154)
  arbitration_strategy TEXT DEFAULT NULL
    CHECK (arbitration_strategy IN ('time_priority', 'confidence_priority', 'user_confirmed', 'auto_merged')),
  arbitrated_at TIMESTAMPTZ DEFAULT NULL,
  arbitrated_by TEXT DEFAULT NULL,
  -- Dense embedding vector (from 159)
  embedding_vector JSONB NULL,
  -- Pinned (from 160)
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  pinned_at TIMESTAMPTZ DEFAULT NULL,
  pinned_by TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_entries_scope_time_idx
  ON memory_entries (tenant_id, space_id, scope, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_entries_owner_time_idx
  ON memory_entries (tenant_id, space_id, owner_subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_entries_type_time_idx
  ON memory_entries (tenant_id, space_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_entries_expires_at_idx
  ON memory_entries (tenant_id, space_id, expires_at);
CREATE INDEX IF NOT EXISTS memory_entries_embedding_minhash_gin_idx
  ON memory_entries USING GIN (embedding_minhash)
  WHERE deleted_at IS NULL AND embedding_minhash IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_entries_embedding_updated_idx
  ON memory_entries (tenant_id, space_id, embedding_updated_at DESC NULLS LAST)
  WHERE deleted_at IS NULL AND embedding_minhash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_entries_write_proof_policy
  ON memory_entries ((write_proof->>'policy')) WHERE write_proof IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_entries_conflict_marker
  ON memory_entries (conflict_marker) WHERE conflict_marker IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_entries_resolution_status
  ON memory_entries (resolution_status) WHERE resolution_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_entries_confidence_salience
  ON memory_entries (tenant_id, space_id, confidence DESC, salience DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_entries_class
  ON memory_entries (tenant_id, space_id, memory_class, decay_score DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_entries_distill_candidates
  ON memory_entries (tenant_id, space_id, memory_class, created_at DESC)
  WHERE deleted_at IS NULL AND distilled_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_entries_decay_scan
  ON memory_entries (tenant_id, decay_updated_at) WHERE deleted_at IS NULL AND decay_score > 0;
CREATE INDEX IF NOT EXISTS idx_memory_entries_access
  ON memory_entries (tenant_id, space_id, access_count DESC, last_accessed_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS memory_entries_embedding_vector_exists_idx
  ON memory_entries (tenant_id, space_id, memory_class) WHERE embedding_vector IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_entries_pinned
  ON memory_entries (tenant_id, space_id, pinned, created_at DESC) WHERE deleted_at IS NULL AND pinned = TRUE;

-- ── memory_task_states ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_task_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  run_id UUID NOT NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  phase TEXT NOT NULL,
  plan JSONB NULL,
  artifacts_digest JSONB NULL,
  deleted_at TIMESTAMPTZ NULL,
  -- Relations (from 138)
  subject_id TEXT DEFAULT NULL,
  parent_run_id UUID DEFAULT NULL,
  related_run_ids UUID[] DEFAULT NULL,
  task_summary TEXT DEFAULT NULL,
  embedding_minhash INT[] DEFAULT NULL,
  -- Block reason (from 141)
  block_reason TEXT NULL,
  -- Agent columns (from 143)
  role TEXT NULL,
  next_action TEXT NULL,
  evidence JSONB NULL,
  approval_status TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_task_states_unique
  ON memory_task_states (tenant_id, space_id, run_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_task_states_subject_id
  ON memory_task_states (tenant_id, space_id, subject_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_task_states_parent_run_id
  ON memory_task_states (tenant_id, parent_run_id) WHERE parent_run_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_task_states_embedding_minhash
  ON memory_task_states USING gin (embedding_minhash) WHERE embedding_minhash IS NOT NULL AND deleted_at IS NULL;

-- ── memory_session_contexts ──────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_session_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  context_digest JSONB NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_session_contexts_scope_idx
  ON memory_session_contexts (tenant_id, space_id, subject_id, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS memory_session_contexts_unique
  ON memory_session_contexts (tenant_id, space_id, subject_id, session_id);

-- ── memory_user_preferences ──────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_user_preferences (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_id TEXT NOT NULL,
  pref_key TEXT NOT NULL,
  pref_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_id, pref_key)
);

-- ── memory_entry_attachments ─────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_entry_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  memory_id UUID NOT NULL,
  media_id UUID NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'file',
  caption TEXT NULL,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_entry_attachments_memory ON memory_entry_attachments (tenant_id, memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_entry_attachments_media ON memory_entry_attachments (tenant_id, media_id);

-- ── memory_distillation_log ──────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_distillation_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  distillation_type TEXT NOT NULL
    CHECK (distillation_type IN ('episodic_to_semantic', 'semantic_to_procedural', 'merge')),
  source_memory_ids UUID[] NOT NULL,
  target_memory_id UUID NOT NULL,
  model_ref TEXT,
  reasoning TEXT,
  quality_score REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_distillation_log_tenant
  ON memory_distillation_log (tenant_id, space_id, created_at DESC);

-- ── memory_arbitration_log ───────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_arbitration_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  conflict_memory_ids UUID[] NOT NULL,
  strategy TEXT NOT NULL,
  winner_memory_id UUID,
  merged_memory_id UUID,
  reasoning TEXT,
  needs_user_confirmation BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_arbitration_log_tenant
  ON memory_arbitration_log (tenant_id, space_id, created_at DESC);

-- (原029) Memory Global Scope — 跨会话全局记忆支持
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
