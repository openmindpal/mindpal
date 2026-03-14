# Tasks
- [x] Task 1: 定义并落库 Approval Binding 字段与一致性策略
  - [x] SubTask 1.1: 明确绑定字段来源（toolRef/policySnapshotRef/inputDigest）与存储位置
  - [x] SubTask 1.2: 如需迁移，新增 approvals 绑定字段与必要索引

- [x] Task 2: 实现 Replay Resolve API（/replay/resolve）
  - [x] SubTask 2.1: 接入统一请求链路：鉴权/授权/审计（workflow:replay_resolve）
  - [x] SubTask 2.2: 按三元组查询 steps/runs 并返回 matches（限制 N、按时间排序）
  - [x] SubTask 2.3: 错误规范化：not_found、多匹配、参数非法

- [x] Task 3: 强化审批通过流程的绑定一致性校验
  - [x] SubTask 3.1: approve 前加载 approval + run + step 并校验绑定一致
  - [x] SubTask 3.2: 不一致返回 409（APPROVAL_BINDING_MISMATCH）并写审计 `approval:binding_mismatch`
  - [x] SubTask 3.3: 一致才允许入队执行（保持现有行为不变）

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: API e2e：replay resolve 无/单/多匹配
  - [x] SubTask 4.2: API e2e：approval binding mismatch 返回 409 且不入队
  - [x] SubTask 4.3: 回归：/runs/:runId/replay 仍为只读，不触发外部副作用

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2, Task 3
