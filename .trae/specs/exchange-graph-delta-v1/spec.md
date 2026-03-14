# Exchange（Microsoft Graph）真实增量拉取（Delta Query）V1 Spec

## Why
当前 `provider=exchange` 仅实现 mock 拉取，用于验证幂等、水位推进与审计对齐，但尚未形成可用的真实接入能力。按《架构设计.md》3.1.1“通用协议连接器”平台化目标，需要把 Microsoft Graph 的增量拉取、token 刷新、失败退避与内容摘要纳入统一链路与治理护栏。

## What Changes
- Exchange 拉取从 mock 升级为真实 Graph Delta Query（V1）
  - 按 mailbox + folder（默认 Inbox）增量拉取 message 摘要
  - watermark 从 `{seq,lastSyncTime}` 升级为 `{deltaLink?, nextLink?, lastSyncTime?}`（兼容旧水位）
- OAuth grant 使用规范化（V1）
  - 拉取前确保 access token 可用：必要时 refresh，并更新 oauth_grants 的 tokenExpiresAt/secretRecordId
  - 失败分类：auth（需重新授权）/policy（出站禁用）/retryable（临时错误）/rate_limited
- 入站事件摘要化增强（V1）
  - `channel_ingress_events.body_json` 保存结构化摘要：messageId/receivedDateTime/from/to/subjectDigest/bodyDigest/hasAttachments/attachmentsDigest
  - 不保存邮件正文、附件内容与任何 OAuth 明文
- 可观测与审计对齐（V1）
  - subscription poll 审计 outputDigest 记录：拉取数量、去重数量、水位摘要（hash/长度）、错误类别（不含敏感）
  - subscription_runs 记录 errorCategory 与 retry/backoff 行为
- **BREAKING（轻微）**：Exchange subscription 的 watermark 结构从 seq 模式迁移为 link 模式（提供向后兼容迁移策略）

## Impact
- Affected specs:
  - 通用协议连接器：Exchange（Graph）从框架验证升级为可用接入
  - OAuth 回调托管：grant refresh/失效处理与审计一致性
  - Subscription Runner：watermark 语义升级与失败退避策略
  - Safety/DLP：邮件字段脱敏与审计摘要规范
- Affected code:
  - worker：exchange poller（Graph client + delta 解析 + watermark）
  - api：可选增加 Exchange config 的 folder 字段与“连通性检查”接口（若需要）
  - db：可能扩展 exchange_connector_configs（folder，可选）

## ADDED Requirements

### Requirement: Graph Delta 拉取（V1）
系统 SHALL 对 `provider=exchange` 实现真实增量拉取：
- 默认拉取 folder = `Inbox`（V1 可硬编码；V1.1 可配置）
- 使用 Microsoft Graph delta query：
  - 初次：GET `/users/{mailbox}/mailFolders/inbox/messages/delta`
  - 后续：使用 deltaLink 或 nextLink 继续
- 拉取上限与分页：
  - 每次 poll 有最大消息数 `maxMessagesPerPoll`（默认 50）
  - 支持 nextLink 连续分页直到达到上限或拿到 deltaLink

#### Scenario: 成功增量拉取并推进水位
- **WHEN** subscription runner poll 一个已配置 Exchange connector 的 subscription
- **THEN** 系统拉取一批消息摘要并写入 `channel_ingress_events`
- **AND** 生成稳定幂等键：
  - `eventId = exchange:<connectorInstanceId>:<mailbox>:<messageId>`
  - `workspaceId = exchange:<connectorInstanceId>:<mailbox>`
  - `provider = exchange`
- **AND** watermarked 推进为新 deltaLink（或 nextLink）并写入 `subscriptions.watermark` 与 `subscription_runs.watermark_after`

### Requirement: OAuth Token 可用性与刷新（V1）
系统 SHALL 在执行 Graph 请求前保证 access token 可用：
- 若 grant.status != active：拒绝执行并将错误归类为 `auth_required`
- 若 token 即将过期（例如 < 2min）：调用 refresh（复用现有 oauth refresh 能力）
- refresh 成功后 MUST 更新：
  - oauth_grants.secret_record_id（指向新 token 的 SecretRecord）
  - oauth_grants.token_expires_at
  - oauth_grants.updated_at

#### Scenario: token 过期刷新后继续拉取
- **WHEN** poll 检测到 token 过期或即将过期
- **THEN** 系统刷新 token 并继续 delta 拉取
- **AND** 审计不记录 token 明文，仅记录 refresh 发生与结果类别

### Requirement: 失败分类与退避（V1）
系统 SHALL 对拉取失败进行结构化分类并遵循退避策略：
- `policy_violation`：egressPolicy 不允许访问 graph.microsoft.com
- `auth_required`：token 失效/refresh 失败/401/invalid_grant
- `rate_limited`：429（记录 retry-after 摘要并退避）
- `retryable`：网络超时、5xx、临时错误
- `fatal`：非预期错误（最少摘要）

行为：
- 失败 MUST 写入 subscription_runs（status=failed + errorCategory + errorDigest）
- MUST 不回退 watermark
- SHOULD 按类别退避：
  - rate_limited 优先尊重 retry-after
  - retryable 使用指数退避

### Requirement: 内容摘要化（V1）
系统 SHALL 仅保存必要的邮件结构化摘要：
- `body_json` 包含（V1）：
  - mailbox、messageId、receivedDateTime
  - fromDigest/toDigest/subjectDigest（长度 + hash 摘要）
  - bodyDigest（长度 + hash；正文不入库）
  - hasAttachments、attachmentsDigest（文件名/大小/hash 的摘要集合；不存内容）
- 审计 outputDigest 仅记录统计信息与水位摘要（deltaLink/nextLink 不得明文记录，可用 hash/长度）

## MODIFIED Requirements

### Requirement: Exchange subscription watermark（V1）
系统 SHALL 支持并迁移 Exchange watermark：
- 兼容旧格式：`{ seq, lastSyncTime }`（旧 mock 生成）
- 新格式：`{ deltaLink?, nextLink?, lastSyncTime? }`

**Migration**：
- 若检测到旧 watermark：首次真实 poll 走“初次 delta”并重置为 link watermark
- migration 行为写入审计摘要（不含链接明文）

## REMOVED Requirements
（无）

