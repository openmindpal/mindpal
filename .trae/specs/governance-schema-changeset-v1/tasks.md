# Tasks
- [x] Task 1: 扩展 changeset item kind 支持 schema 治理动作
  - [x] 增加 kind：schema.publish/schema.set_active/schema.rollback
  - [x] 增加 payload 校验与风险分级规则（riskLevel/requiredApprovals）
- [x] Task 2: 实现 schema changeset preflight 摘要
  - [x] 产出 schema 影响面摘要（compat、字段/实体增量、必填增量）
  - [x] 保证仅摘要输出，不泄露完整 schema 原文
- [x] Task 3: 实现 schema changeset release/apply 与 rollback
  - [x] release：publish 新版本并按 scope 设置 active（含 canary mode 的 space 覆盖）
  - [x] release：set_active/rollback 的 apply 逻辑与 rollbackData 记录
  - [x] rollback：恢复 active 指针到 release 前版本
- [x] Task 4: 收敛 /schemas/:name/publish 的对外语义（V1）
  - [x] 标记 deprecated 或改为仅内部使用（保留兼容但提示治理入口）
  - [x] 文档/错误信息指向治理 changeset 流程
- [x] Task 5: 测试与回归
  - [x] e2e：schema.publish changeset 完整链路（preflight→submit→approve→release→rollback）
  - [x] e2e：schema.set_active 与 schema.rollback changeset 链路
  - [x] e2e：预检摘要不包含 schema 原文（仅计数/摘要）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 5 depends on Task 3
