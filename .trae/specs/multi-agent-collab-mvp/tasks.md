# Tasks
- [x] Task 1: Task/Message 数据模型与存储
  - [x] SubTask 1.1: 新增 migrations：tasks、agent_messages 表与索引
  - [x] SubTask 1.2: 实现 taskRepo（create/get/list/close、listRunsByTask）
  - [x] SubTask 1.3: 实现 agentMessageRepo（append/listByTask）

- [x] Task 2: Tasks API
  - [x] SubTask 2.1: `POST /tasks`（创建 task）
  - [x] SubTask 2.2: `GET /tasks`（列表/分页）
  - [x] SubTask 2.3: `GET /tasks/:taskId`（详情 + 关联 runs 摘要）
  - [x] SubTask 2.4: `POST /tasks/:taskId/messages`（写入 message，摘要校验）
  - [x] SubTask 2.5: `GET /tasks/:taskId/messages`（timeline 查询）

- [x] Task 3: 审计对齐与回归
  - [x] SubTask 3.1: tasks/messages 接口写审计，包含 taskId/role 摘要
  - [x] SubTask 3.2: e2e：创建 task→写入 message→可查询 timeline
  - [x] SubTask 3.3: e2e：tenant/space 隔离校验（不可跨租户/空间读写）
  - [x] SubTask 3.4: README：补齐 tasks/messages API 示例

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
