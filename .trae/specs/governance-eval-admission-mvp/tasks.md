# Tasks
- [x] Task 1: 设计并落地评测数据模型
  - [x] SubTask 1.1: 新增 eval_suites（suite 元数据、cases、thresholds）
  - [x] SubTask 1.2: 新增 eval_runs（运行状态、summary、evidenceDigest）
  - [x] SubTask 1.3: 新增 changeset_eval_bindings（changeset ↔ suite 绑定）

- [x] Task 2: 实现评测 API（suite 与 run）
  - [x] SubTask 2.1: 创建/更新/读取 EvalSuite
  - [x] SubTask 2.2: 触发 EvalRun 并返回摘要
  - [x] SubTask 2.3: 查询 EvalRun 列表与详情（仅摘要）

- [x] Task 3: 把评测准入接入 changeset preflight/release
  - [x] SubTask 3.1: preflight 回显 requiredEvalSuites 与通过状态、warnings
  - [x] SubTask 3.2: release 强制校验评测通过（高风险）
  - [x] SubTask 3.3: 拒绝发布返回稳定错误码（EVAL_NOT_PASSED 或等价）

- [x] Task 4: 回归测试与文档补齐
  - [x] SubTask 4.1: e2e：未通过评测拒绝发布
  - [x] SubTask 4.2: e2e：通过评测后允许发布（full/canary）
  - [x] SubTask 4.3: README 增加评测准入接口与说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
