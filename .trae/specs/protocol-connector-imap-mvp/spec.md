# 通用协议连接器：IMAP 增量拉取（MVP）Spec

## Why
《架构设计.md》3.1.1 指出，当大量系统重复依赖“协议级接入能力”（IMAP/SMTP/Exchange）时，平台化可显著降低接入成本并提升安全一致性。邮件系统是典型代表：即使没有标准 Webhook/OAuth，仍可通过 IMAP 增量拉取实现消息入站，并将结果纳入统一审计、DLP 与幂等治理。

## What Changes
- 新增 IMAP 连接器类型（MVP）：
  - 通过现有 ConnectorInstance + Secret 托管凭证与连接参数
- 将 IMAP 拉取接入 Subscription Runner（MVP）：
  - provider=imap 的 subscription 由 worker poller 执行
  - 使用 watermark（UID/时间窗）推进增量
- 入站事件规范化（MVP）：
  - 拉取到的邮件被规范化为 Channel Ingress Event（复用 `channel_ingress_events`）并具备幂等键
  - 邮件正文/附件不直接进入审计日志，仅存摘要与证据引用（后续可扩展到 Knowledge/Artifacts）
- 可观测与可运营（MVP）：
  - subscription_runs 记录每次拉取摘要（成功/失败/事件数/水位）
  - 审计记录包含 provider、mailbox、watermark 摘要与拒绝原因

## Impact
- Affected specs:
  - Integration Gateway（通用协议连接器）
  - Subscription Runner（provider 扩展点）
  - Safety/DLP（邮件内容与附件的摘要化与出站控制）
  - Audit（拉取与入站写入审计）
- Affected code:
  - API：Connector Types/Instances 配置扩展（新增 imap type）
  - Worker：subscription poller 增加 imap provider
  - DB：复用 subscriptions/subscription_runs/channel_ingress_events；必要时新增 mailbox 元数据表（可选）

## ADDED Requirements

### Requirement: IMAP Connector Type（MVP）
系统 SHALL 提供 IMAP connector type，并允许创建 connector instance：
- 连接参数（MVP）：
  - host、port、tls（bool）
  - username（string）
  - passwordSecretId（SecretRecord 引用）
  - mailbox（例如 INBOX）
  - fetchWindow（可选：只拉取最近 N 天）

约束（MVP）：
- 密码/令牌 MUST 只存 SecretRecord，不允许明文落库或写入审计输出
- ConnectorInstance 的出站域名 MUST 受 egressPolicy.allowedDomains 约束（至少包含 IMAP host）

#### Scenario: 创建 IMAP connector instance
- **WHEN** 管理者创建 IMAP connector instance 并绑定 secret
- **THEN** instance 可用于创建 subscription
- **AND** 写审计（resourceType=connector_instance, action=create）

### Requirement: IMAP Subscription（MVP）
系统 SHALL 支持通过 Subscription Runner 拉取 IMAP 邮件：
- Subscription.provider = "imap"
- Subscription.connectorInstanceId 指向 IMAP instance
- Subscription.watermark（MVP）：
  - `{ uidNext?: number, lastInternalDate?: string }`

#### Scenario: 创建 IMAP subscription
- **WHEN** 管理者基于 IMAP connector instance 创建 subscription
- **THEN** subscription status=enabled 且 watermark 初始化为 null 或起始水位
- **AND** 写审计（resourceType=subscription, action=create）

### Requirement: 增量拉取与幂等（MVP）
系统 SHALL 在 worker 中按 interval 增量拉取邮件并写入入站事件：
- 每条邮件 MUST 生成稳定幂等键：
  - eventId = `imap:<connectorInstanceId>:<mailbox>:<uid>`
  - workspaceId = `imap:<connectorInstanceId>:<mailbox>`
  - provider = "imap"
- 写入 `channel_ingress_events` 需利用唯一约束去重（重复拉取不得产生重复事件）
- 拉取成功后 MUST 推进 watermark 并写入 subscription_runs.watermark_after

#### Scenario: 拉取产生入站事件
- **GIVEN** subscription enabled 且 imap 可连接
- **WHEN** poller 拉取到新邮件
- **THEN** 每封邮件写入 channel_ingress_events（received），并推进 watermark
- **AND** subscription_runs 记录 eventCount 与 watermarkAfter
- **AND** 写审计（resourceType=subscription, action=poll，输出仅摘要）

### Requirement: 内容摘要与证据引用（MVP）
系统 SHALL 对邮件内容进行摘要化处理：
- 入站事件中可保存必要的结构化字段（MVP）：
  - from/to/subject/internalDate/messageId 的摘要
  - bodyDigest（hash）与附件元信息摘要（文件名/大小/hash）
- 不得在审计 outputDigest 中记录邮件全文或附件内容
- 后续可扩展将正文/附件落入 Artifacts/Knowledge，并以 evidenceRefs 引用（MVP 仅预留字段）

### Requirement: 失败处理与退避（MVP）
系统 SHALL 对 IMAP 拉取失败进行最小处理：
- 失败 MUST 写入 subscription_runs（status=failed + errorCategory 摘要）
- SHOULD 进行退避（复用 Subscription Runner 的退避策略）
- 不得因为单次失败破坏 watermark（一致性优先）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

