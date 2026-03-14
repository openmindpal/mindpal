# Tasks
- [x] Task 1: 新增协作消息 Envelope 存储与查询接口
  - [x] SubTask 1.1: 新增 migrations：collab_envelopes 表与索引（by run / by role / by correlationId）
  - [x] SubTask 1.2: 实现 repo：append/listByRun（分页/过滤）与稳定 digest 生成
  - [x] SubTask 1.3: API：`POST /tasks/:taskId/collab-runs/:id/envelopes`、`GET /tasks/:taskId/collab-runs/:id/envelopes`
  - [x] SubTask 1.4: 审计对齐：写入/查询 envelope 记录摘要，不记录敏感明文

- [x] Task 2: 引入单写主/仲裁提交机制（Arbiter）
  - [x] SubTask 2.1: 定义 Arbiter 提交端点：`POST /tasks/:taskId/collab-runs/:id/arbiter/commit`
  - [x] SubTask 2.2: 在服务端 enforcement：非 Arbiter 提交返回 `COLLAB_SINGLE_WRITER_VIOLATION`
  - [x] SubTask 2.3: 事件语义扩展：写入 `collab.arbiter.decision` 与 violation 事件
  - [x] SubTask 2.4: 回归：现有 collab run/events 查询兼容不破坏

- [x] Task 3: 角色级指标与治理查询补齐
  - [x] SubTask 3.1: metrics 增加 actorRole 标签维度（steps_total/duration/blocked/approval）
  - [x] SubTask 3.2: 新增治理诊断接口：按 collabRunId 输出 role 维度摘要（不含敏感明文）
  - [x] SubTask 3.3: e2e：多角色发 envelope→arbiter commit→指标与诊断可读

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
