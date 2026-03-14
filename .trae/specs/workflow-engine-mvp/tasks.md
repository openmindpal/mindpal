# Tasks
- [x] Task 1: 设计并落地 Run/Step 数据模型
  - [x] SubTask 1.1: 新增 workflow_runs（状态机、幂等键、摘要字段）
  - [x] SubTask 1.2: 新增 workflow_steps（toolRef 锁定、attempt、错误分类）
  - [x] SubTask 1.3: 增加必要索引（按 space/status/traceId 查询）

- [x] Task 2: 实现 Run/Step API
  - [x] SubTask 2.1: 创建 Run（幂等）并入队
  - [x] SubTask 2.2: 查询 Run 列表/详情与 Step 列表
  - [x] SubTask 2.3: 按 traceId/runId 检索审计关联

- [x] Task 3: 实现队列执行与重试（MVP）
  - [x] SubTask 3.1: worker 拉取 step 并执行，回写状态
  - [x] SubTask 3.2: retryable 分类触发重试与退避
  - [x] SubTask 3.3: 全链路审计（含 attempt）

- [x] Task 4: 实现 cancel 语义（MVP）
  - [x] SubTask 4.1: cancel API（拒绝已 finished）
  - [x] SubTask 4.2: worker 侧停止后续 steps（或进入 canceled_pending）
  - [x] SubTask 4.3: cancel 审计与状态一致性

- [x] Task 5: 回归测试与文档补齐
  - [x] SubTask 5.1: e2e：创建 run 幂等
  - [x] SubTask 5.2: e2e：retryable 失败会重试并可追溯 attempt
  - [x] SubTask 5.3: e2e：cancel 停止后续 step
  - [x] SubTask 5.4: README 增加 Run/Step 与 cancel 的使用方式

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 2, Task 3, Task 4
