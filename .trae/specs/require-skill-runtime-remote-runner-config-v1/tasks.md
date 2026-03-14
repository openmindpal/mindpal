# Tasks
- [x] Task 1: 明确并固化 remote runner 配置优先级与拒绝语义
  - [x] SubTask 1.1: Worker：force remote 且无 runner 时返回 policy_violation:remote_runtime_not_configured
  - [x] SubTask 1.2: Worker：补齐审计/step 错误分类与稳定摘要（policy_violation）

- [x] Task 2: 测试与回归
  - [x] SubTask 2.1: Worker 单测：SKILL_RUNTIME_BACKEND=remote 且无 runner 时拒绝且不回退
  - [x] SubTask 2.2: Worker 单测：设置 SKILL_RUNTIME_REMOTE_ENDPOINT 时不依赖 runner registry

# Task Dependencies
- Task 2 depends on Task 1
