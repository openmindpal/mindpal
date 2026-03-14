# Agent Runtime（Plan-and-Execute）V1 Spec

## Why
当前系统已具备 Orchestrator 的“单回合建议 + 受控工具执行”（含审批闸门）、Workflow/Queue 的可靠执行框架、以及 Tasks/Messages 的任务容器，但缺少面向长任务的“规划与执行循环（Plan-and-Execute）”与可恢复状态，尚未满足《架构设计.md》15.1/15.2 对可持续运行智能体的要求。

## What Changes
- 新增 Agent Runtime API：基于既有 Task，创建并驱动一个“Agent Run”，可生成结构化计划并逐步执行工具步骤
- Agent Run 与 Workflow Run 绑定：Agent Run 以 Workflow 的 runId 作为唯一标识（不新增新的 run 表），以复用队列、审批、重试与审计链路
- 引入可恢复的任务状态：使用 `memory_task_states` 持久化当前 phase、plan、光标与关键产物摘要，支持中断后继续
- 引入执行边界：对每个 Agent Run 强制 `maxSteps` 与 `maxWallTimeMs`，避免无限循环与资源失控
- 标准化事件记录：Agent Runtime 在 Task Messages 中追加结构化消息（plan/execute/review/observe/respond），并对关键动作写审计

## Impact
- Affected specs:
  - AI 编排层（受控工具调用与回放）
  - 工作流与自动化（审批、队列、幂等、可回放）
  - 记忆层（任务状态持久化与可恢复）
  - 审计域（运行/步骤/拒绝/取消的审计一致性）
- Affected code:
  - API：Task/Workflow/Orchestrator 路由与模块
  - Worker：Workflow step 处理器（新增/扩展 agent.run 的步骤调度与边界处理）

## ADDED Requirements

### Requirement: Agent Run 创建与读取
系统 SHALL 提供基于 Task 的 Agent Runtime 接口，支持创建与读取 Agent Run。

#### Contract: 创建 Agent Run
- **Endpoint**: `POST /tasks/:taskId/agent-runs`
- **Input**:
  - `message`：用户输入文本
  - `limits`（可选）：`{ maxSteps?: number, maxWallTimeMs?: number }`
- **Output**:
  - `runId`：绑定的 Workflow runId
  - `status`：`queued | running | needs_approval | succeeded | failed | canceled | stopped`
  - `taskState`：当前 `phase` 与 `plan` 摘要（允许为空）

#### Scenario: 创建成功
- **WHEN** 用户对某个 Task 调用创建接口
- **THEN** 系统创建一个新的 Workflow Run（jobType=`agent.run`）并返回 `runId`
- **AND** 系统在 `memory_task_states` 为该 `runId` 创建/更新一条记录，`phase` 至少包含 `created`
- **AND** 系统向 Task Messages 追加一条 intent=`plan` 或 intent=`observe` 的消息，包含本次输入摘要与 `runId`

#### Contract: 读取 Agent Run
- **Endpoint**: `GET /tasks/:taskId/agent-runs/:runId`
- **Output**:
  - `run`（来自 workflow runs 的视图）
  - `taskState`（来自 memory_task_states 的视图）
  - `steps`（可选）：该 run 关联的 steps 列表摘要（用于 UI/调试）

#### Scenario: 读取成功
- **WHEN** 用户读取 runId 对应的 Agent Run
- **THEN** 返回 run 状态、taskState（phase/plan）与最近 steps 摘要

### Requirement: 计划生成（V1：最小可执行计划）
系统 SHALL 在 Agent Run 启动后生成一个结构化计划（plan），并持久化到 `memory_task_states.plan`。

#### Plan 结构（V1 最小集合）
plan SHALL 为 JSON 对象，至少包含：
- `goal`：从用户输入提取/归一化的目标文本
- `steps[]`：步骤数组，每步包含：
  - `stepId`：计划内步骤标识（与 workflow stepId 不同）
  - `kind`：`tool`（V1 仅支持 tool）
  - `toolRef`：候选工具引用（可为 name 或 name@version）
  - `inputDraft`：工具入参草稿（仅允许 JSON）
  - `approvalRequired`：布尔值（来自工具契约/风险推断）

#### Scenario: 计划可回读
- **WHEN** 创建 Agent Run 后系统生成计划
- **THEN** `memory_task_states.plan` 写入 plan
- **AND** `memory_task_states.phase` 更新为 `planned`
- **AND** Task Messages 追加 intent=`plan` 的结构化消息（plan 摘要，不含敏感明文）

### Requirement: 执行循环与边界（V1）
系统 SHALL 驱动 Agent Run 按计划逐步执行，并强制执行边界。

#### Scenario: 正常执行到完成
- **WHEN** Agent Run 的计划包含若干 tool 步骤且无需审批
- **THEN** 系统按顺序创建并执行对应的 workflow steps（在同一个 runId 下）
- **AND** 每个步骤执行都复用既有的“工具受控执行链路”（鉴权→校验→授权→审计→队列执行）
- **AND** 运行完成后将 run 状态置为 `succeeded`，并把 `memory_task_states.phase` 置为 `done`

#### Scenario: 遇到需要审批的步骤
- **WHEN** 执行到某个步骤发现 `approvalRequired=true`
- **THEN** 该步骤进入 `needs_approval` 状态并停止推进后续步骤
- **AND** `memory_task_states.phase` 更新为 `needs_approval`
- **AND** 返回/可查询到对应 approvalId（若系统创建了 approval）

#### Scenario: 触发 maxSteps
- **WHEN** 执行步数达到 `maxSteps`
- **THEN** Agent Run 停止推进并标记为 `stopped`
- **AND** `memory_task_states.phase` 更新为 `stopped.limit_exceeded`

#### Scenario: 触发 maxWallTimeMs
- **WHEN** Agent Run 墙钟耗时超过 `maxWallTimeMs`
- **THEN** Agent Run 停止推进并标记为 `stopped`
- **AND** `memory_task_states.phase` 更新为 `stopped.timeout`

### Requirement: 取消与恢复
系统 SHALL 支持取消 Agent Run，并在可行时支持从 `planned/running/needs_approval` 状态恢复继续。

#### Contract: 取消
- **Endpoint**: `POST /tasks/:taskId/agent-runs/:runId/cancel`
- **THEN** 将 run 标记为 `canceled`，并阻止后续步骤执行
- **AND** `memory_task_states.phase` 更新为 `canceled`

#### Contract: 继续（恢复）
- **Endpoint**: `POST /tasks/:taskId/agent-runs/:runId/continue`
- **WHEN** run 处于 `planned` 或 `running` 或 `needs_approval`（且审批已通过）
- **THEN** 系统从 `memory_task_states` 读取 plan 与光标并继续推进后续步骤

### Requirement: 审计一致性（Agent Runtime）
系统 SHALL 对 Agent Run 的关键事件写审计，至少包含：
- `resourceType=agent_runtime`，action 包含：`run.create | run.read | run.cancel | run.continue`
- traceId、tenant/space、subject、runId
- 输入输出摘要（不得包含敏感明文）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

