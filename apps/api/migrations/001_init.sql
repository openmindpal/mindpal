-- 001: 基础初始化 — 扩展、迁移追踪、Schema 注册
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Schema 注册表（元数据平面）
CREATE TABLE IF NOT EXISTS schemas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  schema_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  UNIQUE (name, version)
);

CREATE INDEX IF NOT EXISTS schemas_name_status_version_idx
  ON schemas (name, status, version DESC);

-- Schema 活跃版本
CREATE TABLE IF NOT EXISTS schema_active_versions (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS schema_active_overrides (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, name)
);

-- ═══ 意图锚定与边界违例检测（P0-2） ═══
-- 意图锚定表：持久化用户显式指令，用于运行时对齐校验
CREATE TABLE IF NOT EXISTS intent_anchors (
  anchor_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT,
  subject_id TEXT NOT NULL,
  original_instruction TEXT NOT NULL,
  instruction_digest TEXT NOT NULL,
  instruction_type TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  conversation_id TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  CONSTRAINT intent_anchors_digest_uniq UNIQUE (tenant_id, instruction_digest)
);

CREATE INDEX IF NOT EXISTS intent_anchors_tenant_subject_idx ON intent_anchors (tenant_id, subject_id);
CREATE INDEX IF NOT EXISTS intent_anchors_run_idx ON intent_anchors (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS intent_anchors_task_idx ON intent_anchors (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS intent_anchors_active_idx ON intent_anchors (is_active) WHERE is_active = true;

-- 边界违例记录表：记录自治行为与用户指令冲突的事件
CREATE TABLE IF NOT EXISTS boundary_violations (
  violation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT,
  violation_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high',
  anchor_id UUID REFERENCES intent_anchors(anchor_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  step_id TEXT,
  agent_action TEXT,
  user_intent TEXT,
  action_taken TEXT NOT NULL,
  remediation_details JSONB,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  CONSTRAINT boundary_violations_severity_check CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT boundary_violations_type_check CHECK (violation_type IN ('intent_override', 'constraint_breach', 'prohibition_violation')),
  CONSTRAINT boundary_violations_action_check CHECK (action_taken IN ('auto_reverted', 'paused_for_review', 'escalated', 'ignored'))
);

CREATE INDEX IF NOT EXISTS boundary_violations_tenant_run_idx ON boundary_violations (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS boundary_violations_anchor_idx ON boundary_violations (anchor_id);
CREATE INDEX IF NOT EXISTS boundary_violations_unresolved_idx ON boundary_violations (resolved_at) WHERE resolved_at IS NULL;

-- 触发器：自动更新 intent_anchors.updated_at
CREATE OR REPLACE FUNCTION intent_anchors_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS intent_anchors_updated_at ON intent_anchors;
CREATE TRIGGER intent_anchors_updated_at
  BEFORE UPDATE ON intent_anchors
  FOR EACH ROW
  EXECUTE FUNCTION intent_anchors_update_timestamp();

COMMENT ON TABLE intent_anchors IS 'P0-2: 意图锚定表 - 持久化用户显式指令，用于Agent运行时对齐校验';
COMMENT ON TABLE boundary_violations IS 'P0-2: 边界违例表 - 记录自治行为与用户指令冲突的事件';

-- 跨设备消息审计表（P1-1）
CREATE TABLE IF NOT EXISTS device_message_audit (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_message_audit_tenant_msg_idx ON device_message_audit (tenant_id, message_id);
CREATE INDEX IF NOT EXISTS device_message_audit_event_idx ON device_message_audit (event_type);

COMMENT ON TABLE device_message_audit IS 'P1-1: 跨设备消息审计表 - 记录消息投递失败、重试耗尽等事件';

-- (原027) pgvector
-- 记忆检索向量化加速：启用 pgvector 扩展并创建记忆向量表
-- P2级：大数据集下 minhash + ILIKE 为 O(n) 扫描，pgvector 实现 ANN 近似最近邻加速

-- 1. 启用 pgvector 扩展（需要 PostgreSQL 超级用户权限或已预装扩展）
--    若扩展不可用则安全跳过整个迁移（P2 级，降级为 minhash + ILIKE 检索）
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[027_pgvector] pgvector extension not available, skipping vector tables (fallback to minhash)';
  RETURN;
END;
$$;

-- 2. 记忆向量表：存储 memory_entries 对应的 embedding 向量
--    仅在 vector 类型可用时创建
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS memory_vectors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      memory_id UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
      embedding vector(1536),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    -- 3. HNSW 索引
    CREATE INDEX IF NOT EXISTS idx_memory_vectors_hnsw
      ON memory_vectors USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);

    -- 4. memory_id 关联索引
    CREATE INDEX IF NOT EXISTS idx_memory_vectors_memory_id
      ON memory_vectors(memory_id);
  END IF;
END;
$$;
