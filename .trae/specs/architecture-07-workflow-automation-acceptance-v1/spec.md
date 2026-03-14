# 架构-07（工作流与自动化）验收清单 Spec

## Why
架构-07要求工作流执行在高风险场景可控（审批闭环），故障可恢复（死信/重试/取消），并具备最小可用的补偿/撤销能力（SAGA），且全过程可审计。

## What Changes
- 明确“审批闭环”的验收标准与约束：needs_approval 分流、审批记录创建、审批通过后的绑定校验复用、policySnapshotRef 保留、幂等键规则不可绕开
- 明确“死信/重试/取消”的验收标准与审计要求：可列出 deadletters、可 retry、可 cancel，且审计到位
- 补齐“补偿/撤销（SAGA）产品化”的最小可用验收标准：可注册补偿 step、可触发补偿、补偿也走 run/step 且可重试/可审计

## Impact
- Affected specs:
  - workflow-approval-v1
  - add-workflow-deadletter-reexec-v1
  - add-workflow-step-compensation-v1
- Affected code:
  - apps/api/src/routes/tools.ts
  - apps/api/src/routes/approvals.ts
  - apps/api/src/routes/runs.ts
  - apps/api/migrations/053_workflow_deadletter_reexec.sql
  - apps/api/migrations/061_workflow_step_compensation_envelope.sql
  - apps/api/migrations/091_triggers_and_compensations.sql

## ADDED Requirements
### Requirement: 审批闭环（高风险/需审批工具执行）
系统 SHALL 在满足以下任一条件时将工具执行进入 needs_approval，并创建审批记录：
- 工具风险等级为 high
- toolSuggestion 或执行请求标记 approvalRequired=true

#### Scenario: 触发审批分流
- **WHEN** 调用工具执行入口执行上述“需审批”工具
- **THEN** 返回状态 needs_approval，并创建 approval 记录（可通过 approvals 查询到）
- **AND** 不应创建可实际落地副作用的 step 执行结果

#### Scenario: 审批通过后继续执行
- **WHEN** 对 approval 作出 approve 决策
- **THEN** 系统复用原 step 的绑定校验逻辑（与首次进入 needs_approval 的校验一致）
- **AND** policySnapshotRef 必须沿用原审批请求对应的快照引用
- **AND** 写操作工具的幂等键规则不得绕过：缺少 idempotencyKey 的写工具执行 SHALL 被拒绝

### Requirement: 死信/重试/取消（DLQ）
系统 SHALL 支持对 deadletter 的可见性与处置能力，并写入审计。

#### Scenario: 列出 deadletters
- **WHEN** 调用 deadletters 列表接口
- **THEN** 可分页返回记录，至少包含 runId、stepId、toolRef、错误摘要
- **AND** 对应查询操作写审计（仅摘要，不含敏感 payload）

#### Scenario: retry / cancel
- **WHEN** 对 deadletter step 执行 retry
- **THEN** 产生可观测的重新入队/执行结果，并写审计
- **WHEN** 对 deadletter run/step 执行 cancel
- **THEN** 状态更新正确且写审计

### Requirement: 补偿/撤销（SAGA）产品化（最小可用）
系统 SHALL 支持对“有副作用写操作”注册补偿 step，并提供触发补偿的对外 API/治理入口；补偿执行必须走 run/step，并具备重试与审计能力。

#### Scenario: 注册补偿 step
- **WHEN** 定义或执行一个会产生外部副作用的写操作 step
- **THEN** 系统允许为该 step 关联可执行的补偿 step（含必要的 undoToken/补偿输入引用）

#### Scenario: 触发补偿
- **WHEN** 通过 API/治理入口触发对某 step 的补偿
- **THEN** 生成新的 run/step 执行补偿逻辑（或以明确的可审计方式入队到既有 run/step 生命周期）
- **AND** 补偿执行支持 retry/cancel，并写审计（仅摘要，不含敏感 payload）

## MODIFIED Requirements
### Requirement: 幂等键规则（写操作工具）
系统 SHALL 拒绝所有缺少 idempotencyKey 的写操作工具执行请求，包括审批通过后的继续执行路径。

