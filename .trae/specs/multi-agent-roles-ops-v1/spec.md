# 多智能体角色编排与可观测运营闭环 Spec

## Why
当前系统已具备 Tasks/Messages 容器、Agent Runtime（Plan-and-Execute）V1、Workflow/Approval 的可靠执行链路，但多智能体仍停留在“规范与部分底座”：缺少可配置的角色编排、跨角色协作的状态机、以及面向运营的可观测与治理闭环，难以稳定支撑长任务与生产运维。

## What Changes
- 引入“协作运行（Collab Run）”作为多智能体协作的一级对象：将一个 Task 下的多个 Agent Run 组织为同一个协作会话与执行单元
- 引入“角色（Role）”与“参与者（Actor）”的可配置编排：planner/executor/reviewer 等角色具备各自工具权限、预算与策略约束
- 扩展 Agent Runtime 计划结构：计划步骤支持标注 `actorRole` 与并行分组，支持跨角色移交与恢复
- 引入可观测运营闭环：
  - 统一事件流（collab_run_events）：状态迁移、角色发言、工具调用、审批、失败/重试、预算消耗等
  - 统一指标（metrics）：成功率、耗时、步骤数、needs_approval 比例、deadletter 比例、budget exceed、token/费用聚合等
  - 统一查询接口：按 task/collabRun/run/actorRole 维度查询 timeline、聚合与诊断摘要
- 强化治理边界：跨角色执行仍严格复用“鉴权→授权→审计→DLP→审批→队列执行”主链路；任何角色都不能绕开策略快照与审计

## Impact
- Affected specs:
  - multi-agent-collab-mvp（Task/Message 容器继续复用）
  - agent-runtime-plan-execute-v1（计划结构与状态持久化扩展）
  - workflow-engine-mvp / workflow-approval-v1（并行/重试/审批事件可观测）
  - add-api-metrics-v1（新增多智能体指标）
- Affected code:
  - API：tasks/messages、agent runtime、orchestrator、governance/metrics 路由与模块
  - Worker：workflow processor（agent.run 调度扩展、并行分组与事件写入）
  - DB：新增 collab run 与事件表、必要索引

## ADDED Requirements

### Requirement: Collab Run（多智能体协作运行）
系统 SHALL 提供 Collab Run 作为多智能体协作的顶层对象，用于承载角色编排、执行状态机与运营可观测数据。

#### Contract: 创建 Collab Run
- **Endpoint**: `POST /tasks/:taskId/collab-runs`
- **Input**:
  - `message`：用户输入
  - `roles`（可选）：角色集合（默认：planner/executor/reviewer）
  - `limits`（可选）：`{ maxSteps?: number, maxWallTimeMs?: number, maxTokens?: number, maxCostUsd?: number }`
- **Output**:
  - `collabRunId`
  - `status`：`created | planning | executing | needs_approval | succeeded | failed | canceled | stopped`
  - `primaryRunId`（可选）：用于承载执行的 workflow runId（可与 Agent Run 复用）

#### Scenario: 创建成功
- **WHEN** 用户基于某个 Task 创建 Collab Run
- **THEN** 系统生成 `collabRunId` 并写入初始状态
- **AND** 事件流记录 `collab.run.created`（含 taskId/collabRunId/subject/limits 摘要）
- **AND** Task Messages 追加一条 intent=`observe` 或 intent=`plan` 的结构化消息（不含敏感明文）

#### Contract: 查询 Collab Run
- **Endpoint**: `GET /tasks/:taskId/collab-runs/:collabRunId`
- **Output**:
  - `collabRun`（状态、角色配置、limits、摘要）
  - `runs[]`（关联的 agent/workflow runs 摘要）
  - `latestEvents[]`（最近 N 条事件摘要）

### Requirement: Role / Actor（角色与参与者）
系统 SHALL 支持定义并绑定角色到 Collab Run，并在执行/审计/可观测数据中显式标注 actorRole。

#### Role 最小字段（V1）
角色 SHALL 至少包含：
- `roleName`：如 planner/executor/reviewer
- `toolPolicy`：允许/禁止的 toolRef（可引用既有治理配置）
- `budget`：`maxSteps/maxTokens/maxCostUsd`（缺省继承 run limits）
- `mode`：`auto | assist`（auto 表示可由系统驱动执行，assist 表示需要人工确认/输入）

#### Scenario: 角色约束生效
- **WHEN** 执行某一步骤其 `actorRole=executor`
- **THEN** 系统在创建 workflow step 前验证该角色的 toolPolicy 与预算
- **AND** 若不满足则拒绝推进并记录 `collab.run.blocked` 事件（含拒绝原因摘要）

### Requirement: 多角色计划（Plan V2）
系统 SHALL 扩展 Agent Runtime 计划结构支持多角色编排与并行分组，并持久化到 taskState。

#### Plan 结构（V2）
plan SHALL 为 JSON 对象，至少包含：
- `goal`
- `roles[]`：本次协作的角色与配置摘要
- `steps[]`：步骤数组，每步包含：
  - `stepId`
  - `actorRole`
  - `kind`：`tool | message`
  - `toolRef`（kind=tool）
  - `inputDraft`（kind=tool）
  - `dependsOn[]`（可选）：用于表达并行/依赖
  - `approvalRequired`

#### Scenario: 计划可回读与可恢复
- **WHEN** 系统生成 plan（V2）
- **THEN** 将 plan 写入可恢复状态（与既有 `memory_task_states` 兼容的扩展字段）
- **AND** 事件流记录 `collab.plan.generated`（仅存摘要）

### Requirement: 执行编排（跨角色移交）
系统 SHALL 根据 plan 的 `actorRole` 驱动执行，并在跨角色移交时记录可追溯事件。

#### Scenario: planner→executor→reviewer
- **WHEN** plan 中包含 planner 产出执行步骤、executor 执行工具、reviewer 验收的链路
- **THEN** 系统按 `dependsOn` 与顺序推进步骤
- **AND** 每个步骤在 Task Messages 与事件流中记录 `actorRole`、stepId、结果摘要、policySnapshotRef（如存在）

### Requirement: 可观测运营闭环（Events + Metrics + Query）
系统 SHALL 提供统一的可观测闭环，支持排障与运营报表。

#### Events（最小集合）
系统 SHALL 记录以下事件类型（至少）：
- `collab.run.created | collab.plan.generated | collab.step.started | collab.step.completed | collab.step.failed`
- `collab.run.needs_approval | collab.run.approved | collab.run.rejected`
- `collab.run.stopped | collab.run.canceled`
- `collab.budget.exceeded | collab.policy.denied`

#### Scenario: 运营侧可按维度检索
- **WHEN** 管理员按 `taskId/collabRunId/traceId/actorRole/status` 检索
- **THEN** 返回可分页的事件流与聚合摘要（成功率/耗时/步骤数/审批占比等）

## MODIFIED Requirements

### Requirement: Agent Runtime V1 兼容与扩展
系统 SHALL 保持 V1 单智能体 API 与行为兼容，同时：
- `taskState` 允许携带 collabRunId、roles 摘要与 steps 的 actorRole 信息
- 执行与审计记录必须包含 actorRole（缺省为 `executor`）

## REMOVED Requirements
无

