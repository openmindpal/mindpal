# Tasks

- [x] Task 1: 明确 Policy Contract V1 数据模型与 API 边界
  - [x] SubTask 1.1: 定义 policyRef/policyVersion 状态机与迁移策略
  - [x] SubTask 1.2: 明确 policy snapshot 关联字段与 explain v1 输出字段

- [x] Task 2: 扩展 ABAC 上下文与表达式白名单
  - [x] SubTask 2.1: 定义可引用的 context 字段白名单与类型规则
  - [x] SubTask 2.2: 在授权评估与数据面 rowFilters 编译阶段注入 context
  - [x] SubTask 2.3: 不支持表达式统一转 deny + reason=unsupported_policy_expr

- [x] Task 3: 实现策略编译缓存与 epoch 绑定
  - [x] SubTask 3.1: 设计 cache key（tenant/space/policyRef/epoch）与存储（DB/Redis，按现有依赖选择）
  - [x] SubTask 3.2: 在 RBAC/Policy 写链路与治理 invalidate 中 bump epoch 并验证命中行为

- [x] Task 4: 固化 Stable Policy Explain Contract V1
  - [x] SubTask 4.1: 定义 reasons/matchedRules 摘要字段与脱敏规则
  - [x] SubTask 4.2: 调试 evaluate 与 policy snapshot explain 统一输出结构

- [x] Task 5: 统一治理 Contract Compatibility Gate（至少覆盖 Policy/Workflow）
  - [x] SubTask 5.1: preflight 输出增加 contractCheck 摘要（pass/fail/warn + 错误码）
  - [x] SubTask 5.2: release 在 fail 时拒绝并写审计（CONTRACT_NOT_COMPATIBLE）
  - [x] SubTask 5.3: 为 policy/workflow 实现兼容检查器（字段白名单、操作符、版本状态）

- [x] Task 6: 回归测试与文档更新
  - [x] SubTask 6.1: 单测：context 白名单与表达式校验/拒绝原因稳定
  - [x] SubTask 6.2: e2e：policy 发布 gate（不兼容→preflight fail/release deny；兼容→发布成功）
  - [x] SubTask 6.3: e2e：epoch 失效后新策略生效且 explain 返回新 epoch

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2
- Task 5 depends on Task 1, Task 2, Task 4
- Task 6 depends on Task 3, Task 4, Task 5
