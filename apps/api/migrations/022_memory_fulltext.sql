-- 022: 记忆全文搜索支持（tsvector + GIN 索引）

-- 添加全文搜索向量列
ALTER TABLE memory_entries 
ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 创建 GIN 索引（仅未删除记录）
CREATE INDEX IF NOT EXISTS idx_memory_entries_search_vector
ON memory_entries USING GIN(search_vector)
WHERE deleted_at IS NULL;

-- 初始化现有数据的 search_vector（合并 title 和 content_text）
UPDATE memory_entries 
SET search_vector = to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content_text, ''))
WHERE search_vector IS NULL;

-- 创建触发器函数：自动更新 search_vector
CREATE OR REPLACE FUNCTION memory_entries_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple', coalesce(NEW.title, '') || ' ' || coalesce(NEW.content_text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 创建触发器
DROP TRIGGER IF EXISTS trg_memory_entries_search_vector ON memory_entries;
CREATE TRIGGER trg_memory_entries_search_vector
BEFORE INSERT OR UPDATE OF title, content_text ON memory_entries
FOR EACH ROW EXECUTE FUNCTION memory_entries_search_vector_update();
