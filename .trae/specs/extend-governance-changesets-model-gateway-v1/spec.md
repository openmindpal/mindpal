# 治理控制面：将模型网关配置纳入 ChangeSet 发布回滚 V1 Spec

## Why
《架构设计.md》要求治理模式下的“发布与回滚”覆盖关键治理配置。当前模型网关的路由策略、RPM 配额与工具默认并发配置可直接修改，但缺少“变更集”式发布、审计化的变更计划与可一键回滚的机制。

## What Changes
- 扩展 ChangeSet Item 种类，支持把模型网关相关配置作为变更项提交、审批、发布与回滚：
  - `model_routing.upsert`：按 purpose 写入/更新 routing policy
  - `model_routing.disable`：按 purpose 禁用 routing policy
  - `model_limits.set`：按 scope 设置 `modelChatRpm`
  - `tool_limits.set`：按 toolRef 设置 `defaultMaxConcurrency`
- 扩展 ChangeSet preflight 输出：
  - `plan`：将要执行的动作清单（包含目标 scope、purpose/toolRef）
  - `currentStateDigest`：当前状态摘要（用于人工审阅）
  - `rollbackPreview`：回滚预览动作（可解释）
- 扩展 ChangeSet release/rollback 执行器：
  - release 时对 DB 配置表执行变更
  - rollback 时按 `rollback_data` 记录恢复到发布前状态
- Web 治理台 ChangeSet 详情页支持添加上述新 kind 的 items（表单校验 + 错误模型一致展示）
- **约束（V1）**：含 `model_*` / `tool_limits.*` item 的 ChangeSet 不支持 canary 模式（preflight 给出 warning；release 在 canary 模式下拒绝）

## Impact
- Affected specs:
  - 治理控制面（ChangeSet：发布/回滚/预检）
  - 模型网关（路由/配额配置变更治理）
- Affected code:
  - API：`apps/api/src/modules/governance/changeSetRepo.ts`（扩展 kind、preflight、release、rollback）
  - API：`apps/api/src/routes/governance.ts`（items 入参校验与 kind 白名单）
  - Web：`apps/web/src/app/gov/changesets/[id]/ui.tsx`（新增 itemKind 与表单）
  - DB：复用既有 `routing_policies / quota_limits / tool_limits` 表；不新增表

## ADDED Requirements
### Requirement: ChangeSet 支持模型网关配置项
系统 SHALL 支持在 ChangeSet 内添加以下配置项并参与提交/审批/发布/回滚流程：
- `model_routing.upsert`：payload 包含 `purpose`、`primaryModelRef`、`fallbackModelRefs[]`、`enabled`
- `model_routing.disable`：payload 包含 `purpose`
- `model_limits.set`：payload 包含 `scopeType`、`scopeId`、`modelChatRpm`
- `tool_limits.set`：payload 包含 `toolRef`、`defaultMaxConcurrency`

#### Scenario: 添加模型路由策略变更项
- **WHEN** 管理者在某 ChangeSet 详情页选择 `model_routing.upsert` 并提交 payload
- **THEN** 系统写入 changeset item（status=draft 才允许）
- **AND** changeset detail 返回包含该 item

### Requirement: Preflight 输出可解释的计划与回滚预览
系统 SHALL 在 preflight 中输出：
- `plan`：将执行的动作摘要（不含 secrets/prompts）
- `currentStateDigest`：变更前状态摘要
- `rollbackPreview`：可用于回滚的动作摘要

#### Scenario: 发布前预检
- **WHEN** 管理者触发 preflight
- **THEN** 返回包含上述 3 类摘要字段

### Requirement: 发布与回滚覆盖模型网关配置（V1）
系统 SHALL 在 ChangeSet release/rollback 中对模型网关配置执行原子化更新：
- release：按 items 顺序应用变更并写入 `rollback_data`
- rollback：根据 `rollback_data` 恢复到发布前状态（幂等）

#### Scenario: 发布后回滚
- **WHEN** 已发布的 ChangeSet 被执行 rollback
- **THEN** 相关 routing policy / rpm / tool 并发配置恢复到发布前

### Requirement: Canaray 模式限制（V1）
系统 SHALL 对包含 `model_routing.*` / `model_limits.*` / `tool_limits.*` 的 ChangeSet：
- preflight（mode=canary）返回 warnings 提示不支持
- release（mode=canary）返回稳定错误码（例如 `CHANGESET_MODE_NOT_SUPPORTED`）

## MODIFIED Requirements
### Requirement: ChangeSet Item 类型白名单扩展
系统 SHALL 扩展 ChangeSet item.kind 的允许值集合，并对 payload 做结构化校验；校验失败返回稳定错误码与 traceId。

## REMOVED Requirements
无

