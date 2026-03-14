# Tasks
- [x] Task 1: 通知模板数据模型与存储
  - [x] SubTask 1.1: 新增 migrations：notification_templates/notification_template_versions 表与索引
  - [x] SubTask 1.2: 实现 templateRepo（create/get/list/setStatus）
  - [x] SubTask 1.3: 实现 templateVersionRepo（createDraft/publish/getReleased/getByVersion）

- [x] Task 2: 渲染预览 API
  - [x] SubTask 2.1: `POST /notifications/templates` 创建模板
  - [x] SubTask 2.2: `POST /notifications/templates/:id/versions` 创建 draft 版本
  - [x] SubTask 2.3: `POST /notifications/templates/:id/versions/:ver/publish` 发布版本
  - [x] SubTask 2.4: `POST /notifications/templates/:id/preview` 按 locale 渲染预览

- [x] Task 3: Outbox（仅落库）
  - [x] SubTask 3.1: 新增 migrations：notification_outbox 表与索引
  - [x] SubTask 3.2: 实现 outboxRepo（enqueue/list/cancel）
  - [x] SubTask 3.3: 新增 API：`POST /notifications/outbox`、`GET /notifications/outbox`、`POST /notifications/outbox/:id/cancel`

- [x] Task 4: 审计、隔离与回归
  - [x] SubTask 4.1: 模板 create/publish/disable、preview、outbox enqueue/cancel 写审计摘要
  - [x] SubTask 4.2: tenant/space 隔离校验（不可跨空间访问）
  - [x] SubTask 4.3: e2e：创建模板→创建版本→发布→预览（locale 回退）→写入 outbox→取消
  - [x] SubTask 4.4: README：补齐通知模板与 outbox 端点

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2 and Task 3
