# 工作流引擎（Run/Step、队列、幂等、撤销）MVP Spec

## Why
《架构-07》要求把高风险写操作与长耗时动作纳入可恢复系统：可重试、可审计、可回放，并提供最小可用的取消/撤销语义。当前平台虽已有 worker 执行与部分审计/幂等能力，但缺少“以 Run/Step 为一等对象”的契约化 API、状态机与取消入口，导致执行生命周期不可运营。

## What Changes
- 新增 Workflow Run/Step 数据模型（MVP）：Run（执行快照）与 Step（最小执行单元）
- 新增队列调度与重试策略（MVP）：queued/running/succeeded/failed/canceled
- 新增撤销入口（MVP）：对可取消的 Run 提供 cancel API，并产生审计与状态迁移
- 新增幂等约束（MVP）：幂等键贯穿 Run/Step（重复提交不产生重复副作用）
- 新增 Run/Step 查询 API（MVP）：列表/详情/按 traceId 查询（运营与排障）

## Impact
- Affected specs:
  - 工作流与自动化（审批队列、幂等、可靠执行）
  - 审计域（Run/Step 生命周期全量审计）
  - 治理控制面（高风险执行可接入审批/评测门槛的后续演进点）
- Affected code:
  - DB：新增 workflow_runs/workflow_steps（或等价）
  - API：新增 /runs/* 与 /workflow/*（创建、查询、取消）
  - Worker：对齐 step 执行结果上报与状态机迁移

## ADDED Requirements

### Requirement: WorkflowRun 对象（MVP）
系统 SHALL 提供 WorkflowRun 一等对象，表示一次可追溯的执行上下文快照。
- 最小字段（MVP）：
  - runId、tenantId、spaceId、status
  - createdBySubjectId、trigger（manual/webhook/im/schedule）
  - inputDigest、policySnapshotDigest（摘要即可）
  - idempotencyKey（写意图幂等）
  - createdAt/updatedAt、startedAt/finishedAt

#### Scenario: 创建 Run（幂等）
- **WHEN** 用户用相同 idempotencyKey 创建 Run
- **THEN** 系统返回同一 runId
- **AND** 不重复创建重复的 steps/副作用

### Requirement: WorkflowStep 对象（MVP）
系统 SHALL 为每个 Run 维护 steps，Step 是最小执行单元（通常对应一次工具调用）。
- 最小字段（MVP）：
  - stepId、runId、status、attempt
  - toolRef（含版本锁定）、inputDigest、outputDigest（摘要）
  - timeoutMs、retryPolicy
  - errorCategory（retryable/policy_violation/timeout/internal）
  - createdAt/updatedAt、startedAt/finishedAt

#### Scenario: Step 状态机
- **WHEN** worker 执行 step
- **THEN** step 状态从 pending→running→succeeded|failed|timeout
- **AND** 每次状态迁移写审计（含 attempt）

### Requirement: 队列调度与重试（MVP）
系统 SHALL 支持将 Run 入队并由 worker 拉取执行。
- 重试策略（MVP）：
  - 仅对 retryable 错误重试
  - 最大重试次数可配置（默认 3）
  - 退避策略可配置（默认指数退避）

#### Scenario: retryable 失败会重试
- **GIVEN** step 第一次失败且分类为 retryable
- **WHEN** 触发重试
- **THEN** attempt 增加并继续执行
- **AND** 审计中可追溯所有 attempt

### Requirement: 取消（Cancel）语义（MVP）
系统 SHALL 支持对 Run 发起 cancel，并保证取消可审计且不会产生新的副作用。
- 规则（MVP）：
  - 若 Run 已 finished（succeeded/failed/canceled），cancel MUST 返回稳定错误码
  - 若 Run 正在运行，cancel SHOULD 进入 canceled（或 canceled_pending）并停止后续 steps

#### Scenario: 取消成功
- **WHEN** 用户取消一个 queued 或 running 的 Run
- **THEN** Run 进入 canceled（或可解释的取消态）
- **AND** 未执行的 step 不再执行
- **AND** 写审计（action=run.cancel）

### Requirement: 审计对齐（MVP）
系统 SHALL 对 Run/Step 生命周期写审计，且仅记录输入/输出摘要，不记录敏感原文。
- 关键审计点（MVP）：
  - run.created、run.enqueued、step.started、step.finished、run.finished、run.canceled

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

