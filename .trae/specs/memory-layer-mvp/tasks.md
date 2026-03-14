# Tasks
- [x] Task 1: 设计并落地记忆层数据模型与迁移
  - [x] SubTask 1.1: 定义 memory_entries/session_contexts/task_states/user_preferences 最小字段
  - [x] SubTask 1.2: 定义 scope/retention/writePolicy/sourceRef 与 tenant/space 约束
  - [x] SubTask 1.3: 添加迁移与索引并保证可重复执行

- [x] Task 2: 实现 Memory API（显式写入 + 只读检索 + 治理）
  - [x] SubTask 2.1: POST /memory/entries（writePolicy=confirmed，DLP 脱敏，写审计）
  - [x] SubTask 2.2: POST /memory/search（tenant/space 强制过滤，返回片段，写审计）
  - [x] SubTask 2.3: GET /memory/entries、DELETE /memory/entries/:id、POST /memory/clear（写审计）

- [x] Task 3: 接入编排层工具化入口（可选 MVP+）
  - [x] SubTask 3.1: 注册 memory.read@1/memory.write@1 toolRef（input/output schema）
  - [x] SubTask 3.2: worker 执行实现调用 Memory API/Repo 并写审计串联 run/step

- [x] Task 4: TaskState 最小能力落地（run 关联）
  - [x] SubTask 4.1: 写入/更新 task_states（阶段/计划/产物摘要）并 DLP 脱敏
  - [x] SubTask 4.2: 暴露查询入口用于恢复与复盘（最小 GET）
  - [x] SubTask 4.3: 状态变更写审计并关联 runId/stepId

- [x] Task 5: 回归测试与文档补齐
  - [x] SubTask 5.1: e2e：写入记忆→检索→删除/清除闭环
  - [x] SubTask 5.2: 覆盖：跨 space 不可召回；DLP 脱敏生效
  - [x] SubTask 5.3: README 增加 Memory API 与写入门槛说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 4 depends on Task 1
- Task 3 depends on Task 2
- Task 5 depends on Task 2, Task 4
