# Tasks
- [x] Task 1: 落地 Collab Run 与事件流数据模型
  - [x] SubTask 1.1: 新增 migrations：collab_runs、collab_run_events 表与索引
  - [x] SubTask 1.2: 实现 collabRunRepo（create/get/list/updateStatus）
  - [x] SubTask 1.3: 实现 collabEventRepo（append/listByRun，支持分页与过滤）

- [x] Task 2: 扩展计划结构为 Plan V2（角色与依赖）
  - [x] SubTask 2.1: 扩展 taskState 持久化：保存 collabRunId/roles/steps.actorRole
  - [x] SubTask 2.2: 扩展 orchestrator 规划：生成 V2 plan（最小：planner→executor→reviewer）
  - [x] SubTask 2.3: 事件对齐：plan 生成写入 collab.plan.generated（仅摘要）

- [x] Task 3: 执行调度支持跨角色与并行依赖（最小实现）
  - [x] SubTask 3.1: workflow steps 元数据加入 actorRole/planStepId/collabRunId
  - [x] SubTask 3.2: 调度器按 dependsOn 推进步骤，支持无依赖步骤并行入队
  - [x] SubTask 3.3: 预算与 toolPolicy 检查点：超限/不允许则 blocked 并写事件

- [x] Task 4: API：Collab Run 管理与可观测查询
  - [x] SubTask 4.1: `POST /tasks/:taskId/collab-runs`、`GET /tasks/:taskId/collab-runs/:id`
  - [x] SubTask 4.2: `GET /tasks/:taskId/collab-runs/:id/events`（分页/过滤）
  - [x] SubTask 4.3: RBAC+审计：resourceType=agent_runtime（或新增 collab_runtime），action=create/read/events

- [x] Task 5: 指标与回归验证
  - [x] SubTask 5.1: metrics：新增 collab 维度 counters/histograms（success/fail/duration/approval/budget）
  - [x] SubTask 5.2: e2e：创建 collab run→生成 plan→执行至少 1 个 tool 步骤→事件流可查询
  - [x] SubTask 5.3: e2e：预算/策略拒绝时 blocked 事件可见且不泄露敏感明文

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 1
- Task 5 depends on Task 2, Task 3, Task 4
