# Tasks
- [x] Task 1: 增加 Policy Snapshot 存储（policy_snapshots）
  - [x] SubTask 1.1: 新增 migrations：policy_snapshots 表与索引
  - [x] SubTask 1.2: 实现 policySnapshotRepo（create/get）
  - [x] SubTask 1.3: authorize() 写入 snapshot，并将 snapshotRef 返回给上层

- [x] Task 2: RBAC 管理 API（Role/Permission/Binding）
  - [x] SubTask 2.1: 增加 Role API（create/list/get）
  - [x] SubTask 2.2: 增加 Permission API（register/list）
  - [x] SubTask 2.3: 增加 RolePermission API（grant/revoke）
  - [x] SubTask 2.4: 增加 RoleBinding API（bind/unbind，tenant/space scope）

- [x] Task 3: 审计对齐与安全约束
  - [x] SubTask 3.1: RBAC 变更写审计（resourceType=rbac）
  - [x] SubTask 3.2: 决策审计写入 snapshotRef 与摘要字段（deny 同样可追溯）

- [x] Task 4: 测试与文档
  - [x] SubTask 4.1: e2e：创建 role→授权→访问放行；解绑→拒绝
  - [x] SubTask 4.2: e2e：deny 也生成 policy snapshot
  - [x] SubTask 4.3: README：补齐 RBAC 管理 API 与示例

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
