-- 025: Session Task Queue & Task Dependencies & Checkpoints
-- Consolidated from: 026, 027(checkpoint_data), 030(task_queue_partition)
-- Multi-task concurrent execution queue with dependency management
--
-- OS 级进程管理模型：
-- - session_task_queue: 会话级任务队列（类比 OS 的进程就绪队列）
-- - task_dependencies: 任务间依赖关系（类比进程间依赖 / IPC）
-- - task_checkpoints: 检查点持久化（类比进程检查点/快照）
-- - 支持 FIFO / 优先级 / 依赖感知 / SJF 等调度策略
-- - 无硬编码并发上限，由运行时动态决定
--
-- 分区策略：PARTITION BY HASH(tenant_id)，16 个分区
-- 设计决策：
--   - 选择 tenant_id 而非 session_id 做分区键：
--     ① 基数适中（几十到几百），HASH(16) 分布均匀
--     ② 所有核心查询均以 tenant_id 开头，分区裁剪效率最高
--     ③ 避免 session_id 高基数导致的分区管理复杂度
--   - PRIMARY KEY 变为 (entry_id, tenant_id)：
--     PostgreSQL 分区表要求分区键包含在 PK 中
--     entry_id 为 UUID（全局唯一），不影响唯一性语义
--   - FK 处理：task_dependencies 和 task_checkpoints 不使用外键引用
--     分区表的 PK 为复合键，PostgreSQL 不支持跨分区的单列 FK 引用
--     entry_id 为 UUID（全局唯一），数据一致性由应用层保证

-- ── session_task_queue（HASH 分区主表）────────────────────────
-- 会话级任务队列：每个会话维护独立的任务执行队列
CREATE TABLE IF NOT EXISTS session_task_queue (
  entry_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  space_id     TEXT NULL,
  session_id   TEXT NOT NULL,                          -- conversationId / sessionId
  task_id      UUID NULL,                              -- 关联的 task（answer 模式为 NULL）
  run_id       UUID NULL,                              -- 关联的 run（answer 模式为 NULL）
  job_id       UUID NULL,                              -- 关联的 job（execute 模式）

  -- 队列元数据
  goal         TEXT NOT NULL,                          -- 用户原始请求/目标
  mode         TEXT NOT NULL DEFAULT 'answer',         -- answer / execute / collab
  priority     INT NOT NULL DEFAULT 50,                -- 0=最高 100=最低，动态可调
  position     INT NOT NULL DEFAULT 0,                 -- 队列内排序位置（支持手动 reorder）

  -- 状态机
  status       TEXT NOT NULL DEFAULT 'queued',
  -- queued: 已入队等待调度
  -- ready: 依赖已就绪，可执行
  -- executing: 正在执行
  -- paused: 被用户/系统暂停
  -- completed: 执行完成
  -- failed: 执行失败
  -- cancelled: 已取消
  -- preempted: 被高优先级任务抢占（暂停）

  -- 前台/后台标记
  foreground   BOOLEAN NOT NULL DEFAULT true,          -- 前台任务获得更高事件推送优先级

  -- 调度信息
  enqueued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at         TIMESTAMPTZ NULL,                   -- 依赖就绪时间
  started_at       TIMESTAMPTZ NULL,                   -- 开始执行时间
  completed_at     TIMESTAMPTZ NULL,                   -- 执行完成时间
  estimated_duration_ms  INT NULL,                     -- LLM 估算的执行时长

  -- 错误恢复
  retry_count      INT NOT NULL DEFAULT 0,
  last_error       TEXT NULL,
  checkpoint_ref   TEXT NULL,                          -- checkpoint 引用（用于恢复）

  -- 元数据
  created_by_subject_id TEXT NOT NULL,
  metadata         JSONB NULL,                         -- 扩展元数据（工具建议、约束等）

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 分区表要求：分区键必须包含在 PK 中
  PRIMARY KEY (entry_id, tenant_id)
) PARTITION BY HASH (tenant_id);

