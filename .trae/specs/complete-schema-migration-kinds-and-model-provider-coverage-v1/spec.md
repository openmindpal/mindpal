# Schema Migration Kind 覆盖补齐 + Model Gateway Provider 覆盖补齐 V1 Spec

## Why
当前 Schema 迁移执行器对不支持的 kind 会直接抛出 `migration_kind_not_supported`，导致迁移作业在 Worker 侧表现为失败/重试不可控且缺少稳定错误语义。同时 Model Gateway 在候选 provider 未实现时会触发 `PROVIDER_NOT_IMPLEMENTED`，影响路由候选的可用性与调试体验。

## What Changes
- Schema Migration
  - 统一“支持的 migration kind”白名单，并在 API 创建迁移与 Worker 执行迁移之间保持一致
  - 遇到不支持的 kind 时，Worker SHALL 将迁移 run 标记为失败并写入稳定错误摘要（非抛异常导致的重试风暴）
  - 明确迁移失败时对 `schema_migration_runs.last_error` 与审计输出的格式要求（不泄露敏感数据）
- Model Gateway
  - 补齐 `mock` provider 的 chat 执行实现，避免路由候选落到未实现 provider 时返回 `PROVIDER_NOT_IMPLEMENTED`
  - 当未来出现其他未实现 provider 时，路由逻辑 SHALL 将其视为“可解释跳过原因”并继续尝试其他候选；仅当所有候选均不可用时返回稳定错误

## Impact
- Affected specs:
  - Governance / Schema Migration（迁移执行语义、失败语义、可观测性）
  - Model Gateway（provider 覆盖、路由候选降级策略）
- Affected code:
  - Worker：`apps/worker/src/workflow/processor/schemaMigration.ts`、`apps/worker/src/workflow/processor/jobHandlers.ts`
  - API：`apps/api/src/routes/governance.ts`（迁移创建 kind 校验）
  - API：`apps/api/src/routes/models.ts`、`apps/api/src/modules/modelGateway/catalog.ts`（provider 路由执行）
  - API：`apps/api/src/lib/errors.ts`（错误语义复用/对齐）

## ADDED Requirements
### Requirement: Unsupported Schema Migration Kind 的稳定失败语义
系统 SHALL 在执行 Schema Migration 时，对不支持的 `kind` 以“稳定失败”结束迁移 run，而不是抛出未捕获异常导致重复重试。

#### Scenario: Worker 执行遇到不支持的 kind
- **WHEN** Worker 执行某个 schema migration，且 `mig.kind` 不在支持列表中
- **THEN** `schema_migration_runs.status` MUST 变为 `failed`
- **AND** `schema_migration_runs.last_error` MUST 以稳定错误码表达（例如 `MIGRATION_KIND_NOT_SUPPORTED:<kind>`）
- **AND** 该 step/job/run MUST 被标记为失败且不再重试（由实现选择“吞掉异常并完成失败落库”或“抛出非 retryable 错误”，但行为必须可验证且稳定）

### Requirement: Supported Schema Migration Kinds 的一致性
系统 SHALL 保证 API 允许创建的迁移 kind 与 Worker 支持执行的 kind 一致。

#### Scenario: API 拒绝不支持的 kind
- **WHEN** 调用治理接口创建 schema migration，且 kind 不在支持列表
- **THEN** 返回稳定错误（400）并包含可解释消息

### Requirement: Mock Provider 的 chat 可执行
系统 SHALL 支持 `mock` provider 的 chat 执行，以保证候选 provider 覆盖完整。

#### Scenario: mock provider 正常响应
- **WHEN** `/models/chat` 选择到 `mock` provider 的 candidate
- **THEN** 返回 `outputText`（可为回显/固定模板），并写入审计 attempts
- **AND** 不返回 `PROVIDER_NOT_IMPLEMENTED`

### Requirement: 未实现 provider 的降级策略
系统 SHALL 将“未实现 provider”作为可解释跳过原因并继续尝试其他候选；仅当所有候选均不可用时返回稳定错误。

#### Scenario: 部分候选未实现但存在可用候选
- **WHEN** 路由候选中包含未实现 provider
- **AND** 存在至少一个已实现 provider 且成功
- **THEN** 请求整体成功，未实现 provider 的候选被记录为 skipped/error（稳定 reason）

## MODIFIED Requirements
### Requirement: Schema Migration 执行失败的可观测性
系统 SHALL 在迁移失败时提供稳定的失败摘要（error code + minimal context），用于治理侧排障与审计追溯。

## REMOVED Requirements
无
