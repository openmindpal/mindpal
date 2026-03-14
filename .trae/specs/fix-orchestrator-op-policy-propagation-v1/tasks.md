# Tasks
- [x] Task 1: 修复 orchestrator.execute 的操作级策略传播
  - [x] SubTask 1.1: 使用 opDecision.snapshotRef 写入 step/run 的 policySnapshotRef
  - [x] SubTask 1.2: toolContract 注入 opDecision.fieldRules/rowFilters
  - [x] SubTask 1.3: approval.requested 审计使用 opDecision

- [x] Task 2: 测试与回归
  - [x] SubTask 2.1: e2e：断言 step.input.toolContract 包含 fieldRules/rowFilters
  - [x] SubTask 2.2: 回归：API/worker 测试通过

# Task Dependencies
- Task 2 depends on Task 1
