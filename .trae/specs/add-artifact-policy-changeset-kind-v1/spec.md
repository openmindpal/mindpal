# ArtifactPolicy Changeset Kind（artifact_policy.upsert）V1 Spec

## Why
《架构设计.md》与《架构-16-治理控制面》强调：治理变更必须可审计、可预检、可灰度、可回滚；客户端不可信，策略变更应通过统一的治理变更链路（ChangeSet）发布，而不是直接写表。

当前 ArtifactPolicy 已支持直连治理 API（GET/PUT）并已接入执行链路（token 签发与水印响应头按策略生效），但缺少 ChangeSet 变更项（kind）：
- 无法在变更集里统一管理 ArtifactPolicy 变更、审批、预检与回滚；
- 无法在治理控制面形成“变更 → 预检 → 发布 → 回滚”的标准闭环。

V1 以最小方式落地：新增 `artifact_policy.upsert` kind，让 ArtifactPolicy 变更可进入 ChangeSet 的 preflight/release/rollback 链路；不引入 canary/promote 复杂度（后续版本再补）。

## What Changes
- 后端新增 ChangeSet item kind：`artifact_policy.upsert`
  - 支持对 `artifact_policies` 表执行 upsert
  - preflight 提供 currentStateDigest/plan/rollbackPreview
  - release 生效并记录 rollback_data
  - rollback 按 rollback_data 恢复/删除
- 前端变更集详情页支持新增该 kind（表单输入）
- e2e：覆盖 changeset 发布/回滚对 ArtifactPolicy 的影响

## Impact
- Affected specs:
  - 治理控制面（ChangeSet 扩展点）
  - 安全中枢（ArtifactPolicy 的可治理发布闭环）
- Affected code:
  - API：`apps/api/src/modules/governance/changeSetRepo.ts`
  - API：`apps/api/src/routes/governance.ts`
  - Web：`apps/web/src/app/gov/changesets/[id]/ui.tsx`
  - Tests：`apps/api/src/__tests__/e2e.test.ts`

## ADDED Requirements

### Requirement: ArtifactPolicyChangeSetKindV1
系统 SHALL 支持在治理变更集中新增条目：
- `kind = "artifact_policy.upsert"`
- payload（V1 最小集合）：
  - `scopeType: "tenant" | "space"`
  - `scopeId: string`（V1 明确指定；不隐式继承 changeset scope）
  - `downloadTokenExpiresInSec: number`（1..3600）
  - `downloadTokenMaxUses: number`（1..10）
  - `watermarkHeadersEnabled: boolean`

#### Scenario: Preflight 展示可回滚信息
- **WHEN** 对包含 `artifact_policy.upsert` 的 changeset 执行 preflight
- **THEN** preflight MUST 输出：
  - `currentStateDigest`：是否已存在策略 + 旧值摘要
  - `plan`：将要 upsert 的新值摘要
  - `rollbackPreview`：若发布后回滚，恢复旧值或删除策略的预览

#### Scenario: Release 生效并可回滚
- **WHEN** 发布包含 `artifact_policy.upsert` 的 changeset
- **THEN** 系统 MUST 对目标 scope 执行 upsert
- **AND** MUST 记录 rollback_data（包含旧值或“原本不存在”的标记）
- **WHEN** 对该 changeset 执行 rollback
- **THEN** 系统 MUST 按 rollback_data 恢复旧值或删除策略

### Requirement: ChangeSetItemValidationForArtifactPolicyV1
- **WHEN** 保存或发布 changeset item
- **THEN** 系统 MUST 校验 payload 边界（expires/maxUses/scopeType/scopeId）
- **AND** 对未知 kind MUST 拒绝（保持既有行为）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

