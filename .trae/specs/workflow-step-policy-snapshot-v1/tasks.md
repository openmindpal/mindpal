# Tasks
- [x] Task 1: 为 steps 表新增 policy_snapshot_ref 字段
  - [x] SubTask 1.1: 迁移新增 steps.policy_snapshot_ref
  - [x] SubTask 1.2: 保持兼容（历史 step 不回填）

- [x] Task 2: 创建与查询 step 时透传 policySnapshotRef
  - [x] SubTask 2.1: createJobRunStep 写入 steps.policy_snapshot_ref
  - [x] SubTask 2.2: listSteps/toStep 输出包含 policySnapshotRef
  - [x] SubTask 2.3: runs/steps API 返回结构包含 policySnapshotRef（如适用）

- [x] Task 3: 测试与回归
  - [x] SubTask 3.1: API e2e：创建 tool.execute step 后 DB 中 policy_snapshot_ref 存在
  - [x] SubTask 3.2: API e2e：steps 列表返回 policySnapshotRef
  - [x] SubTask 3.3: 回归：审批/回放/重执行/死信处置用例通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
