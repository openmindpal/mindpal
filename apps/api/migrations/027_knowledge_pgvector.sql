-- 知识分块 Dense Vector 从 JSONB 升级为 pgvector 列 + HNSW 索引
-- 与记忆系统 memory_vectors 表保持一致的索引策略

DO $$
BEGIN
  -- 仅在 pgvector 扩展可用时执行
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    -- 添加 pgvector 类型列
    ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_dense vector(1536);

    -- 创建 HNSW 索引（与 memory_vectors 保持一致：m=16, ef_construction=64）
    CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_dense_hnsw
      ON knowledge_chunks USING hnsw (embedding_dense vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);

    RAISE NOTICE 'knowledge_chunks: pgvector column + HNSW index created';
  ELSE
    RAISE WARNING 'pgvector extension not available, skipping knowledge dense vector migration';
  END IF;
END;
$$;
