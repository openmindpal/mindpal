# 触发体系 / Undo 补偿可视化 / 人机协作标准件 V1 Spec

## Why
平台已有 Workflow Run/Step 与治理审计，但“触发入口（定时/事件）”“补偿/撤销的可视化与受控触发”“人机协作的信息结构与 UI 标准件”仍不统一，导致自动化难以规模化治理、回滚/补偿不可运营、协作链路不可复用。

## What Changes
- 新增 Trigger 标准件（Cron + Event）：
  - TriggerDefinition 一等对象：统一表达触发来源、过滤条件、投递目标（workflow/job）、输入映射与幂等/去重策略
  - Worker 侧 Trigger Runner：Cron 计算下一次触发；Event 订阅事件源并按规则投递
  - Governance 标准件：预检、权限、配额、审计与可解释“为什么触发/为什么未触发”
- 增强 Undo/补偿可视化标准件：
  - 在“执行中心 Run/Step UI”中可视化 step 是否可补偿、补偿历史与当前状态
  - 提供受控触发入口（可选审批门槛）与统一错误码/审计摘要
- 新增人机协作标准件：
  - 统一“协作事件（人/agent）消息结构”与 UI 组件：时间线、证据引用、决策摘要、交接（handoff）与回放关联
  - 将“人工确认/补充上下文/批准/拒绝”纳入标准件并写审计

## Impact
- Affected specs:
  - 订阅与长连接运行器（Subscription Runner）MVP：事件触发的来源可复用 ingress envelope
  - 执行中心（Run/Step）与任务进度 UI：新增 Undo/补偿可视化与入口
  - Workflow Step Compensation（撤销/补偿）：补充可视化与治理入口标准化
  - 多智能体协作（Task/角色/通信与权限上下文）：补充人机协作 UI 标准件
- Affected code:
  - DB：trigger_definitions、trigger_runs（或等价）；compensation_requests（或等价）用于可视化历史
  - Worker：cron runner / event trigger runner / dispatch 到 workflow queue
  - API：/triggers 管理与预检、/governance/compensations（或等价）
  - Web：Triggers 管理页组件、Execution Center 增强、Task/Message 协作时间线增强

## ADDED Requirements

### Requirement: TriggerDefinitionV1
系统 SHALL 提供 TriggerDefinition 一等对象以统一表达 Cron 与 Event 触发规则：
- 最小字段（V1）：
  - triggerId、tenantId、spaceId（可空）
  - type：cron|event
  - status：enabled|disabled
  - target：{ kind: workflow|job, ref: string }
  - inputMapping：JSON（将事件/时间上下文映射为 target.input；仅允许安全模板/白名单映射）
  - idempotency：{ keyTemplate: string, windowSec: number }（用于去重）
  - createdBySubjectId、createdAt、updatedAt、lastRunAt

#### Scenario: 创建 TriggerDefinition
- **WHEN** 管理者创建 TriggerDefinition
- **THEN** 返回 triggerId 且 status=enabled（默认）
- **AND** 写审计（resourceType=trigger, action=create）

### Requirement: CronTriggerV1
系统 SHALL 支持 Cron 触发类型：
- Cron 表达：cronExpr（V1 仅支持 5 段或 6 段，明确时区 tz）
- 运行护栏：
  - 单 trigger 同一时刻最多 1 个 run（避免并发重复触发）
  - misfirePolicy：skip|catchup（V1 默认 skip）

#### Scenario: Cron 到点触发并投递
- **GIVEN** cron trigger enabled
- **WHEN** 到达下一次触发时间
- **THEN** 系统创建 trigger_run（queued→running→succeeded/failed）
- **AND** 投递一个 workflow/job（带 idempotency key）
- **AND** 写审计（resourceType=trigger, action=fire, outputDigest 含 triggerRunId 与 targetRef）

