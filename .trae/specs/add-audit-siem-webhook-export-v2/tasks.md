# Tasks
- [x] Task 1: 新增 DB 表（destinations/cursors/outbox/dlq）
  - [x] SubTask 1.1: migration：audit_siem_destinations
  - [x] SubTask 1.2: migration：audit_siem_cursors + audit_siem_outbox + audit_siem_dlq

- [x] Task 2: 新增 SIEM destination API（CRUD/test/backfill）
  - [x] SubTask 2.1: GET/POST/PUT /audit/siem-destinations
  - [x] SubTask 2.2: POST /audit/siem-destinations/:id/test
  - [x] SubTask 2.3: POST /audit/siem-destinations/:id/backfill（重置/推进游标）
  - [x] SubTask 2.4: 权限与审计（siem.destination.*）

- [x] Task 3: Worker 增量投递与 outbox 处理
  - [x] SubTask 3.1: tick：按 cursor 拉取 audit_events 并写 outbox
  - [x] SubTask 3.2: processor：HTTP POST webhook + 退避重试 + DLQ
  - [x] SubTask 3.3: 成功推进 cursor + outbox 去重（eventId）

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: api：destination/test/backfill 单测或 e2e
  - [x] SubTask 4.2: worker：outbox 重试/DLQ 单测
  - [x] SubTask 4.3: 回归：api/worker/web 测试通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2
