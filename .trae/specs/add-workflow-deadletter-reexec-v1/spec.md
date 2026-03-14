# 工作流执行死信与重执行 V1 Spec

## Why
当前工作流引擎已具备队列执行、重试与审批，但缺少“死信（DLQ）”与“重执行（re-exec）”的标准化能力，导致失败任务难以治理处置、也无法在新环境/新上下文下安全地再次执行。

## What Changes
- 新增 Workflow Queue 死信能力：当 Step 重试耗尽后进入 deadletter 状态，并提供治理侧列表/重试/取消接口
- 新增 Run 的重执行能力：从历史 Run 创建新的 Run（新 runId + 新幂等域），显式标记为 re-exec 并写审计
- Web 增加治理页：查看 workflow deadletters 并执行重试/取消；Run 详情页提供“重执行”入口
- 更新审计：记录 deadletter 与 re-exec 的结构化摘要

## Impact
- Affected specs: Workflow/Automation、Audit、Governance/Admin、AI Orchestrator（run/step 语义）
- Affected code:
  - DB migrations：扩展 runs/steps/jobs 以支持 deadletter 与 re-exec 元数据
  - API：新增/扩展 workflow 治理路由与 run re-exec 路由
  - Worker：在队列重试耗尽时将 step/job/run 置为 deadletter 并写审计
  - Web：新增治理 deadletters 页面与 run 详情动作

## ADDED Requirements
### Requirement: Workflow Step Deadletter
系统 SHALL 在 Step 的队列重试耗尽后，将该 Step 进入可治理的 deadletter 状态，并可被人工重试或取消。

#### Scenario: Deadletter on exhausted retries
- **WHEN** 某 Step 在队列中执行失败并达到最大重试次数
- **THEN** Step 状态为 `deadletter`（或 `failed` + `deadlettered_at` 显式标记），并记录 `errorCategory` 与 `lastErrorDigest`（不包含敏感信息）
- **AND** 对应 Job/Run 的状态可被查询到“存在 deadlettered step”
- **AND** 写入审计事件，action 为 `workflow:deadletter`，包含 runId/stepId/toolRef/attempt 等摘要

#### Scenario: Governance list deadletters
- **WHEN** 具有治理权限的主体请求 `GET /governance/workflow/deadletters`
- **THEN** 返回 deadlettered steps 的分页列表（包含 runId、stepId、toolRef、deadletteredAt、错误摘要）
- **AND** 非治理权限主体请求该接口 **THEN** 返回授权拒绝

#### Scenario: Retry a deadlettered step
- **WHEN** 具有治理权限的主体对 deadletter step 执行重试操作
- **THEN** Step 状态回到 `pending`（并清理 deadletter 标记）并重新入队
- **AND** 写入审计事件，action 为 `workflow:deadletter_retry`

#### Scenario: Cancel a deadlettered run
- **WHEN** 具有治理权限的主体对 deadletter step / run 执行取消操作
- **THEN** Step 状态为 `canceled`，Run/Job 状态进入 `canceled`（若无其它未完成 steps）
- **AND** 写入审计事件，action 为 `workflow:deadletter_cancel`

### Requirement: Run Re-exec
系统 SHALL 支持从既有 Run 创建新的 Run 进行“重执行”，并保证与原 Run 的幂等语义隔离。

#### Scenario: Re-exec creates a new run
- **WHEN** 用户在 Run 详情页触发“重执行”
- **THEN** 创建新的 Run（新的 runId），其 `reexecOfRunId` 指向原 runId
- **AND** 新 Run 生成新的 `idempotencyKey`（或由客户端显式提供），不得复用原 Run 的幂等键
- **AND** 新 Run 进入 `queued`（或按 tool risk/approval 进入 `needs_approval`）并按当前策略执行
- **AND** 写入审计事件，action 为 `workflow:reexec`

#### Scenario: Replay remains read-only
- **WHEN** 用户请求 replay（回放）接口
- **THEN** 系统仅返回历史轨迹与摘要，不触发队列执行、不调用外部系统

## MODIFIED Requirements
### Requirement: Run Retry
系统 SHALL 支持对失败/超时/取消或 deadletter 的 Run 发起重试，重试行为仅重置可重试的 steps，并保持写入侧副作用幂等。

## REMOVED Requirements
（无）

