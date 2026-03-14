# 多智能体协作协议化与治理增强（架构-18）Spec

## Why
当前多智能体协作已具备 Collab Run、事件流与审计骨架，但协作仍更像“多角色跑同一条执行链路”：缺少跨代理消息的统一封装与投递语义、共享状态的单写主/仲裁机制、以及按角色维度的指标与治理入口，导致可移植性、可观测性与可治理性不足。

## What Changes
- 引入“协作消息封装（Envelope）”与投递协议：角色间消息具备统一结构（routing/correlation/digest）、可分页查询、可审计且不泄露敏感明文。
- 引入“单写主/仲裁（Arbiter）”模型：共享状态（taskState、collab status、最终输出摘要）只能由 Arbiter 提交；其他角色以提案/建议形式通过 Envelope 交付。
- 引入“角色级指标与治理”：按 actorRole 输出成功率/耗时/blocked/needs_approval 等指标；提供治理侧查询与诊断摘要，支持按 role 维度定位瓶颈与异常。
- 保持既有 Collab Run/Events/Plan V2 兼容：新增字段/新端点为非破坏性扩展。

## Impact
- Affected specs:
  - multi-agent-collab-mvp（Tasks/Messages 继续复用，新增协作消息封装）
  - multi-agent-roles-ops-v1（Collab Run/Events/Plan V2 扩展：单写主与角色指标）
  - add-api-metrics-v1（新增角色级指标维度）
  - add-audit-outbox-v1 / audit 体系（Envelope 摘要审计）
- Affected code:
  - API：collab run/events 路由、tasks/messages 路由、metrics/governance 查询
  - Orchestrator/Worker：角色间消息投递、仲裁提交、事件写入与状态机推进
  - DB：新增 collab 消息表（或扩展现有表），以及必要索引

## ADDED Requirements

### Requirement: 协作消息封装（Envelope）
系统 SHALL 为 Collab Run 提供跨角色协作消息的统一封装格式，并支持可靠投递与可追溯查询。

#### Envelope 最小结构（V1）
Envelope SHALL 至少包含以下字段：
- `envelopeId`（uuid）
- `collabRunId`
- `fromRole`、`toRole`（或 `broadcast=true`）
- `kind`：`proposal | question | answer | observation | command`（最小集合）
- `correlationId`（可选）：用于串联一次协作往返（例如提案→仲裁决定）
- `payloadDigest`：对 payload 的稳定摘要（不得包含敏感明文）
- `payloadRedacted`：可选的脱敏/摘要化 payload（可被 UI 展示）
- `createdAt`

#### Scenario: 角色间发送提案
- **GIVEN** collabRun 存在且包含至少两个角色
- **WHEN** 角色 A 向 Arbiter 发送 `kind=proposal` 的 Envelope
- **THEN** 系统为该 Envelope 分配 `envelopeId` 并持久化
- **AND** 事件流记录 `collab.envelope.sent`（包含 fromRole/toRole/kind/digest 摘要）
- **AND** 审计记录包含 `collabRunId/envelopeId/fromRole/toRole/kind` 与摘要，不包含敏感明文

#### Scenario: 查询 Envelope 时间线
- **WHEN** 用户按 collabRunId 查询 Envelope 列表（分页/过滤）
- **THEN** 返回 Envelope 元数据与 `payloadRedacted`（如存在）
- **AND** 返回结果不包含任何敏感明文

### Requirement: 单写主/仲裁（Arbiter）
系统 SHALL 引入 Arbiter 角色作为共享状态的唯一写入者。

#### 单写主约束（V1）
以下写入被定义为“共享状态写入”，系统 SHALL 仅允许 Arbiter 执行：
- 更新 collabRun 状态（例如 `executing → needs_approval/succeeded/failed`）
- 写入/更新 taskState 中的最终 plan 决议与推进位点
- 提交“最终输出摘要”（用于 UI/审计/诊断）

#### Scenario: 非 Arbiter 尝试提交共享状态写入（被拒绝）
- **WHEN** 非 Arbiter 角色尝试调用“提交决议/推进状态”的动作
- **THEN** 系统拒绝并返回稳定错误码 `COLLAB_SINGLE_WRITER_VIOLATION`
- **AND** 事件流记录 `collab.single_writer.violation`（含 role 与拒绝原因摘要）

#### Scenario: Arbiter 基于提案做决议并推进
- **GIVEN** Arbiter 收到一个或多个 proposal Envelope
- **WHEN** Arbiter 生成决议并提交
- **THEN** 系统更新共享状态并写入 `collab.arbiter.decision` 事件（含 correlationId 与摘要）
- **AND** 生成一个回执 Envelope（`kind=answer/observation`）发送回提案发起方（可选）

### Requirement: 角色级指标与治理查询
系统 SHALL 提供按 actorRole 维度聚合的运行指标与诊断摘要，并可在治理侧查询。

#### Metrics（最小集合）
系统 SHALL 暴露以下指标并支持按 `actorRole` 维度切分（至少）：
- `collab_steps_total{actorRole,status}`
- `collab_step_duration_ms_bucket{actorRole}`
- `collab_blocked_total{actorRole,reason}`
- `collab_needs_approval_total{actorRole}`

#### Scenario: 治理侧按角色查看异常
- **WHEN** 管理员按 `collabRunId` 查询诊断摘要
- **THEN** 返回每个 role 的步骤数、失败率、blocked/approval 次数与最近错误摘要（不含敏感明文）

## MODIFIED Requirements

### Requirement: Collab Run 事件语义扩展（非破坏性）
系统 SHALL 在现有 collab_run_events 的基础上新增事件类型以覆盖 Envelope 与仲裁：
- `collab.envelope.sent | collab.envelope.received`
- `collab.arbiter.decision`
- `collab.single_writer.violation`

## REMOVED Requirements
无

