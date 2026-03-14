# 审计 SIEM Webhook 增量投递 V2 Spec

## Why
《架构设计.md》要求审计具备可运营的对外集成能力；《架构-06-审计域》与《架构-16-治理控制面》要求审计可追溯、可验证且可外送到企业 SIEM/日志平台，形成合规与安全运营闭环。

当前系统已有：append-only 审计 + hashchain 校验、保留策略与“导出为 artifact 的离线文件”。但缺少“持续增量外送到外部 SIEM”的能力（如 webhook/syslog/S3），导致只能人工导出文件，无法满足实时告警/集中留存/跨系统联动。

V2 以最小可落地方式实现：**Webhook destination + 游标增量投递 + outbox 重试/DLQ**，敏感配置使用现有 Secrets 体系存储，不引入新的外部依赖。

## What Changes
- 新增审计外送目的地（Destination）与投递游标（Cursor）：
  - Destination 存 `secretId`（webhook URL/签名密钥等存入 secret_records.encrypted_payload）
  - Cursor 记录每个 destination 的消费进度（按 `timestamp + eventId`）
- 新增审计外送 API（V2）：
  - `GET/POST/PUT /audit/siem-destinations`
  - `POST /audit/siem-destinations/:id/test`
  - `POST /audit/siem-destinations/:id/backfill`（从当前或指定游标开始重放）
- 新增 worker 投递管道（V2）：
  - `tickAuditSiemExport`：按 destination 读取增量审计事件，写入 outbox
  - `processAuditSiemOutbox`：批量 HTTP POST webhook，失败重试，超过阈值进入 DLQ
- 投递格式（V2）：
  - `Content-Type: application/x-ndjson`
  - 每行一条结构化 audit event（包含 event_hash/prev_hash 以便外部校验链）

## Impact
- Affected specs:
  - 审计域（外送能力、可观测与可回放）
  - 治理控制面（目的地配置与变更审计）
  - 安全中枢（外送联动与合规留存基础）
- Affected code:
  - DB migrations：新增 audit_siem_* 表
  - API：`apps/api/src/routes/audit.ts`（新增 endpoints）
  - Worker：新增 tick 与 outbox processor

## ADDED Requirements

### Requirement: AuditSiemWebhookDestinationV2
系统 SHALL 支持配置 SIEM Webhook 目的地：
- 字段（V2 最小集合）：
  - `id`（uuid）
  - `tenantId`
  - `enabled`（默认 false）
  - `name`（可读名称）
  - `secretId`（引用 `secret_records.id`；payload 内含 webhookUrl 与可选签名配置）
  - `batchSize`（默认 200，最大 1000）
  - `timeoutMs`（默认 5000，最大 30000）
  - `createdAt/updatedAt`

安全约束（V2）：
- Webhook URL/签名密钥 MUST 存入 `secret_records.encrypted_payload`，API 返回不得包含明文
- Destination 的创建/更新/启停/测试 MUST 写审计（resourceType=audit，action=siem.destination.*）

### Requirement: AuditSiemCursorAndOutboxV2
系统 SHALL 以“游标 + outbox”实现增量投递：
- Cursor 维度：`(tenantId, destinationId)`
- Cursor 内容：`lastTimestamp` + `lastEventId`（用于稳定翻页）
- Outbox 内容：
  - `destinationId`
  - `eventId`（幂等键）
  - `payload`（ndjson 行或 batch）
  - `attempts/nextAttemptAt/lastErrorDigest`
- **WHEN** outbox 投递成功
- **THEN** 系统 MUST 推进 cursor
- **WHEN** outbox 投递失败
- **THEN** 系统 MUST 退避重试；超过最大尝试次数则进入 DLQ 并可查询

### Requirement: AuditSiemWebhookDeliveryV2
系统 SHALL 支持通过 HTTP POST 投递审计事件：
- **WHEN** destination enabled 且存在可投递事件
- **THEN** worker MUST 向 webhookUrl 发起 POST
- **AND** 请求 MUST 包含：
  - `Content-Type: application/x-ndjson`
  - `X-Audit-Tenant-Id`
  - `X-Audit-Delivery-Id`（uuid，用于对账）
- 幂等建议（V2）：
  - 每条 event 结构包含 `eventId`
  - outbox 以 `eventId` 去重，保证至少一次投递但可幂等消费

### Requirement: AuditSiemDestinationTestV2
- **WHEN** 调用 `POST /audit/siem-destinations/:id/test`
- **THEN** 系统 MUST 以最小样例事件（不含敏感信息）向目的地发起投递
- **AND** 返回投递结果摘要（httpStatus/traceId/errorCode）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

