# Tasks
- [x] Task 1: 定义运行时执行契约与配置入口
  - [x] SubTask 1.1: 定义 limits/networkPolicy 的最小结构（timeoutMs/maxConcurrency/allowedDomains）
  - [x] SubTask 1.2: 定义 ExecutionResult 摘要字段（latencyMs/egressSummary）
  - [x] SubTask 1.3: 将 limits/networkPolicy 贯穿到 step.inputDigest 或 run.inputDigest（最小可追溯）

- [x] Task 2: 在 worker 落地 timeout 与并发限制
  - [x] SubTask 2.1: 实现每步 timeoutMs（超时分类为 timeout）
  - [x] SubTask 2.2: 实现 tenantId+toolRef 并发限制（队列/拒绝策略二选一）
  - [x] SubTask 2.3: 将限制快照写入 outputDigest 并写审计

- [x] Task 3: 落地出站网络治理（默认拒绝）
  - [x] SubTask 3.1: 设计并实现 HTTP 出站拦截点（仅统计/拒绝，不记录敏感 payload）
  - [x] SubTask 3.2: 实现 allowedDomains 白名单校验与拒绝路径（policy_violation）
  - [x] SubTask 3.3: 产出 egressSummary 并写入 outputDigest/审计

- [x] Task 4: 回归测试与文档补齐
  - [x] SubTask 4.1: 覆盖：timeout、并发限制、出站拒绝/允许
  - [x] SubTask 4.2: 覆盖：审计包含 runtime 摘要
  - [x] SubTask 4.3: 更新 README：如何为工具声明 limits/networkPolicy（MVP 形态）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2, Task 3
