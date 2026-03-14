# Tasks
- [x] Task 1: 落地 Sync 变更日志与水位数据模型
  - [x] SubTask 1.1: 新增 sync_ops（按 tenant/space 的 append-only ops）
  - [x] SubTask 1.2: 新增 sync_watermarks（按 client/device 记录 serverWatermark/cursor）
  - [x] SubTask 1.3: 增加 opId 幂等唯一约束与必要索引

- [x] Task 2: 实现 sync.pull / sync.push API（同步模式）
  - [x] SubTask 2.1: pull：按 cursor 增量返回 ops 与 nextCursor
  - [x] SubTask 2.2: push：批量接收 ops，opId 幂等去重
  - [x] SubTask 2.3: push 输出 deterministic digest（按 opId 序列）

- [x] Task 3: 冲突检测与返回（MVP）
  - [x] SubTask 3.1: 基于 baseVersion 与服务端当前版本做并发检测
  - [x] SubTask 3.2: rejected/conflicts[] 输出结构化原因与修复提示

- [x] Task 4: 审计对齐与权限护栏
  - [x] SubTask 4.1: push/pull 写审计（输入/输出摘要、digest）
  - [x] SubTask 4.2: push/pull 接入统一授权与字段裁剪一致性

- [x] Task 5: 回归测试与文档补齐
  - [x] SubTask 5.1: e2e：push 幂等去重与 digest 稳定
  - [x] SubTask 5.2: e2e：pull 增量 cursor 正确
  - [x] SubTask 5.3: e2e：baseVersion 冲突返回 conflicts
  - [x] SubTask 5.4: README 增加 Sync 接口说明与示例

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2
- Task 5 depends on Task 2, Task 3, Task 4
