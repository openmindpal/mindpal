# 架构-16（治理控制面：发布/灰度/回滚/评测）验收清单 Spec

## Why
架构-16要求治理控制面具备可复现的发布与变更闭环（预检门禁、灰度、回滚），并将评测结果纳入发布门禁，确保变更在生产条件下可控、可审计、可追溯。

## What Changes
- 明确 changeset 预检与门禁的验收标准：预检输出 gate 列表，release 强制执行门禁（含 eval admission）
- 明确灰度/回滚验收标准：canary→promote→rollback 全流程可复现且每步审计到位
- 补齐评测 runner 验收标准：changeset 绑定 eval_suites 后可实际跑 eval_runs、产出报告、按阈值判定 pass/fail，并回写到 release gate

## Impact
- Affected specs:
  - governance-release-mvp
  - governance-preflight-canary-mvp
  - governance-eval-admission-mvp
- Affected code:
  - apps/api/src/routes/governance.ts
  - apps/api/migrations/017_governance_canary_preflight.sql
  - apps/api/migrations/*eval*（EvalSuite/EvalRun 相关）

## ADDED Requirements
### Requirement: changeset 预检输出 gate 列表
系统 SHALL 在 `GET /governance/changesets/:id/preflight` 返回 gate 列表，至少包含：
- 评测准入（eval admission）信息（suite 绑定、阈值、最近一次评测结果摘要或缺失原因）
- 风险/审批相关 gate（若适用）
- 其他已配置门禁项的摘要（仅摘要，不含敏感原文）

#### Scenario: preflight 只读
- **WHEN** 调用 preflight
- **THEN** 返回 plan/currentState/rollbackPreview/warnings/gates
- **AND** 不改变 changeset 状态与 active 指针
- **AND** 写审计（仅摘要）

### Requirement: release 时强制执行门禁
系统 SHALL 在 `POST /governance/changesets/:id/release` 强制执行所有适用 gate。

#### Scenario: 门禁未通过拒绝发布
- **WHEN** changeset 未通过 eval admission（或其他 gate）
- **THEN** release SHALL 被拒绝并返回稳定错误码
- **AND** 写审计摘要，包含 gate 结果（不含敏感 payload）

#### Scenario: 门禁通过允许发布
- **WHEN** changeset 所有 gate 通过
- **THEN** release 执行成功，并写审计摘要

### Requirement: 灰度/回滚闭环
系统 SHALL 支持工具的 canary→promote→rollback 全流程可复现，且每一步写审计摘要。

#### Scenario: canary 仅影响目标 scope
- **WHEN** 以 `release?mode=canary` 发布到 canaryTargets
- **THEN** 仅目标 scope 生效（可通过 effective 查询验证）
- **AND** 写审计摘要（含 targets 与 diffDigest）

#### Scenario: promote 后全量生效且可 rollback
- **WHEN** promote
- **THEN** 全量 scope 生效并清理 canary 覆盖
- **AND** rollback 可恢复到发布前状态（含覆盖清理）
- **AND** promote/rollback 均写审计摘要

### Requirement: 评测 runner（EvalRun）可执行并形成报告
系统 SHALL 在 changeset 绑定 eval_suites 后，能够触发评测执行并产出 eval_runs 报告摘要，且将结果参与 release gate。

#### Scenario: 触发评测并产出摘要报告
- **WHEN** 通过治理入口触发 eval
- **THEN** 创建 eval_run 记录并执行评测
- **AND** 产出 summary/report 摘要（不泄露敏感原文）
- **AND** 写审计摘要（含 suiteId/runId/result）

#### Scenario: 按阈值判定并回写 gate
- **WHEN** eval_run 完成
- **THEN** 系统按 suite 阈值判定 pass/fail
- **AND** changeset preflight/release gate 可读取到最新 pass/fail 摘要并据此放行/拒绝

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

