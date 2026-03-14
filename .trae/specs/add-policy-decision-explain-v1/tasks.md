# Tasks
- [x] Task 1: 定义 explain 输出契约与错误规范
  - [x] SubTask 1.1: 增加 ExplainView 类型（如 shared/types）
  - [x] SubTask 1.2: 明确越权/不存在的返回策略（403/404）与错误码

- [x] Task 2: 实现治理端 explain API
  - [x] SubTask 2.1: policySnapshotRepo 增加按 snapshotId 查询（含 tenant/space 校验所需字段）
  - [x] SubTask 2.2: 新增 `GET /governance/policy/snapshots/:snapshotId/explain`
  - [x] SubTask 2.3: 接入治理权限校验与 scope 校验

- [x] Task 3: 审计与脱敏
  - [x] SubTask 3.1: 写入审计 policy_snapshot.explain（success/denied/not_found）
  - [x] SubTask 3.2: 确保输出不包含敏感明文（仅结构化摘要）

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: e2e：有权限可获取 explain
  - [x] SubTask 4.2: e2e：无权限/跨 tenant/space 被拒绝且不泄露存在性
  - [x] SubTask 4.3: 回归：不影响现有授权/审计/执行链路

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
