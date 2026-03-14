# Tasks
- [x] Task 1: 定义列表契约与权限语义
  - [x] SubTask 1.1: 定义 PolicySnapshotSummary 与 cursor 结构
  - [x] SubTask 1.2: 明确 scope=space 默认行为与无 spaceId 的错误码
  - [x] SubTask 1.3: 追加治理权限 action：governance.policy_snapshot.read（并在 seed/admin 权限覆盖）

- [x] Task 2: Repo 层实现 list/search
  - [x] SubTask 2.1: policySnapshotRepo 增加 listPolicySnapshots（where+cursor+limit）
  - [x] SubTask 2.2: 增加必要索引评估与迁移（如需要）

- [x] Task 3: API 路由实现与审计
  - [x] SubTask 3.1: 新增 `GET /governance/policy/snapshots`
  - [x] SubTask 3.2: 接入 requirePermission + 审计 inputDigest/outputDigest
  - [x] SubTask 3.3: 确保输出脱敏，不包含明文敏感数据

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: e2e：默认 space scope 仅返回当前 space 记录
  - [x] SubTask 4.2: e2e：tenant scope 返回多 space 且 cursor 生效
  - [x] SubTask 4.3: e2e：无权限/无 spaceId 的错误与审计行为
  - [x] SubTask 4.4: 回归：不影响现有 authorize/快照写入/治理 explain

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
