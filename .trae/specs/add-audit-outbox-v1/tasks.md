# Tasks
- [x] Task 1: 设计并落库 audit outbox 表结构
  - [x] 增加 migration：outbox 表、索引、状态字段与 nextAttemptAt
  - [x] 定义 outbox 事件负载的最小结构（复用现有审计事件字段）
- [x] Task 2: 实现 outbox 投递器（批量 + 重试 + 幂等）
  - [x] 批量 claim queued 记录并写入 audit_events
  - [x] 成功标记 succeeded；失败写 lastError 并退避 nextAttemptAt
  - [x] 幂等：重复投递不产生重复审计事件
- [x] Task 3: 改造 V1 写操作为“事务 + outbox 原子提交”
  - [x] 选定 V1 范围写接口（entities POST/PATCH）并接入事务 + outbox
  - [x] outbox 插入失败返回稳定错误码且不产生业务副作用
- [x] Task 4: 测试与可观测性
  - [x] 单测/集成：outbox 写失败回滚事务
  - [x] e2e：写接口成功后可在 audit_events 看到对应事件（经投递器）
  - [x] 指标：outbox backlog 与投递成功/失败计数

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2, Task 3
