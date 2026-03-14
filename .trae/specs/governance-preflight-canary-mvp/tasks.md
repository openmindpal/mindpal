# Tasks
- [x] Task 1: 扩展 Changeset 数据模型以支持 preflight/canary
  - [x] SubTask 1.1: 为 changesets 增加 canaryTargets 与 canaryReleasedAt 等字段
  - [x] SubTask 1.2: 新增 tool_active_overrides（space 级 active 指针）
  - [x] SubTask 1.3: 添加索引并保证迁移可重复执行

- [x] Task 2: 实现 Changeset Preflight API
  - [x] SubTask 2.1: 计算 plan/currentStateDigest/rollbackPreview/warnings
  - [x] SubTask 2.2: 输出 gate（riskLevel/requiredApprovals/approvalsCount）
  - [x] SubTask 2.3: preflight 写审计且不改状态

- [x] Task 3: 实现 Canary 发布与提升
  - [x] SubTask 3.1: release?mode=canary：仅对 canaryTargets 应用变更
  - [x] SubTask 3.2: promote：应用到全量 scope，并清理 canary 覆盖
  - [x] SubTask 3.3: canary/promote 写审计并可回滚

- [x] Task 4: 修改 tools 查询返回 effective active
  - [x] SubTask 4.1: /tools 与 /tools/:name 返回 effectiveActiveToolRef
  - [x] SubTask 4.2: 不改变现有 activeToolRef 字段兼容性（必要时新增字段）

- [x] Task 5: 回归测试与文档补齐
  - [x] SubTask 5.1: e2e：preflight 只读且返回摘要
  - [x] SubTask 5.2: e2e：canary→promote→rollback 闭环与空间隔离
  - [x] SubTask 5.3: README 增加 preflight/canary/promote 说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 1
- Task 5 depends on Task 2, Task 3, Task 4
