# Skill Runtime Remote 后端部署依赖（force remote 无 runner 拒绝）V1 Spec

## Why
Skill Runtime 支持 remote 后端，但在部署/配置缺失（未配置 runner 且强制 remote）时，如果不明确拒绝，会导致执行行为不确定（隐式回退、隐式失败或难以排障），影响生产可控性与治理可解释性。

## What Changes
- 明确 remote 后端的“部署依赖”与配置来源优先级（env endpoint override vs. DB runner registry）
- 当 `SKILL_RUNTIME_BACKEND=remote`（强制 remote）且未配置任何可用 runner 时，Worker 必须拒绝执行并返回稳定错误码
- 将该拒绝行为纳入测试覆盖与 checklist 校验

## Impact
- Affected specs:
  - Skill Runtime（remote 后端选择策略、降级策略）
  - Governance（runner registry 的部署前置条件）
- Affected code:
  - Worker：`apps/worker/src/workflow/processor/dynamicSkill.ts`
  - Worker：`apps/worker/src/workflow/processor/processStep.ts`（错误分类与写入 step/job/run）
  - Worker tests：`apps/worker/src/__tests__/processor.test.ts`（或新增专用测试文件）

## ADDED Requirements
### Requirement: Remote 后端配置优先级
系统 SHALL 按如下优先级解析 remote runner 配置：
1) `SKILL_RUNTIME_REMOTE_ENDPOINT`（部署侧 endpoint override）
2) DB `skill_runtime_runners` 中 `enabled=true` 的最新 runner（租户隔离）

#### Scenario: 使用 endpoint override
- **WHEN** 设置了 `SKILL_RUNTIME_REMOTE_ENDPOINT`
- **THEN** 执行 remote 后端时使用该 endpoint
- **AND** 不依赖 DB runner registry

#### Scenario: 使用 runner registry
- **WHEN** 未设置 `SKILL_RUNTIME_REMOTE_ENDPOINT`
- **AND** DB 存在 `enabled=true` 的 runner
- **THEN** 执行 remote 后端时使用该 runner 的 endpoint（并按其 auth 配置鉴权）

### Requirement: 强制 remote 且未配置 runner 时拒绝
系统 SHALL 在强制 remote 且 remote runner 未配置时拒绝执行，不允许静默回退到 container/process。

#### Scenario: 强制 remote 且无 runner
- **WHEN** `SKILL_RUNTIME_BACKEND=remote`
- **AND** 未设置 `SKILL_RUNTIME_REMOTE_ENDPOINT`
- **AND** DB 中不存在任何 `enabled=true` 的 `skill_runtime_runners`
- **THEN** Worker MUST 失败并返回稳定错误码 `policy_violation:remote_runtime_not_configured`
- **AND** 该失败 MUST 被归类为 `policy_violation`

## MODIFIED Requirements
### Requirement: 动态 Skill 后端选择的“禁止降级”语义补齐
当后端选择被显式强制（例如 remote）且依赖配置缺失时，系统 SHALL 拒绝执行并提供可解释错误，而不是尝试其他后端。

## REMOVED Requirements
无
