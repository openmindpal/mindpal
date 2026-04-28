-- 011: Knowledge Base
-- Consolidated from: 011, 084, 086, 112, 150, 029_chunk_strategy_metadata, 030_document_parser

-- ── knowledge_documents ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  version INT NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  tags JSONB NULL,
  content_text TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'space',
  owner_subject_id TEXT NULL,
  -- 解析元数据（from 030_document_parser）
  original_content_type TEXT DEFAULT NULL,
  original_byte_size BIGINT DEFAULT NULL,
  parse_method TEXT DEFAULT NULL,
  parse_stats JSONB DEFAULT NULL,
  source_file_name TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN knowledge_documents.original_content_type IS '上传时的原始 MIME 类型 (如 application/pdf)';
COMMENT ON COLUMN knowledge_documents.original_byte_size    IS '上传时的原始文件字节数';
COMMENT ON COLUMN knowledge_documents.parse_method          IS '解析方法 (如 pdf-parse, mammoth, xlsx, pptx-xml, plaintext)';
COMMENT ON COLUMN knowledge_documents.parse_stats           IS '解析统计信息 (JSON: parseTimeMs, elementCount, warnings 等)';
COMMENT ON COLUMN knowledge_documents.source_file_name      IS '上传时的原始文件名';

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_documents_unique_version
  ON knowledge_documents (tenant_id, space_id, id, version);
CREATE INDEX IF NOT EXISTS knowledge_documents_by_scope
  ON knowledge_documents (tenant_id, space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_documents_visibility_idx
  ON knowledge_documents (tenant_id, space_id, visibility, owner_subject_id, created_at DESC);

-- ── knowledge_chunks ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id),
  document_version INT NOT NULL,
  chunk_index INT NOT NULL,
  start_offset INT NOT NULL,
  end_offset INT NOT NULL,
  snippet TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  embedding_model_ref TEXT NULL,
  embedding_minhash INT[] NULL,
  embedding_updated_at TIMESTAMPTZ NULL,
  embedding_vector JSONB NULL,
  -- 分块策略元数据（from 029_chunk_strategy_metadata）
  chunk_strategy TEXT NULL,
  hierarchy_path TEXT NULL,
  overlap_before INT NOT NULL DEFAULT 0,
  overlap_after INT NOT NULL DEFAULT 0,
  -- Parent-Child 分块支持（from 030_document_parser）
  parent_chunk_id TEXT DEFAULT NULL,
  chunk_role TEXT DEFAULT 'standalone',
  -- 稀疏向量（from 030_document_parser）
  sparse_vector JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN knowledge_chunks.parent_chunk_id IS 'Parent-Child 分块模式中的父 chunk ID，child chunk 指向 parent';
COMMENT ON COLUMN knowledge_chunks.chunk_role      IS '分块角色: standalone(独立) | parent(父块) | child(子块)';
COMMENT ON COLUMN knowledge_chunks.sparse_vector   IS '稀疏向量 (BM25 term-weight pairs)，用于 Hybrid Search';

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_chunks_unique
  ON knowledge_chunks (tenant_id, space_id, document_id, document_version, chunk_index);
CREATE INDEX IF NOT EXISTS knowledge_chunks_by_scope
  ON knowledge_chunks (tenant_id, space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_scope_idx
  ON knowledge_chunks (tenant_id, space_id, embedding_updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_minhash_gin
  ON knowledge_chunks USING GIN (embedding_minhash);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_vector_exists_idx
  ON knowledge_chunks (tenant_id, space_id, document_id) WHERE embedding_vector IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_parent
  ON knowledge_chunks (parent_chunk_id)
  WHERE parent_chunk_id IS NOT NULL;

-- ── knowledge_index_jobs ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_index_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id),
  document_version INT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT NULL,
  attempt INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_index_jobs_by_scope
  ON knowledge_index_jobs (tenant_id, space_id, created_at DESC);

-- ── knowledge_retrieval_logs ─────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_retrieval_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  query_digest JSONB NOT NULL,
  filters_digest JSONB NULL,
  candidate_count INT NOT NULL,
  cited_refs JSONB NOT NULL,
  rank_policy TEXT NULL,
  stage_stats JSONB NULL,
  ranked_evidence_refs JSONB NULL,
  returned_count INT NULL,
  degraded BOOLEAN NOT NULL DEFAULT false,
  strategy_ref TEXT NULL,
  vector_store_ref JSONB NULL,
  degrade_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_retrieval_logs_by_scope
  ON knowledge_retrieval_logs (tenant_id, space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_retrieval_logs_strategy_ref_idx
  ON knowledge_retrieval_logs (tenant_id, space_id, strategy_ref, created_at DESC);

-- ── knowledge_embedding_jobs ─────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_embedding_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id),
  document_version INT NOT NULL,
  embedding_model_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space_id, document_id, document_version, embedding_model_ref)
);

