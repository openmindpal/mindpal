# 订阅与长连接运行器（Subscription Runner）MVP Spec

## Why
《架构设计.md》3.1.1 将“订阅与长连接运行器（长轮询/WebSocket/Streaming）”列为接入底座的典型能力：需要统一断线重连、水位推进、背压与容量治理，并把事件投递纳入统一请求链路与审计。当前平台已具备 Webhook Ingress Gateway（入站事件统一 envelope）与 Workflow/Job 执行底座，但缺少“主动拉取型订阅”的最小闭环，导致无法支持 IM/邮箱/长轮询类系统的增量接入。

## What Changes
- 新增 Subscription 一等对象（MVP）：
  - 表达“从某外部来源增量拉取事件”的订阅配置与水位状态
- 新增 Subscription Poller（MVP）：
  - Worker 侧按 interval 执行拉取，产出标准化 Ingress Envelope 并写入 ingress_events（或等价）
- 新增 API（MVP）：
  - 创建/启用/停用/查询订阅
  - 查询订阅水位与最近一次运行摘要
- 审计与隔离（MVP）：
  - 所有订阅变更与拉取运行均写审计（仅摘要）
  - tenant/space 隔离，默认拒绝跨空间访问

## Impact
- Affected specs:
  - 渠道接入（主动拉取型入口）
  - Workflow/Automation（定时/重试/幂等）
  - 审计域（订阅变更与运行可追溯）
  - 连接器与密钥托管（通过 connectorInstance 使用凭证，禁止明文）
- Affected code:
  - DB：新增 subscriptions 与 subscription_runs（或等价）迁移与索引
  - Worker：新增 poller processor（基于现有队列/作业模型）
  - API：新增 /subscriptions 路由与 repo

## ADDED Requirements

### Requirement: Subscription 对象（MVP）
系统 SHALL 提供 Subscription 对象以表达“主动拉取型订阅”：
- 最小字段（MVP）：
  - subscriptionId
  - tenantId、spaceId（可空）
  - provider（例如 imap、slack、generic.longpoll，MVP 允许先用 mock）
  - connectorInstanceId（可选，但建议必填以便受控使用凭证）
  - status：enabled|disabled
  - pollIntervalSec（最小 10s，最大 1h）
  - watermark（JSON，存储增量水位/游标摘要）
  - createdAt、updatedAt、lastRunAt

#### Scenario: 创建订阅
- **WHEN** 管理者创建 Subscription
- **THEN** 返回 subscriptionId 且 status=enabled（默认）
- **AND** 写审计（resourceType=subscription, action=create）

### Requirement: Subscription Poller（MVP）
系统 SHALL 在 Worker 中按订阅配置执行拉取：
- 每次拉取 MUST 记录 run 摘要（成功/失败/拒绝原因）
- 每次拉取 MUST 以 watermark 进行增量推进，并将新 watermark 持久化
- 每条拉取到的事件 MUST 规范化为 Ingress Envelope（复用 Webhook ingress 的 envelope 结构子集），写入 ingress_events（或等价）并具备幂等键

#### Scenario: 拉取产生入站事件
- **GIVEN** subscription enabled 且 watermark 存在
- **WHEN** poller 执行一次拉取
- **THEN** 新事件写入 ingress_events（幂等去重）
- **AND** watermark 被推进并持久化
- **AND** 写审计（resourceType=subscription, action=poll）

### Requirement: Subscription API（MVP）
系统 SHALL 提供订阅管理 API：
- `POST /subscriptions`
- `GET /subscriptions`（分页/limit）
- `GET /subscriptions/:subscriptionId`
- `POST /subscriptions/:subscriptionId/disable`
- `POST /subscriptions/:subscriptionId/enable`

约束（MVP）：
- 访问必须遵守 tenant/space 隔离
- 变更必须写审计（仅摘要）

### Requirement: Backpressure/容量（MVP）
系统 SHALL 具备最小的容量护栏：
- 单个 subscription 同一时刻最多 1 个 poll run（避免并发水位冲突）
- poller SHOULD 对连续失败进行退避（MVP：指数退避或固定延迟）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

