# 编排层回放绑定与审批绑定一致性 V1 Spec

## Why
当前平台已具备工具执行（Run/Step）、审批（Approval）、回放视图（按 runId）与审计链路，但仍缺少《架构-08》要求的“回放绑定三元组（toolRef + policySnapshot + inputDigest）”与“审批通过后的不可变绑定校验”，存在治理与可解释性缺口。

## What Changes
- 新增 Replay Resolve API：按 `toolRef + policySnapshotRef + inputDigest` 解析到已发生的执行（runId/stepId），用于回放与回归评测的稳定定位
- 审批绑定一致性增强：审批对象固化“绑定三元组摘要”，approve 时强校验与当前 step/run 一致，否则拒绝并写审计
- 审计补齐：新增 `workflow:replay_resolve` 与 `approval:binding_mismatch` 等事件，输出仅包含摘要

## Impact
- Affected specs:
  - AI 编排层（回放与重执行区分、回放绑定三元组）
  - 工作流与自动化（审批绑定不可变校验）
  - 审计域（回放解析与审批不一致拒绝的可追溯审计）
- Affected code:
  - API：新增回放解析路由；增强 approvals approve/reject 流程校验
  - DB：可选新增 approval 绑定字段/索引（用于一致性校验与查询）
  - 测试：API e2e 覆盖 replay resolve 与 approval binding mismatch

## ADDED Requirements

### Requirement: Replay Resolve API（V1）
系统 SHALL 提供按回放绑定三元组解析执行记录的接口：
- `POST /replay/resolve`

请求体（V1）至少包含：
- toolRef: string
- policySnapshotRef: string
- inputDigest: object（JSONB，脱敏后的摘要对象）

响应体（V1）至少包含：
- matches: Array<{ runId: string; stepId: string; toolRef: string; policySnapshotRef: string; inputDigest: object; createdAt?: string }>

#### Scenario: 解析到唯一匹配
- **WHEN** 存在且仅存在一条 step 满足 `toolRef + policySnapshotRef + inputDigest`
- **THEN** 返回 matches 长度为 1，并可用于后续调用 `/runs/:runId/replay`

#### Scenario: 无匹配
- **WHEN** 不存在任何匹配
- **THEN** 返回 404（稳定 errorCode），并写入 `workflow:replay_resolve` 审计（结果为 denied/not_found）

#### Scenario: 多匹配
- **WHEN** 匹配数量 > 1
- **THEN** 返回 matches 列表（最多 N 条），用于回归/对比选择；不得自动选择

### Requirement: Approval Binding 一致性校验（V1）
系统 SHALL 在审批通过时校验审批绑定与当前将执行的 step/run 一致：
- 审批对象必须固化关键绑定字段：toolRef、policySnapshotRef、inputDigest（或其等价摘要）
- approve 时必须对比：approval 绑定字段 == step/run 当前绑定字段

#### Scenario: 绑定不一致拒绝
- **WHEN** approval 绑定字段与 step/run 当前字段不一致
- **THEN** approve 返回 409（稳定 errorCode=APPROVAL_BINDING_MISMATCH）
- **AND** 该请求写审计事件 `approval:binding_mismatch`（仅摘要，不含敏感原文）
- **AND** 不入队执行、不改变 run/job/approval 的终态（除审计外）

### Requirement: 审计事件补齐（V1）
系统 SHALL 对以下动作写审计：
- 回放解析：resourceType=workflow，action=workflow:replay_resolve
- 审批不一致拒绝：resourceType=approval，action=approval:binding_mismatch

审计 outputDigest SHALL 仅包含摘要字段（如 matchCount、runId/stepId、toolRef、policySnapshotRef）。

## MODIFIED Requirements

### Requirement: Approve 行为（V1 增强）
原有审批通过逻辑在入队执行前 MUST 先通过 Approval Binding 一致性校验。

## REMOVED Requirements
（无）