### Requirement: EventTriggerV1
系统 SHALL 支持事件触发类型（V1 最小闭环）：
- 事件源（V1）：
  - ingress.envelope（来自 webhook/subscription runner 的标准 envelope）
  - governance.events（例如 changeset approved/released 的事件摘要）
- 过滤（V1）：
  - source、eventType、spaceId（可选）、简化 payload 路径匹配（只读白名单字段）

#### Scenario: 命中事件触发规则
- **GIVEN** event trigger enabled
- **WHEN** 新事件进入事件源
- **THEN** 系统按过滤匹配触发并投递 target
- **AND** 去重策略生效（重复事件不重复投递）
- **AND** trigger_run 记录可解释摘要（matched=true/false、reason）

### Requirement: TriggerGovernanceStandardKitV1
系统 SHALL 提供触发治理标准件：
- 权限（建议）：
  - trigger.read、trigger.manage、trigger.fire（手动触发/回放）
- 预检：
  - Cron：展示 nextFireAt、最近 N 次运行摘要
  - Event：展示过滤条件摘要与最近 N 次匹配/未匹配原因摘要
- 配额（V1 最小）：
  - 每 tenant enabled triggers 上限
  - 每 trigger 每分钟触发上限（速率限制）
- 审计：
  - create/update/enable/disable/fire 均必须写审计
  - 不得在审计中写入敏感 payload 原文，仅摘要/引用

#### Scenario: 治理侧预检可解释
- **WHEN** 管理者调用 trigger preflight
- **THEN** 返回可解释摘要（nextFireAt 或 lastMatchReasons）与配额/护栏提示

### Requirement: UndoCompensationVisualizationKitV1
系统 SHALL 在 Execution Center 中可视化 Undo/补偿能力：
- Run 详情页的 Step 列表 SHALL 显示：
  - compensable: true/false（是否存在 undoToken 且允许补偿）
  - compensationStatus：none|queued|running|succeeded|failed|canceled
- Step 详情页 SHALL 提供：
  - 补偿历史时间线（仅摘要）
  - 受控触发按钮（具备权限且 step 可补偿时可用）

#### Scenario: 可补偿 step 展示与触发
- **GIVEN** step 已保存 undoToken 且主体具备权限
- **WHEN** 用户在 UI 触发 compensate
- **THEN** 系统创建 compensation_request 并进入执行队列
- **AND** UI 展示状态变化与 trace/run 关联

### Requirement: CompensationGovernanceAndApprovalV1
系统 SHALL 为补偿提供治理门槛（V1 最小）：
- 可选审批：对高风险 toolRef（由策略/配置判定）补偿请求进入 needs_approval
- 审计：补偿请求、审批、执行结果均必须写审计（仅摘要）
- 错误码：STEP_NOT_COMPENSABLE、COMPENSATION_FORBIDDEN、COMPENSATION_NEEDS_APPROVAL（或等价稳定 errorCode）

### Requirement: HumanAiCollaborationStandardKitV1
系统 SHALL 提供人机协作标准件以复用“可追溯的协作链路”：
- 标准化协作事件（message/envelope）展示组件：
  - role、intent、correlation（taskId/runId/stepId/traceId）、inputs/outputs digest、evidenceRefs
- 人类动作（V1）：
  - 添加注释/证据引用（仅摘要/引用）
  - 发起“交接/纠偏”请求：生成一条 intent=handoff 的协作事件并写审计
- 约束：
  - UI 与 API 均必须遵守 tenant/space 隔离
  - 不得展示敏感原文，仅摘要与引用

#### Scenario: 人类补充上下文并可追溯
- **WHEN** 用户在 task 时间线添加一条补充说明与 evidenceRef
- **THEN** 系统写入协作事件并可在时间线检索
- **AND** 审计记录包含 taskId 与动作摘要

## MODIFIED Requirements

### Requirement: ExecutionCenterStepDetail（Modified）
执行中心 Step 详情页 SHALL 增加“Undo/补偿”区块（不改变原有 output 展示安全边界）。

## REMOVED Requirements
（无）

