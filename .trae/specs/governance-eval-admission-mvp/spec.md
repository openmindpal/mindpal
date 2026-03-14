# 治理控制面（Governance）评测准入 MVP Spec

## Why
当前治理已支持变更集、预检、灰度与回滚，但《架构-16》要求把“可回放评测”作为高风险变更发布门槛：**不通过评测不发布**，并把评测产物与审计/变更集关联，形成可追溯的准入闭环。

## What Changes
- 新增评测对象（MVP）：EvalSuite（评测集）与 EvalRun（一次评测运行）
- 新增变更集准入绑定（MVP）：Changeset 绑定需要通过的 EvalSuite，并记录最新 EvalRun 结论
- 新增评测 API（MVP）：创建/更新评测集、触发评测运行、查询评测结果
- 修改发布门槛（MVP）：高风险变更在 release 前必须通过评测（满足阈值），否则拒绝发布
- 修改 preflight 输出（MVP）：输出评测缺失/未通过等 warnings，并回显 eval gate 信息

## Impact
- Affected specs:
  - 治理控制面（评测准入、审计可追溯、默认拒绝与可回滚）
  - AI 编排与工具执行链路（评测运行可复用工具执行与审计）
  - 可观测性（评测通过率、拒绝率等基础指标产出）
- Affected code:
  - DB：新增 eval_suites/eval_runs/changeset_eval_bindings（或等价结构）
  - API：新增 /governance/evals/* 与 /governance/changesets/:id/evals/*；修改 changeset release 与 preflight
  - Tests/Docs：新增 e2e 覆盖“评测未通过拒绝发布/通过后允许发布”

## ADDED Requirements

### Requirement: EvalSuite（评测集）
系统 SHALL 提供可版本化（或至少可更新）的评测集，用于描述回放评测的输入与判定约束。
- EvalSuite 字段（MVP 建议）：
  - suiteId、tenantId、name、description
  - cases：数组（每个 case 至少包含 inputs 与 expectedConstraints）
  - thresholds：通过阈值（例如 passRateMin、denyRateMax 等）
  - createdAt/updatedAt

#### Scenario: 创建评测集
- **WHEN** Tenant Admin 创建一个 EvalSuite
- **THEN** 系统持久化 suite 与 cases/thresholds
- **AND** 写审计（resourceType=governance, action=evalsuite.write）

### Requirement: EvalRun（评测运行）
系统 SHALL 支持对指定 EvalSuite 触发一次评测运行，并产出可追溯的摘要结果。
- EvalRun 字段（MVP 建议）：
  - runId、tenantId、suiteId、status（queued/running/succeeded/failed）
  - summary：{ totalCases, passedCases, passRate, deniedCases, denyRate, warningsCount }
  - evidenceDigest：可选（仅摘要，不存敏感原文）
  - startedAt/finishedAt

#### Scenario: 触发评测运行并返回摘要
- **WHEN** 用户触发评测运行
- **THEN** 系统创建 EvalRun 并最终返回 summary
- **AND** 写审计（action=evalrun.execute）

### Requirement: Changeset 评测准入绑定
系统 SHALL 支持为 Changeset 绑定需要通过的 EvalSuite，并在发布门槛中强制校验。
- Changeset SHALL 支持绑定 requiredEvalSuites（suiteId 列表）
- 每次 release 前 SHALL 选择“最新成功的 EvalRun”作为准入依据

#### Scenario: 未通过评测拒绝发布
- **GIVEN** Changeset 绑定了至少 1 个 requiredEvalSuites
- **WHEN** 尝试 release 且任一 suite 的最新 EvalRun 未达到阈值或不存在
- **THEN** 拒绝发布（稳定错误码，例如 EVAL_NOT_PASSED）
- **AND** 写审计（result=denied，errorCategory=policy_violation）

#### Scenario: 通过评测允许发布
- **WHEN** 所有 requiredEvalSuites 均有通过阈值的最新 EvalRun
- **THEN** 允许 release（full/canary 均适用）

## MODIFIED Requirements

### Requirement: 高风险变更必须通过评测准入
系统 SHALL 对高风险变更（riskLevel=high 或 approvalRequired=true 的策略集合）强制评测准入：
- preflight MUST 输出 requiredEvalSuites 与当前通过状态
- release MUST 校验评测通过后再应用变更

## REMOVED Requirements
（无）