-- ── 创建 16 个 HASH 分区（幂等：检查首分区是否存在）─────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'session_task_queue_p0') THEN
    CREATE TABLE session_task_queue_p0  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 0);
    CREATE TABLE session_task_queue_p1  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 1);
    CREATE TABLE session_task_queue_p2  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 2);
    CREATE TABLE session_task_queue_p3  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 3);
    CREATE TABLE session_task_queue_p4  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 4);
    CREATE TABLE session_task_queue_p5  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 5);
    CREATE TABLE session_task_queue_p6  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 6);
    CREATE TABLE session_task_queue_p7  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 7);
    CREATE TABLE session_task_queue_p8  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 8);
    CREATE TABLE session_task_queue_p9  PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 9);
    CREATE TABLE session_task_queue_p10 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 10);
    CREATE TABLE session_task_queue_p11 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 11);
    CREATE TABLE session_task_queue_p12 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 12);
    CREATE TABLE session_task_queue_p13 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 13);
    CREATE TABLE session_task_queue_p14 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 14);
    CREATE TABLE session_task_queue_p15 PARTITION OF session_task_queue FOR VALUES WITH (MODULUS 16, REMAINDER 15);
  END IF;
END $$;

-- ── 索引（自动在每个分区上创建）──────────────────────────────

-- 按会话+状态查询（最常用：获取某会话的活跃队列）
CREATE INDEX IF NOT EXISTS stq_session_status_pos_idx
  ON session_task_queue (tenant_id, session_id, status, position);

-- 按会话+入队时间查询（FIFO 调度）
CREATE INDEX IF NOT EXISTS stq_session_enqueued_idx
  ON session_task_queue (tenant_id, session_id, enqueued_at);

-- 按优先级查询（优先级调度）
CREATE INDEX IF NOT EXISTS stq_session_priority_idx
  ON session_task_queue (tenant_id, session_id, priority, enqueued_at)
  WHERE status IN ('queued', 'ready');

-- 按 task_id 反查队列条目
CREATE INDEX IF NOT EXISTS stq_task_id_idx
  ON session_task_queue (task_id)
  WHERE task_id IS NOT NULL;

-- 按 run_id 反查
CREATE INDEX IF NOT EXISTS stq_run_id_idx
  ON session_task_queue (run_id)
  WHERE run_id IS NOT NULL;

-- 按租户+状态统计（调度器全局视图）
CREATE INDEX IF NOT EXISTS stq_tenant_status_idx
  ON session_task_queue (tenant_id, status);

-- entry_id 唯一索引：用于不携带 tenant_id 的单条查询
-- 注意：分区表上的 UNIQUE INDEX 必须包含分区键
CREATE UNIQUE INDEX stq_entry_id_tenant_idx
  ON session_task_queue (entry_id, tenant_id);

-- ── task_dependencies ────────────────────────────────────────
-- 任务间依赖关系：DAG 结构，支持三种依赖类型
-- 注意：不使用 FK 引用 session_task_queue（分区表限制），应用层保证一致性
CREATE TABLE IF NOT EXISTS task_dependencies (
  dep_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  session_id   TEXT NOT NULL,

  -- 依赖方向：from_entry_id 依赖于 to_entry_id
  -- 即 to_entry_id 必须先完成/产出，from_entry_id 才能执行
  from_entry_id UUID NOT NULL,
  to_entry_id   UUID NOT NULL,

  -- 依赖类型
  dep_type     TEXT NOT NULL DEFAULT 'finish_to_start',
  -- finish_to_start: to 完成后 from 才能开始
  -- output_to_input: to 的输出注入 from 的输入上下文
  -- cancel_cascade: to 被取消时 from 也级联取消

  -- 依赖状态
  status       TEXT NOT NULL DEFAULT 'pending',
  -- pending: 等待满足
  -- resolved: 已满足
  -- blocked: 上游失败/取消导致永久阻塞
  -- overridden: 被用户手动覆盖/移除

  -- output 映射（output_to_input 类型使用）
  output_mapping JSONB NULL,
  -- 结构: { "sourceField": "targetField", ... }
  -- 表示将上游任务输出的哪些字段映射到下游任务的输入

  -- 依赖来源
  source       TEXT NOT NULL DEFAULT 'auto',
  -- auto: LLM 自动推断
  -- manual: 用户手动创建
  -- system: 系统规则生成

  resolved_at  TIMESTAMPTZ NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 防止重复依赖
  CONSTRAINT task_dep_unique UNIQUE (from_entry_id, to_entry_id),
  -- 防止自依赖
  CONSTRAINT task_dep_no_self CHECK (from_entry_id <> to_entry_id)
);