CREATE INDEX IF NOT EXISTS knowledge_embedding_jobs_by_scope
  ON knowledge_embedding_jobs (tenant_id, space_id, status, updated_at DESC);

-- ── knowledge_ingest_jobs ────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_ingest_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_event_pk UUID NULL,
  status TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  document_id UUID NULL,
  document_version INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, workspace_id, event_id)
);

CREATE INDEX IF NOT EXISTS knowledge_ingest_jobs_by_scope
  ON knowledge_ingest_jobs (tenant_id, space_id, status, updated_at DESC);

-- ── knowledge_retrieval_eval_sets ────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_retrieval_eval_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  queries JSONB NOT NULL,
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_retrieval_eval_sets_by_scope
  ON knowledge_retrieval_eval_sets (tenant_id, space_id, created_at DESC);

-- ── knowledge_retrieval_eval_runs ────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_retrieval_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  eval_set_id UUID NOT NULL REFERENCES knowledge_retrieval_eval_sets(id),
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  metrics JSONB NULL,
  results JSONB NULL,
  failures JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_retrieval_eval_runs_by_scope
  ON knowledge_retrieval_eval_runs (tenant_id, space_id, eval_set_id, created_at DESC);

-- ── knowledge_evidence_access_events ─────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_evidence_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  subject_id TEXT NULL,
  retrieval_log_id UUID NULL REFERENCES knowledge_retrieval_logs(id),
  document_id UUID NULL,
  document_version INT NULL,
  chunk_id UUID NULL,
  allowed BOOLEAN NOT NULL,
  reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_evidence_access_events_by_scope
  ON knowledge_evidence_access_events (tenant_id, space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_evidence_access_events_by_subject
  ON knowledge_evidence_access_events (tenant_id, space_id, subject_id, created_at DESC);

-- ── knowledge_evidence_retention_policies ────────────────────
CREATE TABLE IF NOT EXISTS knowledge_evidence_retention_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  allow_snippet BOOLEAN NOT NULL DEFAULT true,
  retention_days INT NOT NULL DEFAULT 30,
  max_snippet_len INT NOT NULL DEFAULT 600,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id)
);

-- ── knowledge_retrieval_strategies ───────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_retrieval_strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  config JSONB NOT NULL,
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- HyDE / Query Expansion（from 030_document_parser）
  enable_hyde BOOLEAN DEFAULT FALSE,
  hyde_prompt_template TEXT DEFAULT NULL,
  enable_query_expansion BOOLEAN DEFAULT FALSE,
  query_expansion_mode TEXT DEFAULT 'synonym',
  enable_sparse_embedding BOOLEAN DEFAULT FALSE,
  UNIQUE (tenant_id, space_id, name, version)
);

COMMENT ON COLUMN knowledge_retrieval_strategies.enable_hyde             IS '是否启用 HyDE (Hypothetical Document Embedding) 查询增强';
COMMENT ON COLUMN knowledge_retrieval_strategies.hyde_prompt_template    IS 'HyDE 提示词模板 ({{query}} 占位符)';
COMMENT ON COLUMN knowledge_retrieval_strategies.enable_query_expansion  IS '是否启用查询扩展 (同义词扩展 + 子查询分解)';
COMMENT ON COLUMN knowledge_retrieval_strategies.query_expansion_mode    IS '查询扩展模式: synonym | subquery | both';
COMMENT ON COLUMN knowledge_retrieval_strategies.enable_sparse_embedding IS '是否启用稀疏向量 (BM25 向量化) 混合检索';

CREATE INDEX IF NOT EXISTS knowledge_retrieval_strategies_by_scope
  ON knowledge_retrieval_strategies (tenant_id, space_id, status, updated_at DESC);

-- ── knowledge_retrieval_strategy_actives ─────────────────────
CREATE TABLE IF NOT EXISTS knowledge_retrieval_strategy_actives (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  strategy_id UUID NOT NULL REFERENCES knowledge_retrieval_strategies(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id)
);

