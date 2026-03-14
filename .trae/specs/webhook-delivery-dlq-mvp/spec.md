# Webhook 队列化投递与死信（Webhook Delivery & DLQ）MVP Spec

## Why
《架构设计.md》3.1.1 对 Webhook 接入网关提出了“限流与队列化投递、失败重试与死信”的平台化诉求。当前系统已具备 Webhook Ingress（验签/去重/审计/同步回执）与 Worker/Queue 执行底座，但缺少异步投递与 DLQ 能力：当下游处理（orchestrator/workflow）抖动或外部系统重试时，平台无法提供稳定的堆积可观测、重试策略一致性与死信兜底。

## What Changes
- 扩展 IngressEvent 状态机（MVP）：
  - 增加 attempt/nextAttemptAt/lastErrorDigest，并引入 deadletter 终态
- 新增 Webhook Delivery Worker（MVP）：
  - 将 ingress event 的处理从“入口同步执行”升级为“入口可选异步入队 → worker 拉起执行”
- 新增 DLQ 可运营接口（MVP）：
  - 列表查询失败/死信事件，支持手动重试（requeue）
- 限流与背压（MVP）：
  - 入口侧可按 provider/workspace 限流并对堆积进行保护性拒绝（最小策略）
- 审计对齐（MVP）：
  - ingress.received / delivery.enqueued / delivery.attempt / delivery.succeeded / delivery.deadletter 均写审计摘要

## Impact
- Affected specs:
  - 渠道接入（Webhook）
  - Workflow/Automation（队列/重试/死信）
  - 审计域（投递链路可追溯）
  - 治理控制面（DLQ 运营）
- Affected code:
  - DB：扩展 channel_ingress_events（或新增 deadletter 表）
  - API：扩展 /channels/webhook/ingress 回执策略；新增 /governance/channels/ingress-events（或等价）查询与重试接口
  - Worker：新增 delivery processor（从队列消费并驱动 orchestrator/workflow）

## ADDED Requirements

### Requirement: IngressEvent 状态机扩展（MVP）
系统 SHALL 扩展 `channel_ingress_events` 支持投递状态与重试元数据：
- 新增/明确字段（MVP）：
  - status：received | queued | processing | succeeded | failed | deadletter
  - attemptCount（int，默认 0）
  - nextAttemptAt（timestamptz，可空）
  - lastErrorCategory（可空）
  - lastErrorDigest（jsonb，可空；仅摘要）
  - deadletteredAt（timestamptz，可空）
- 状态机约束（MVP）：
  - received/queued/processing 可重试
  - succeeded/deadletter 为终态（不自动重试）

#### Scenario: 失败重试达到阈值进入死信
- **GIVEN** 某 ingress event 连续失败
- **WHEN** attemptCount 超过最大重试次数
- **THEN** status 置为 deadletter 且记录 deadletteredAt
- **AND** 写审计（resourceType=channel, action=webhook.deadletter）

### Requirement: 入口可选异步投递（MVP）
系统 SHALL 支持 ingress 入口按配置选择同步或异步：
- WebhookConfig（MVP 扩展字段）：
  - deliveryMode：sync | async（默认 sync，保持现有行为）
  - maxAttempts（默认 8）
  - backoffMsBase（默认 500ms，指数退避）
- 行为（MVP）：
  - sync：保持当前“入口内调用 orchestrator”并 finalize ingress event
  - async：入口仅完成验签/去重/落库并入队，返回 status=processing（或 received）回执

#### Scenario: 异步模式回执
- **WHEN** deliveryMode=async 的 webhook ingress 到达
- **THEN** 写入 ingress event（status=queued）
- **AND** 入队一个 delivery job（幂等）
- **AND** 立即返回 processing 回执

### Requirement: Delivery Worker（MVP）
系统 SHALL 在 Worker 中消费 delivery job 并处理 ingress event：
- 处理步骤（MVP）：
  1) 读取 ingress event（tenant/provider/workspace/eventId）
  2) 置为 processing 并 attemptCount+1
  3) 调用 orchestrator/workflow（与现有同步模式一致的业务逻辑）
  4) 成功则 status=succeeded 并写回响应摘要
  5) 失败则计算 nextAttemptAt 并回写 lastErrorDigest
- 幂等（MVP）：
  - 同一 ingress event 在任一时刻最多一个 worker 执行（避免并发重复）

#### Scenario: 异步投递成功
- **WHEN** worker 处理某 ingress event 且下游成功
- **THEN** status=succeeded 并可通过查询接口看到结果摘要
- **AND** 写审计（resourceType=channel, action=webhook.delivered）

### Requirement: DLQ 查询与手动重试（MVP）
系统 SHALL 提供 DLQ 可运营接口：
- `GET /governance/channels/ingress-events?status=failed|deadletter&limit=...`
- `POST /governance/channels/ingress-events/:id/retry`

约束（MVP）：
- 仅具备治理权限的主体可访问
- 手动重试会将 status 置为 queued 并重新入队（attemptCount 不回退）
- 审计记录包含 operatorSubjectId 与 event 摘要

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

