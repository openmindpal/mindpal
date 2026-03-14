# Tasks
- [x] Task 1: changeset 预检与门禁验收对齐
  - [x] SubTask 1.1: 复核 governance.ts preflight 输出 gates 列表（含 eval admission）
  - [x] SubTask 1.2: 复核 release 强制执行 gate，未通过返回稳定错误码并写审计摘要
  - [x] SubTask 1.3: 补齐/更新 API e2e 覆盖 preflight gates 与 gate 拒绝/放行

- [x] Task 2: 灰度/回滚验收对齐
  - [x] SubTask 2.1: 复核 canary→promote→rollback 端到端联通（含 effective 验证）
  - [x] SubTask 2.2: 复核每步审计摘要可观测（不含敏感 payload）
  - [x] SubTask 2.3: 补齐/更新 e2e 覆盖 canary/promote/rollback 闭环

- [x] Task 3: 评测 runner（EvalRun）执行与报告链路验收对齐
  - [x] SubTask 3.1: 复核 changeset 绑定 eval_suites 后可触发 eval_runs
  - [x] SubTask 3.2: 复核报告摘要产出与阈值判定 pass/fail（不泄露敏感原文）
  - [x] SubTask 3.3: 复核 release gate 读取 eval 结果并据此拒绝/放行
  - [x] SubTask 3.4: 补齐/更新 e2e 覆盖：未通过评测拒绝发布，通过后放行（含 canary）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
