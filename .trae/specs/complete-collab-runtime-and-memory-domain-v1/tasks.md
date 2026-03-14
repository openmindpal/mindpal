# Tasks
- [x] Task 1: 补齐 Collab 数据库字段与索引
  - [x] SubTask 1.1: 更新 `079_collab_runs.sql` 为 events 增加 policySnapshotRef/correlationId 相关字段
  - [x] SubTask 1.2: 更新 `100_collab_envelopes.sql` 为 envelopes 增加 policySnapshotRef 并强化 correlation 约束
  - [x] SubTask 1.3: 增加必要索引以支持按 correlationId 回放查询

- [x] Task 2: 落地 Collab step 级租约与稳定错误语义
  - [x] SubTask 2.1: 在 `collabRuntime.ts` 的关键提交路径引入 step 级租约（resourceRef）
  - [x] SubTask 2.2: 非单主提交/租约冲突返回 `SINGLE_WRITER_VIOLATION` 并写入 `collab.single_writer.violation`
  - [x] SubTask 2.3: toolPolicy 拒绝保持写入 `collab.policy.denied` 且字段完整

- [x] Task 3: 强制 Collab envelopes/events 字段完整与可回放
  - [x] SubTask 3.1: 更新 `collabEnvelopeRepo.ts`/`collabEventRepo.ts` 以读写 policySnapshotRef/correlationId
  - [x] SubTask 3.2: envelopes 写入接口强制 `correlationId` 且自动记录 `policySnapshotRef`
  - [x] SubTask 3.3: governance diagnostics 输出包含可用于回放的关联字段（至少 correlationId/policySnapshotRef）

- [x] Task 4: 补齐 Memory session_context 与 writePolicy 扩展
  - [x] SubTask 4.1: 更新 `012_memory.sql`（如需）以确保 session_context 唯一键/索引与字段满足 API
  - [x] SubTask 4.2: 在 `memory.ts` 增加 session_context 读写/清除接口
  - [x] SubTask 4.3: 扩展 `memory.ts` 写入接口的 writePolicy 枚举并保持审计摘要一致

- [x] Task 5: 新增 Memory 导出+清除接口并审计化
  - [x] SubTask 5.1: 在 `repo.ts` 增加导出读取（默认脱敏）能力
  - [x] SubTask 5.2: 在 `memory.ts` 增加导出+清除接口（事务化/幂等策略按现有风格）
  - [x] SubTask 5.3: 确保 space/user 隔离与 task_state 覆盖更新/恢复读取符合验收

- [x] Task 6: 回归与验收（e2e）
  - [x] SubTask 6.1: 扩展 e2e collab runtime 覆盖：SINGLE_WRITER_VIOLATION、policy.denied、回放串联
  - [x] SubTask 6.2: 扩展 e2e memory 覆盖：session_context、writePolicy 扩展、导出+清除、task_state 覆盖更新
  - [x] SubTask 6.3: 运行 API 测试并修复回归

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 5 depends on Task 4
- Task 6 depends on Task 2, Task 3, Task 5
