# 通用协议连接器：Exchange（Microsoft Graph）增量拉取（MVP）Spec

## Why
《架构设计.md》3.1.1 将 Exchange 与 IMAP/SMTP 并列为“通用协议连接器”应平台化的典型能力。相较于各团队在 Skill 里各自接入 Graph API，平台化可以统一凭证边界、出站策略、幂等去重、水位推进、失败重试与审计摘要，降低合规与运维风险。

## What Changes
- 新增 Exchange（Microsoft Graph）Connector Type（MVP）
  - 通过 ConnectorInstance + OAuth Grant（已托管）配置可访问的 mailbox
  - 强制 egressPolicy.allowedDomains 覆盖 `graph.microsoft.com`
- Subscription Runner 扩展 provider=exchange（MVP）
  - 以 watermark（deltaLink 或 lastSyncTime）实现增量拉取
  - 将拉取结果写入 `channel_ingress_events`，具备稳定幂等键
- 入站事件摘要化（MVP）
  - 仅保存邮件结构化摘要与 hash，不保存邮件全文/附件明文
  - 审计输出仅包含统计与水位摘要

## Impact
- Affected specs:
  - Integration Gateway：通用协议连接器（Exchange）
  - OAuth 回调托管：复用 oauth grants/token 刷新与审计
  - Subscription Runner：provider 扩展点 + watermark 推进
  - Channels Ingress：复用 channel_ingress_events 幂等与审计规范
- Affected code:
  - DB：新增 exchange_connector_configs（绑定 oauthGrant 与 mailbox）
  - API：新增 /connectors/instances/:id/exchange 配置接口（读写/校验）
  - Worker：subscription poller 增加 exchange provider 分支（MVP 可 mock 拉取）

## ADDED Requirements

### Requirement: Exchange Connector Type（MVP）
系统 SHALL 提供 Exchange（Microsoft Graph）connector type，并允许创建 connector instance 与配置：
- ConnectorType：
  - name = `mail.exchange`
  - provider = `exchange`
  - auth_method = `oauth`
  - default_egress_policy.allowedDomains 至少包含 `graph.microsoft.com`（也允许在 instance 里显式配置）
- ExchangeConfig（存储于 exchange_connector_configs）字段（MVP）：
  - connectorInstanceId
  - oauthGrantId（引用 oauth_grants.id）
  - mailbox（userPrincipalName 或 mailboxId）
  - fetchWindowDays（可选：只同步最近 N 天）

约束（MVP）：
- OAuth token/refresh token MUST 仅存于 SecretRecord（oauth_grants.secret_record_id 引用），不得明文出现在配置表与审计输出
- connectorInstance egressPolicy.allowedDomains MUST 覆盖 `graph.microsoft.com`
- connector instance 必须处于 enabled 状态方可写入配置与被订阅使用

#### Scenario: 配置 Exchange connector instance
- **WHEN** 管理者为 `mail.exchange` instance 提交 ExchangeConfig（oauthGrantId + mailbox）
- **THEN** 系统校验：
  - instance 存在且 enabled
  - oauthGrant 属于同 tenant/space scope
  - allowedDomains 覆盖 graph host
- **AND** 保存配置并写审计（仅摘要：host/mailbox，不包含 token）

### Requirement: Exchange Subscription（MVP）
系统 SHALL 支持 subscription provider=exchange：
- Subscription.provider = `exchange`
- Subscription.connectorInstanceId 指向 `mail.exchange` instance
- watermark（MVP）：
  - `{ deltaLink?: string, lastSyncTime?: string }`

#### Scenario: 创建 Exchange subscription
- **WHEN** 管理者创建 provider=exchange 的 subscription
- **THEN** 系统校验 connectorInstanceId 指向 `mail.exchange` 且 enabled 且已配置 ExchangeConfig
- **AND** watermark 初始化为 null 或起始水位
- **AND** 写审计摘要

### Requirement: 增量拉取与幂等（MVP）
系统 SHALL 在 worker 中按 interval 增量拉取邮件并写入入站事件：
- 每条邮件 MUST 生成稳定幂等键：
  - eventId = `exchange:<connectorInstanceId>:<mailbox>:<messageId>`
  - workspaceId = `exchange:<connectorInstanceId>:<mailbox>`
  - provider = `exchange`
- 写入 `channel_ingress_events` MUST 利用唯一约束去重（重复拉取不得产生重复事件）
- 拉取成功后 MUST 推进 watermark 并写入 subscription_runs.watermark_after

MVP 拉取方式：
- 允许先实现 mock poll（不真实请求 Graph），用于验证状态机、幂等与水位推进
- 后续可扩展为真实 Graph delta query + token refresh

### Requirement: 内容摘要与证据引用（MVP）
系统 SHALL 对邮件内容进行摘要化处理：
- 入站事件 body_json 仅保存必要的结构化摘要（MVP）：
  - mailbox、messageId、receivedDateTime、subjectDigest、fromDigest、toDigest
  - bodyDigest（hash）与附件元信息摘要（文件名/大小/hash，可选）
- 审计 outputDigest 不得记录邮件正文或附件内容

### Requirement: 失败处理与退避（MVP）
系统 SHALL 对 Exchange 拉取失败进行最小处理：
- 失败 MUST 写入 subscription_runs（status=failed + errorCategory 摘要）
- SHOULD 进行退避（复用 Subscription Runner 的退避策略）
- 不得因为单次失败回退 watermark

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

