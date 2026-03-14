# 工作流回放（Replay）V1 Spec

## Why
《架构-07》明确区分“回放（replay）”与“重执行（re-exec）”：回放用于复盘/追责/回归评测，默认只重放已记录的 Run/Step 轨迹与摘要，不再次调用模型与外部系统。当前系统已有 Run/Step 与审计事件，但缺少统一的回放 API 与稳定回放输出契约，导致无法形成可运营的“可回放”能力闭环。

## What Changes
- 新增回放 API（V1）：
  - `GET /runs/:runId/replay`：返回该 run 的回放视图（run 摘要 + steps 摘要 + timeline）
- 新增回放输出契约（V1）：
  - timeline 基于审计事件（runId/stepId 串联）与当前 steps 状态聚合生成
  - 不包含敏感原文，仅包含摘要字段（inputDigest/outputDigest/policySnapshotRef/toolRef 等）
- 访问控制与审计（V1）：
  - 访问回放需要 `workflow:read`（或单独的 `workflow:replay`，V1 可复用 read）
  - 调用回放接口本身写审计（resourceType=workflow，action=run.replay）

## Impact
- Affected specs:
  - 工作流与自动化（回放语义）
  - 审计域（timeline 基于审计聚合，且回放操作自身可审计）
  - RBAC（新增 action 或复用 workflow:read）
- Affected code:
  - API：新增 runs replay 路由与聚合逻辑
  - DB：无新增表（V1 仅查询 runs/steps/audit_events）
  - 测试：e2e 覆盖回放输出稳定性

## ADDED Requirements

### Requirement: Replay API（V1）
系统 SHALL 提供回放接口：
- `GET /runs/:runId/replay`

输出（V1）至少包含：
- run：runId、status、toolRef、policySnapshotRef、idempotencyKey、createdBySubjectId、trigger、createdAt/updatedAt/startedAt/finishedAt（若存在）
- steps：每个 step 的 stepId、seq、status、attempt、toolRef、inputDigest、outputDigest、errorCategory、updatedAt/startedAt/finishedAt（若存在）
- timeline：按时间排序的事件列表（最多 N 条），每条至少包含：
  - timestamp、eventType（run.created/run.enqueued/step.started/step.finished/run.canceled/run.finished 等）
  - runId、stepId（可为空）、result/errorCategory（可为空）
  - traceId/requestId（若可得）

#### Scenario: 回放不触发外部副作用
- **WHEN** 用户调用 `/runs/:runId/replay`
- **THEN** 系统仅查询并聚合 run/steps/audit_events 数据
- **AND** 不产生新的 steps 执行、不调用模型/外部系统

### Requirement: 访问控制（V1）
- **WHEN** 非授权主体访问回放
- **THEN** 返回 403（稳定 errorCode），并记录拒绝审计（deny 可追溯）

### Requirement: 回放操作可审计（V1）
- **WHEN** 调用 `/runs/:runId/replay`
- **THEN** 写审计事件 `resourceType=workflow, action=run.replay`
- **AND** outputDigest 仅包含摘要（例如 replayedRunId、stepCount、timelineCount）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

