-- 027_pgvector.sql
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
