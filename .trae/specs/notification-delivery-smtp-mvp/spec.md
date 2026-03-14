# 通知投递：SMTP 邮件发送与 Outbox Worker（MVP）Spec

## Why
《架构设计.md》3.1.1 提到“通用协议连接器（IMAP/SMTP/Exchange）”应平台化以降低接入成本并提升一致性。当前平台已具备通知模板（多语言版本化）与 notification_outbox（仅落库，不发送），但缺少“可靠投递”的最小闭环：无法把 outbox 里的意图真正发送到邮件渠道，也无法提供重试、堆积与可运营的死信兜底。

## What Changes
- 新增 SMTP Connector Type（MVP）：
  - 通过 ConnectorInstance + SecretRecord 托管 SMTP 凭证与出站白名单（allowedDomains）
- 扩展 NotificationOutbox 以支持投递（MVP）：
  - 增加 delivery 元数据（attempt/backoff/lastError）与 senderRef/connectorInstanceId
  - outbox 存储“待发送内容”的加密负载或内容摘要引用（避免明文进入审计日志）
- 新增 Notification Delivery Worker（MVP）：
  - 扫描 queued outbox，按 backoff 重试
  - 成功标记 sent；超过阈值进入 deadletter
- 新增投递治理接口（MVP）：
  - 查询 queued/failed/deadletter 堆积
  - 手动 retry / cancel
- 审计对齐（MVP）：
  - enqueue / attempt / sent / deadletter / retry / cancel 均写审计摘要

## Impact
- Affected specs:
  - Notification Templates V1（outbox 从“仅落库”升级到“可投递”）
  - Integration Gateway（SMTP 协议连接器）
  - Execution Plane（队列化、重试与死信）
  - Safety/DLP（邮件正文不得写入审计，且需按风险策略治理）
- Affected code:
  - DB：新增 smtp_connector_configs；扩展 notification_outbox
  - API：扩展 /notifications/outbox 与 /governance/notifications/*
  - Worker：新增 notification delivery ticker/processor

## ADDED Requirements

### Requirement: SMTP Connector Type（MVP）
系统 SHALL 提供 SMTP connector type 并允许创建 connector instance：
- 连接参数（MVP，存储于 smtp_connector_configs）：
  - host、port、useTls
  - username
  - passwordSecretId（SecretRecord 引用）
  - fromAddress（默认发件人）
- 约束（MVP）：
  - password MUST 只存 SecretRecord（禁止明文落库或写入审计输出）
  - connectorInstance egressPolicy.allowedDomains MUST 包含 smtp host

#### Scenario: 配置 SMTP connector
- **WHEN** 管理者为某 SMTP connector instance 写入 smtp config
- **THEN** 校验 allowedDomains 与 Secret 归属后保存配置
- **AND** 写审计（resourceType=connector, action=smtp.configure）

### Requirement: Outbox 可投递元数据（MVP）
系统 SHALL 扩展 outbox 以支持可靠投递：
- outbox 字段扩展（MVP）：
  - connectorInstanceId（用于选择 SMTP 发送器）
  - deliveryStatus：queued|processing|sent|failed|deadletter|canceled
  - attemptCount、nextAttemptAt、lastErrorCategory、lastErrorDigest、deadletteredAt
  - contentCiphertext（jsonb，加密存储渲染后的 title/body；或 contentRef 引用 artifact）

#### Scenario: enqueue 时准备投递内容
- **WHEN** 调用 enqueue outbox 且 channel=email
- **THEN** 选定已发布模板版本并按 locale 渲染
- **AND** 将渲染结果加密写入 outbox（不写入审计明文）

### Requirement: Notification Delivery Worker（MVP）
系统 SHALL 在 worker 中投递 queued 的邮件 outbox：
- 行为（MVP）：
  - 互斥领取（同一 outboxId 同时最多 1 个 worker 处理）
  - attemptCount+1，并按 backoffMsBase 指数退避计算 nextAttemptAt
  - 成功：deliveryStatus=sent
  - 失败：deliveryStatus=failed，并记录 lastErrorDigest（仅摘要）
  - 超过 maxAttempts：deliveryStatus=deadletter + deadletteredAt
- MVP 允许先实现 “mock smtp transport”（不真正出站），仅验证状态机与审计链路

### Requirement: 治理接口（MVP）
系统 SHALL 提供治理接口以运营 outbox：
- `GET /governance/notifications/outbox?status=queued|failed|deadletter&limit=...`
- `POST /governance/notifications/outbox/:outboxId/retry`
- `POST /governance/notifications/outbox/:outboxId/cancel`

约束（MVP）：
- 仅具备治理权限的主体可访问
- retry 不回退 attemptCount，仅将 deliveryStatus 置为 queued 并清空 nextAttemptAt
- 所有治理动作写审计摘要（不含邮件正文）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

