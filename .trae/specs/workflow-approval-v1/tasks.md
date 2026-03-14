# Tasks
- [x] Task 1: 审批数据模型与存储
  - [x] SubTask 1.1: 新增 migrations：approvals、approval_decisions 表与索引
  - [x] SubTask 1.2: 实现 approvalRepo（create/get/listPending/addDecision）

- [x] Task 2: 审批 API 与鉴权
  - [x] SubTask 2.1: `GET /approvals?status=pending`（按 tenant/space 隔离）
  - [x] SubTask 2.2: `GET /approvals/:approvalId`（返回 run/steps 摘要）
  - [x] SubTask 2.3: `POST /approvals/:approvalId/decisions`（approve/reject）

- [x] Task 3: 审批与执行联动
  - [x] SubTask 3.1: approve 推进 run/step 状态并入队执行
  - [x] SubTask 3.2: reject 终止 run 并阻止后续 step 执行
  - [x] SubTask 3.3: 确保复用 inputDigest、policySnapshotRef、idempotencyKey（不可被覆盖）

- [x] Task 4: 审计与回归
  - [x] SubTask 4.1: 审计：approval.requested / approval.decided / run.enqueued（摘要）
  - [x] SubTask 4.2: e2e：需要审批的 run 创建→approve→入队 queued
  - [x] SubTask 4.3: e2e：reject 后 run 不执行且审计可追溯
  - [x] SubTask 4.4: README：审批 API 示例与权限要求

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
