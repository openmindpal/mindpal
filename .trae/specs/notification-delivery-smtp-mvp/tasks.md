# Tasks

* [x] Task 1: SMTP connector type 与配置存储

  * [x] SubTask 1.1: 新增 connector\_types=mail.smtp（default egress policy）

  * [x] SubTask 1.2: 新增 smtp\_connector\_configs 表与 repo

  * [x] SubTask 1.3: 新增 API：GET/POST /connectors/instances/:id/smtp（校验 allowedDomains 与 Secret 归属）

* [x] Task 2: 扩展 notification\_outbox 支持投递状态机

  * [x] SubTask 2.1: 迁移扩展 notification\_outbox（deliveryStatus/attempt/nextAttemptAt/lastError/deadletter）

  * [x] SubTask 2.2: enqueue email 时渲染并加密存储 contentCiphertext（或 contentRef）

  * [x] SubTask 2.3: outboxRepo 支持 listByStatus/retry/cancel

* [x] Task 3: Notification Delivery Worker

  * [x] SubTask 3.1: 新增 worker ticker/processor（互斥领取、退避重试、死信）

  * [x] SubTask 3.2: mock smtp transport（MVP）

  * [x] SubTask 3.3: attempt/sent/deadletter 写审计摘要

* [x] Task 4: 治理接口与回归

  * [x] SubTask 4.1: 新增治理接口：outbox 列表查询、retry、cancel

  * [x] SubTask 4.2: e2e：创建模板→enqueue email→worker 投递成功→sent

  * [x] SubTask 4.3: e2e：失败→重试→deadletter→手动 retry

  * [x] SubTask 4.4: README：补齐 SMTP connector 与 outbox delivery 运维说明

# Task Dependencies

* Task 2 depends on Task 1

* Task 3 depends on Task 2

* Task 4 depends on Task 3

