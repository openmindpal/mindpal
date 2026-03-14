# 统一发布流水线闭环 + 长任务中心（Governance + Agent Runtime）V2 Spec

## Why
当前仓库已分别具备 changeset/preflight/canary/promote/rollback、评测准入、配额/路由治理与 agent runtime（plan/execute/cancel/continue）等能力，但缺少“产品级闭环”的统一入口、统一状态视图与可靠的持续运行体验，导致治理动作分散、准入门槛不易看清、回滚不够一键化，长任务也缺少中心化管理与回放评测串联。

## What Changes
- 治理控制面 V2：把发布/灰度/回滚/评测准入/审批门槛串成统一发布流水线（Pipeline），提供可视化状态与可操作闭环。
- 长任务中心 V2：把 orchestrator/agent runtime/workflow runs 的持续运行体验统一到一个“执行中心”，提供计划、进度、事件、审批、取消、继续与回放入口。
- 可观测与操作手册：统一输出稳定的 pipeline/long-task 摘要与指标，补齐面向运维/管理员的操作手册（最小可用版本）。

## Impact
- Affected specs:
  - governance-release-mvp / governance-preflight-canary-mvp / governance-eval-admission-mvp
  - execution center UI / replay UI（若已存在则复用）
  - agent-runtime-plan-execute-v1 / workflow-replay-v1
- Affected code:
  - API：governance changesets/eval、workflow runs、tasks/agent-runs 的读接口扩展（汇总视图）
  - Web Console：发布流水线页面、长任务中心页面、运行详情页（复用现有执行中心/治理 UI 的组件）
  - Metrics/Audit：新增/扩展指标与审计输出字段（不泄露敏感明文）

## ADDED Requirements

### Requirement: 发布流水线视图（Pipeline Read Model）
系统 SHALL 提供“发布流水线”统一视图，用于把 changeset 的发布过程（preflight →（canary）→ promote → rollback）与强制准入门槛（评测/审批/风险等级/配额告警）汇总为一个稳定的读模型。

#### Pipeline Summary 字段（最小集合）
Pipeline Summary SHALL 至少包含：
- changeset：`{ id, kind, title?, status, createdAt, createdBy }`
- gates（数组，顺序稳定）：每个 gate 至少包含 `{ gateType, required, status, detailsDigest }`
  - gateType 最少包含：`eval_admission`、`approval`、`risk`、`quota`（可扩展）
  - status 最少包含：`pass`/`warn`/`fail`/`unknown`
- rollout：`{ mode, canaryTargets?, releasedAt?, promotedAt?, rolledBackAt? }`
- rollbackPreviewDigest（可选）：用于展示可回滚范围/影响摘要（不含敏感原文）

#### Scenario: 读取 changeset 的流水线摘要
- **WHEN** 管理员在控制台打开某 changeset
- **THEN** 系统返回该 changeset 的 Pipeline Summary
- **AND** gates 的状态与 preflight/eval/审批等现状一致

### Requirement: 统一发布操作（Pipeline Actions）
系统 SHALL 提供统一发布操作入口（API + UI），并确保每个动作都写审计且可观测。

支持的最小动作：
- preflight：只读，产出 plan/currentStateDigest/warnings/gates
- release（full/canary）：执行发布并写入 releasedAt/canaryReleasedAt 等状态
- promote：将 canary 变更提升至全量
- rollback：从当前发布状态回滚到发布前状态（或指定安全回滚点）

#### Scenario: 强制准入门槛阻断发布
- **WHEN** changeset 风险等级为高且 required eval suite 未通过
- **THEN** release MUST 被拒绝并返回稳定错误码（沿用既有 EVAL_NOT_PASSED 或等价）
- **AND** UI 显示 gate=eval_admission 为 fail，并可跳转到评测结果

#### Scenario: 一键回滚
- **WHEN** changeset 已发布（full 或 canary/promote）且管理员点击 rollback
- **THEN** 系统执行回滚并写审计（含变更前后摘要）
- **AND** Pipeline Summary 展示 rolledBackAt 与回滚摘要

### Requirement: 发布流水线控制台（UI）
系统 SHALL 在控制台提供发布流水线 UI，以统一展示 changesets、准入门槛与可操作动作。

#### UI 最小交付
- changeset 列表：按状态过滤（draft/preflighted/released/rolled_back 等）
- changeset 详情：展示 gates、preflight 摘要、评测状态、可操作按钮（release/canary/promote/rollback）
- 错误展示：对稳定错误码做 i18n 映射，并展示“下一步动作”（例如触发评测/补审批）

### Requirement: 长任务中心（Long-Task Center）
系统 SHALL 提供“长任务中心”统一入口，以 tasks/agent-runs/workflow runs 为核心对象展示持续运行体验，并支持管理员/操作者查看运行详情与执行控制（受权限保护）。

#### Long-Task Read Model（最小集合）
长任务中心的列表项 SHALL 至少包含：
- task：`{ taskId, title?, createdAt, subjectId?, spaceId }`
- run：`{ runId, status, jobType, startedAt?, finishedAt?, lastErrorCategory? }`
- progress：`{ phase?, stepCount?, maxSteps?, wallTimeMs?, maxWallTimeMs? }`
- controls：`{ canCancel, canContinue, needsApproval }`

#### Scenario: 任务在 needs_approval 后可继续推进
- **WHEN** agent run 进入 needs_approval 且管理员在 run 页面完成审批并点击 continue
- **THEN** 系统继续推进 plan-and-execute 循环
- **AND** run 的事件流记录审批与继续动作（不含敏感明文）

### Requirement: 回放与评测串联（Replay + Eval）
系统 SHALL 支持从长任务中心对已完成 run 创建回放，并可关联评测准入/评测结果（最小闭环）。

#### Scenario: 从 run 创建 replay
- **WHEN** run 已完成且具有可回放的 inputDigest/traceId（或等价引用）
- **THEN** 控制台可创建 replay 任务并展示 replay 结果入口

## MODIFIED Requirements

### Requirement: 统一审计摘要（Governance/Long-Task）
发布流水线动作（preflight/release/promote/rollback）与长任务动作（create/cancel/continue/approve）SHALL 写入稳定结构的审计摘要：
- MUST 不包含密钥/令牌等敏感明文
- SHOULD 包含相关对象引用（changesetId/taskId/runId/traceId）与 gates 摘要（digest 或计数）

## REMOVED Requirements
（无）

