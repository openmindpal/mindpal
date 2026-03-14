# Tasks
- [x] Task 1: 新增 DLQ 运维 API 与 repo
  - [x] SubTask 1.1: siemRepo：listDlq/clearDlq/requeueDlq
  - [x] SubTask 1.2: audit routes：GET dlq + POST clear + POST requeue
  - [x] SubTask 1.3: 写入审计（siem.dlq.read/clear/requeue）

- [x] Task 2: RBAC permissions 与 seed
  - [x] SubTask 2.1: seed 写入 audit/siem.dlq.{read,write}
  - [x] SubTask 2.2: seed 为 admin 角色绑定上述 permissions

- [x] Task 3: 控制台 UI 与 i18n / WEB_E2E
  - [x] SubTask 3.1: /gov/audit SIEM 区块增加 DLQ 列表与操作按钮
  - [x] SubTask 3.2: i18n 补齐 zh-CN/en-US 文案
  - [x] SubTask 3.3: WEB_E2E smoke 断言包含 DLQ 入口

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: api e2e：DLQ list/clear/requeue 基础链路
  - [x] SubTask 4.2: 回归：api/worker/web 测试通过

# Task Dependencies
- Task 3 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 1
