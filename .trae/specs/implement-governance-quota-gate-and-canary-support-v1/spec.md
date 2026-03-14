# 治理发布流水线：Quota Gate 落地 + ChangeSet Canary 覆盖扩展 V1 Spec

## Why
当前治理发布流水线（pipeline）里 `quota` gate 仍为 `not_implemented`，导致发布前无法得到“配额/并发/预算”相关的可解释闸门摘要。同时 ChangeSet 的 canary 模式对部分 item.kind（例如 `model_*`、`tool_limits.*`）直接告警并在 release 阶段拒绝，限制了安全灰度发布能力。

## What Changes
- 实现治理发布流水线的 `quota` gate：
  - pipeline 返回 `quota` gate 的稳定 `status`（pass/warn/fail）与 `detailsDigest`，不再返回 `not_implemented`
  - `detailsDigest` 只包含摘要信息（计数/sha256_8/少量示例），避免泄露敏感或过长内容
- 扩展 ChangeSet canary 模式对以下 item.kind 的支持：
  - `model_routing.upsert` / `model_routing.disable`
  - `model_limits.set`（仅当 `scopeType=space` 且 `scopeId` 属于 canaryTargets）
  - `tool_limits.set`
- 为实现上述 canary 能力，新增“空间级覆盖（override）”存储，并在运行时读取“effective 配置”：
  - 对模型路由（routing policy）支持按 `spaceId` 覆盖 tenant 默认
  - 对工具默认并发（tool limits）支持按 `spaceId` 覆盖 tenant 默认
  - 模型 RPM 配额（quota limits）保持既有 `scope_type/scope_id` 语义；canary 仅支持 space scope
- 调整 preflight/warnings 与 release 行为：
  - canary 模式下，上述支持的 kind 不再产生 `mode:canary_not_supported_for_items` 警告
  - 仍不支持 canary 的 item.kind（例如 `artifact_policy.*` / `ui.*` / `policy.*` 或 `model_limits.set` 的 tenant scope）保持原行为：preflight 给出 warnings，release 返回稳定错误码 `CHANGESET_MODE_NOT_SUPPORTED`

## Impact
- Affected specs: 治理控制面（ChangeSet preflight/release/promote/rollback/pipeline）、模型网关（路由/配额/预算）、工具执行资源治理（并发限制）
- Affected code:
  - API：`apps/api/src/routes/governance.ts`（pipeline 的 quota gate 输出）
  - API：`apps/api/src/modules/governance/changeSetRepo.ts`（preflight/release/promote/rollback 的 canary 扩展与 gate 计算）
  - API：`apps/api/src/modules/governance/limitsRepo.ts`（扩展为支持 space override 的读写接口，或新增对应 repo）
  - API：`apps/api/src/modules/modelGateway/*`（读取 effective routing/quotas 的逻辑）
  - DB：新增 migrations（routing/tool limits 的 space override 表）
  - Tests：API e2e（canary + promote + rollback + pipeline gate）

## ADDED Requirements
### Requirement: Pipeline 输出可解释的 Quota Gate
系统 SHALL 在治理发布流水线（pipeline）返回中输出 `gateType="quota"` 的可解释结果，不得再返回 `not_implemented`。

#### Scenario: Pipeline 读取
- **WHEN** 管理者调用 `GET /governance/changesets/:id/pipeline`
- **THEN** 返回的 `gates[]` 中 `gateType="quota"` 的 `status` 为 `pass|warn|fail`
- **AND** `detailsDigest` 至少包含：受影响 scope 计数、缺失配置计数、摘要 hash（sha256_8）

### Requirement: Canary 支持 model_routing 与 tool_limits 配置变更
系统 SHALL 支持在 `mode=canary` 的 preflight/release/promote/rollback 中处理以下 ChangeSet items：
- `model_routing.upsert` / `model_routing.disable`
- `tool_limits.set`

#### Scenario: Canary 预检不再告警
- **WHEN** ChangeSet 仅包含上述可 canary 的 items，并指定 `canaryTargets`
- **AND** 管理者以 `mode=canary` 触发 preflight
- **THEN** warnings 不包含 `mode:canary_not_supported_for_items`
- **AND** plan/currentStateDigest/rollbackPreview 显示针对每个 canary target space 的动作摘要

#### Scenario: Canary 发布仅影响目标空间
- **WHEN** 管理者对该 ChangeSet 执行 `release?mode=canary`
- **THEN** 系统仅对 canaryTargets 指定的 space 生效（通过 space override 存储）
- **AND** 未在 canaryTargets 内的 space 的 effective 配置保持不变

#### Scenario: Promote 使全量生效并清理 canary 覆盖
- **WHEN** canary 已发布且管理者执行 promote
- **THEN** 系统将变更应用到 ChangeSet scope（通常为 tenant）
- **AND** 清理 canaryTargets 下的 override（避免长期双轨）

### Requirement: Canary 支持 model_limits.set（仅 space scope）
系统 SHALL 在 canary 模式下支持 `model_limits.set`，但仅当其 `scopeType=space` 且 `scopeId` 属于 canaryTargets。

#### Scenario: Canary 模式拒绝 tenant scope 的 model_limits.set
- **WHEN** ChangeSet 包含 `model_limits.set` 且 `scopeType=tenant`
- **AND** 管理者以 `mode=canary` 执行 release
- **THEN** 系统返回稳定错误码 `CHANGESET_MODE_NOT_SUPPORTED`

## MODIFIED Requirements
### Requirement: ChangeSet Canary 支持范围扩展
系统 SHALL 扩展 canary 模式的支持范围，使 `model_routing.*`、`model_limits.set(space)`、`tool_limits.set` 可在 canaryTargets 维度生效，并保持 promote/rollback 语义与审计一致。

## REMOVED Requirements
无