-- ── knowledge_retrieval_strategy_eval_runs ───────────────────
CREATE TABLE IF NOT EXISTS knowledge_retrieval_strategy_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  eval_set_id UUID NOT NULL REFERENCES knowledge_retrieval_eval_sets(id),
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  strategies JSONB NOT NULL,
  metrics JSONB NULL,
  results JSONB NULL,
  failures JSONB NULL,
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_retrieval_strategy_eval_runs_by_scope
  ON knowledge_retrieval_strategy_eval_runs (tenant_id, space_id, created_at DESC);

-- ── knowledge_rerank_configs ─────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_rerank_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  provider TEXT NOT NULL DEFAULT 'external',
  endpoint TEXT NULL,
  api_key TEXT NULL,
  model TEXT NOT NULL DEFAULT 'rerank-v1',
  top_n INT NOT NULL DEFAULT 10,
  timeout_ms INT NOT NULL DEFAULT 5000,
  fallback_mode TEXT NOT NULL DEFAULT 'cross_encoder_then_rule',
  cross_encoder_model_path TEXT NULL,
  cross_encoder_model_type TEXT NOT NULL DEFAULT 'mock',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space_id)
);

COMMENT ON TABLE knowledge_rerank_configs IS 'Rerank 重排模型配置，per-tenant/per-space 级别，支持外部API/本地Cross-Encoder/规则重排三级级联';

-- ═══ 分块策略配置表（合并 029_chunk_strategy_metadata + 030_document_parser）═══
CREATE TABLE IF NOT EXISTS knowledge_chunk_configs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       TEXT NOT NULL,
  space_id        TEXT NOT NULL,
  strategy        TEXT NOT NULL DEFAULT 'recursive',
  max_len         INT NOT NULL DEFAULT 600,
  overlap         INT NOT NULL DEFAULT 80,
  separators      JSONB DEFAULT NULL,
  semantic_threshold FLOAT DEFAULT 0.5,
  enable_parent_child BOOLEAN NOT NULL DEFAULT FALSE,
  parent_max_len  INT DEFAULT 2000,
  child_max_len   INT DEFAULT 300,
  table_aware     BOOLEAN NOT NULL DEFAULT TRUE,
  code_aware      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space_id)
);

COMMENT ON TABLE knowledge_chunk_configs IS '分块策略配置，per-tenant/per-space 级别';

-- ═══ Embedding 模型配置表（from 030_document_parser）═══
CREATE TABLE IF NOT EXISTS knowledge_embedding_model_configs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       TEXT NOT NULL,
  space_id        TEXT,
  model_name      TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'openai',
  endpoint        TEXT,
  api_key_ref     TEXT,
  dimensions      INT NOT NULL DEFAULT 1536,
  batch_size      INT NOT NULL DEFAULT 50,
  concurrency     INT NOT NULL DEFAULT 2,
  max_retries     INT NOT NULL DEFAULT 2,
  timeout_ms      INT NOT NULL DEFAULT 30000,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emb_model_cfg_tenant
  ON knowledge_embedding_model_configs (tenant_id, space_id, is_active);

COMMENT ON TABLE knowledge_embedding_model_configs IS 'Embedding 模型配置，支持 per-tenant/per-space 热切换不同模型';

-- ═══ 向量存储后端配置表 ═══
CREATE TABLE IF NOT EXISTS knowledge_vector_store_configs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       TEXT NOT NULL,
  space_id        TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'pg_fallback',
  endpoint        TEXT,
  api_key         TEXT,
  timeout_ms      INT NOT NULL DEFAULT 10000,
  collection_prefix TEXT,
  db_name         TEXT DEFAULT 'default',
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space_id)
);

COMMENT ON TABLE knowledge_vector_store_configs IS '向量存储后端配置，per-tenant/per-space 级别，支持 Qdrant/Milvus/External/PG Fallback';

-- ============ merged from 032_collab_knowledge_enhance.sql (knowledge部分) ============
-- 知识引擎：chunks 引用链与源定位字段补齐

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS citation_refs   JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS source_page     INT,
  ADD COLUMN IF NOT EXISTS source_section  TEXT;

COMMENT ON COLUMN knowledge_chunks.citation_refs  IS '引用链 [{chunkId, docId, relation}]';
COMMENT ON COLUMN knowledge_chunks.source_page    IS '源文档页码（PDF 场景）';
COMMENT ON COLUMN knowledge_chunks.source_section IS '源文档章节标识';