-- 按 from_entry_id 查找依赖（"我依赖谁"）
CREATE INDEX IF NOT EXISTS td_from_entry_idx
  ON task_dependencies (from_entry_id, status);

-- 按 to_entry_id 查找被依赖（"谁依赖我"）
CREATE INDEX IF NOT EXISTS td_to_entry_idx
  ON task_dependencies (to_entry_id, status);

-- 按会话查看全部依赖关系（DAG 可视化）
CREATE INDEX IF NOT EXISTS td_session_idx
  ON task_dependencies (tenant_id, session_id);

-- ── task_checkpoints ─────────────────────────────────────────
-- 检查点持久化存储：用于宕机后从检查点恢复 executing 状态的任务
-- 注意：不使用 FK 引用 session_task_queue（分区表限制），应用层保证一致性
CREATE TABLE IF NOT EXISTS task_checkpoints (
  entry_id         UUID PRIMARY KEY,
  checkpoint_data  JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_updated
  ON task_checkpoints(updated_at);

-- ── 触发器：自动更新 updated_at ─────────────────────────────
CREATE OR REPLACE FUNCTION update_stq_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_stq_updated_at
  BEFORE UPDATE ON session_task_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_stq_updated_at();

CREATE OR REPLACE TRIGGER trg_td_updated_at
  BEFORE UPDATE ON task_dependencies
  FOR EACH ROW
  EXECUTE FUNCTION update_stq_updated_at();

CREATE OR REPLACE TRIGGER trg_task_checkpoints_updated_at
  BEFORE UPDATE ON task_checkpoints
  FOR EACH ROW
  EXECUTE FUNCTION update_stq_updated_at();

-- ── 注释 ─────────────────────────────────────────────────────
COMMENT ON TABLE session_task_queue IS '会话级任务队列（HASH 分区 × 16，按 tenant_id）— 每个会话维护独立的多任务执行队列，支持并发执行、优先级调度、前后台切换';
COMMENT ON COLUMN session_task_queue.priority IS '优先级权重 0-100，0 为最高优先级，支持 LLM 动态推断和运行时调整，无硬编码上限';
COMMENT ON COLUMN session_task_queue.foreground IS '前台任务获得更高的 SSE 事件推送频率和 UI 焦点';
COMMENT ON COLUMN session_task_queue.status IS '队列状态机：queued → ready → executing → completed/failed/cancelled，支持 paused/preempted 中间态';

COMMENT ON TABLE task_dependencies IS '任务间依赖关系 DAG — 支持 finish_to_start、output_to_input、cancel_cascade 三种依赖类型';
COMMENT ON COLUMN task_dependencies.dep_type IS '依赖类型：finish_to_start(完成后执行)/output_to_input(输出注入输入)/cancel_cascade(级联取消)';
COMMENT ON COLUMN task_dependencies.output_mapping IS '输出映射 JSON — 定义上游输出字段到下游输入字段的映射关系';
COMMENT ON COLUMN task_dependencies.source IS '依赖来源：auto(LLM推断)/manual(用户手动)/system(系统规则)';

COMMENT ON TABLE task_checkpoints IS '任务检查点持久化存储 — 记录任务执行的中间状态，用于宕机恢复';
COMMENT ON COLUMN task_checkpoints.checkpoint_data IS '检查点数据 JSON — 包含当前步骤、中间结果、执行上下文等';
