# 工作流审批（Approval）V1 Spec

## Why
《架构-07》要求高风险写操作默认进入“先审后改”的工作流护栏，并保证审批通过后执行复用原始 inputDigest、policySnapshot 与 idempotencyKey。当前系统已有 Run/Step 与 `needs_approval` 状态语义，但缺少面向运营的审批对象、审批 API 与审计对齐，导致无法形成可用的审批闭环。

## What Changes
- 审批对象（V1）：
  - ApprovalRequest：绑定到 runId（及其 steps），承载审批链路与决策
  - ApprovalDecision：approve/reject，含理由与审计摘要
- 审批 API（V1）：
  - `GET /approvals?status=pending`：待办列表
  - `GET /approvals/:approvalId`：审批详情（包含 run/steps 摘要）
  - `POST /approvals/:approvalId/decisions`：提交审批决策（approve/reject）
- 执行联动（V1）：
  - approve：将 run 从 needs_approval 推进到可执行态并入队
  - reject：run/step 标记为 canceled 或 failed（按约定）且不再执行
- 审计对齐（V1）：
  - 审批创建、审批决策、执行推进都必须写审计（只写摘要）

## Impact
- Affected specs:
  - 工作流与自动化（审批、队列、幂等）
  - 认证与授权（审批权限模型）
  - 审计域（审批与推进的不可篡改记录）
- Affected code:
  - DB：新增 approvals/approval_decisions 表（或等价）
  - API：新增 approvals 路由与与 runs 联动
  - Worker：无需改动执行逻辑，仅依赖 run 状态推进后的入队

## ADDED Requirements

### Requirement: ApprovalRequest（V1）
系统 SHALL 将高风险执行意图抽象为 ApprovalRequest 并绑定到 Run：
- 最小字段（V1）：
  - approvalId、tenantId、spaceId
  - runId、stepId（可选：当只审批某一步）
  - status：pending|approved|rejected|canceled
  - requestedBySubjectId、requestedAt
  - policySnapshotRef（引用或摘要）
  - inputDigest（摘要）

约束（V1）：
- ApprovalRequest MUST 只保存摘要，不保存敏感原文
- ApprovalRequest MUST 与 run.tenantId/spaceId 一致

#### Scenario: 创建审批请求
- **WHEN** 创建一个需要审批的 Run（或 step）
- **THEN** 系统创建 pending 的 ApprovalRequest
- **AND** 审计记录 action=approval.requested

### Requirement: ApprovalDecision（V1）
系统 SHALL 支持对 ApprovalRequest 提交审批决策：
- decision：approve|reject
- reason：可选字符串（长度受限）
- decidedBySubjectId、decidedAt

约束（V1）：
- 同一个 ApprovalRequest 在终态（approved/rejected/canceled）后 MUST 拒绝再次提交决策
- decision 写入必须写审计（action=approval.decided），且包含 runId/approvalId 摘要

#### Scenario: 审批通过推进执行
- **GIVEN** run.status=needs_approval 且存在 pending ApprovalRequest
- **WHEN** 审批人提交 approve
- **THEN** ApprovalRequest.status=approved
- **AND** run/step 状态推进到可执行态并入队
- **AND** 执行复用原始 inputDigest、policySnapshotRef、idempotencyKey（不允许被覆盖）

#### Scenario: 审批拒绝终止执行
- **WHEN** 审批人提交 reject
- **THEN** ApprovalRequest.status=rejected
- **AND** run 标记为 canceled 或 failed（按实现约定），且后续 step 不再执行

### Requirement: 审批查询（V1）
系统 SHALL 支持审批待办与详情查询：
- `GET /approvals?status=pending` 返回当前 subject 可见的待办（按 tenant/space 隔离）
- `GET /approvals/:approvalId` 返回审批摘要 + 关联 run/steps 的摘要

#### Scenario: 待办列表
- **WHEN** 审批人查询 pending 审批
- **THEN** 返回其可见范围内的 pending approvals 列表

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

