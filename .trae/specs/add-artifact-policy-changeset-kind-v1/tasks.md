# Tasks
- [x] Task 1: 后端新增 changeset kind：artifact_policy.upsert
  - [x] SubTask 1.1: 扩展 kind 白名单与 validateItem
  - [x] SubTask 1.2: 扩展 preflight：currentStateDigest/plan/rollbackPreview
  - [x] SubTask 1.3: 扩展 release：upsert 生效 + 记录 rollback_data
  - [x] SubTask 1.4: 扩展 rollback：restore 或 delete

- [x] Task 2: 前端支持在变更集详情页添加该条目
  - [x] SubTask 2.1: 增加 kind 选项与表单字段
  - [x] SubTask 2.2: addItem payload 组装与错误展示保持一致

- [x] Task 3: 测试与回归
  - [x] SubTask 3.1: e2e：changeset 发布后策略生效，rollback 后恢复
  - [x] SubTask 3.2: 回归：api/worker/web 测试通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
