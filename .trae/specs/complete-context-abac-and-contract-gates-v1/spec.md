# 上下文 ABAC 与统一 Contract Gate V1 Spec

## Why
当前授权体系以 RBAC + rowFilters/fieldRules 为主，已具备最小可用能力，但在“上下文 ABAC、稳定可解释契约、编译缓存治理”方面仍偏演进态；同时治理控制面对不同扩展点（Schema/Tool/Workflow/Policy 等）的版本化与准入覆盖不均衡，长期会产生一致性与可运营性风险。

## What Changes
- 引入 **Policy Contract V1**：对“策略定义/策略版本/发布状态/解释输出”给出稳定契约与错误码
- 扩展 ABAC：在授权评估中支持“上下文属性”（Subject/Space/Tenant/Request/Resource）并可被策略表达式引用
- 增加策略编译缓存：将策略表达式编译结果缓存，并通过 policy cache epoch 与版本号组合实现可控失效
- 统一治理准入：将“contract 版本化 + 兼容检查 + 发布准入”抽象为可复用 gate，并覆盖到更多扩展点（至少：Policy/Workflow；其余扩展点按可插拔方式纳入）

## Impact
- Affected specs: 认证与授权、治理控制面、工作流与自动化、数据平面查询与裁剪、审计与可解释性
- Affected code:
  - API：`apps/api/src/modules/auth/*`、`apps/api/src/modules/governance/*`、`apps/api/src/routes/governance.ts`、`apps/api/src/routes/rbac.ts`、`apps/api/src/routes/policySnapshots.ts`
  - Shared：`packages/shared/src/policyExpr.ts`
  - DB：新增/扩展与 policy 版本、编译缓存、gates 相关表结构与索引

## ADDED Requirements

### Requirement: Policy Contract V1
系统 SHALL 提供“策略定义与版本”的稳定资源模型，用于：发布治理、缓存失效、可解释审计与回放一致性。

#### Contract: PolicyRef
- `policyRef` SHALL 由 `name`（稳定标识）与 `version`（单调递增整数或语义版本）组成
- `policyRef` SHALL 可被 policy snapshot、changeset item、审计摘要引用

#### Contract: PolicyVersion State
- 策略版本 SHALL 具备状态：`draft | released | deprecated`
- 只有 `released` 版本 SHALL 参与默认授权评估（除非治理调试接口显式指定）

#### Scenario: 创建草稿版本
- **WHEN** 管理员提交策略草稿
- **THEN** 系统创建新的 `draft` policyVersion，并返回 `policyRef` 与 `digest`

#### Scenario: 发布版本
- **WHEN** 通过治理控制面发布 policyVersion
- **THEN** 系统对该版本执行兼容检查（见 Contract Compatibility Gate），通过后置为 `released` 并写审计

### Requirement: Contextual ABAC Evaluation
系统 SHALL 在授权评估时注入“上下文对象”，策略表达式可引用这些上下文字段实现 ABAC。

#### Context Object (minimum)
- Subject：`subject.id`、`subject.type`、`subject.roleIds`（或等价信息）
- Tenant/Space：`tenant.id`、`space.id?`
- Request：`request.method`、`request.path`、`request.traceId`
- Resource（可选）：`resource.type`、`resource.id?`、`resource.ownerSubjectId?`

#### Expression Rules
- 策略表达式 SHALL 只允许引用白名单字段（避免任意字段访问导致不稳定与信息泄露）
- 对未知字段/不支持操作符/类型不匹配 SHALL 产生稳定拒绝原因：`unsupported_policy_expr`

#### Scenario: 基于 owner 的行级访问
- **WHEN** 用户查询实体列表，且 rowFilters 使用 `resource.ownerSubjectId == subject.id`
- **THEN** 返回结果只包含 owner 匹配的记录，并在 policy snapshot explain 中体现“命中规则摘要”

### Requirement: Policy Compile Cache with Epoch
系统 SHALL 对策略表达式的“编译结果”做缓存，以提升一致性与性能，并可通过 epoch 统一失效。

#### Cache Key
- Cache Key SHALL 至少包含：`tenantId`、`spaceId?`、`policyRef`、`policyCacheEpoch`

#### Invalidation
- **WHEN** RBAC/Policy/相关授权规则发生变更或治理端触发 invalidate
- **THEN** policyCacheEpoch SHALL bump，旧缓存不再被命中

#### Scenario: 失效后生效
- **WHEN** 修改某 role 的 rowFilters 并 bump epoch
- **THEN** 下一次授权评估使用新编译结果，且 explain 中返回新的 `policyCacheEpoch`

### Requirement: Stable Policy Explain Contract V1
系统 SHALL 输出稳定、可序列化、可审计的 explain 结构，用于：调试、审计、回放与评测。

#### Explain Shape (minimum)
- `decision`: `allow | deny`
- `reasons[]`: 稳定枚举（例如 `missing_permission`、`row_filter_applied`、`field_rule_applied`、`unsupported_policy_expr`）
- `policyRef` 与 `policyCacheEpoch`
- `matchedRules[]`：仅摘要字段（ruleId/name/digest），不得包含敏感值

#### Scenario: 调试评估输出稳定
- **WHEN** 调用治理端策略调试 evaluate/explain
- **THEN** 输出字段结构与 reason 枚举稳定，且可用于 UI 展示与审计关联

### Requirement: Contract Compatibility Gate (Governance)
治理控制面 SHALL 将“兼容检查 + 发布准入”统一为 gate，并覆盖更多扩展点。

#### Gate Semantics
- 每一种扩展点 SHALL 定义自己的 `contractKind`（至少：`policy`、`workflow`）
- preflight SHALL 返回每个 item 的 `contractCheck` 摘要：`pass | fail | warn` + `errorCode` + `messageI18n` + `digest`
- release SHALL 在存在 `fail` 时拒绝，并返回稳定错误码（例如 `CONTRACT_NOT_COMPATIBLE`）

#### Scenario: 发布前兼容检查失败
- **WHEN** changeset 包含一个不兼容的 policyVersion（引用未知上下文字段/不支持操作符）
- **THEN** preflight 显示 fail 摘要；release 被拒绝且写审计

## MODIFIED Requirements

### Requirement: AuthZ Policy Snapshot
系统 SHALL 在授权评估完成后产出 policy snapshot，并引用稳定的 `policyRef`、`policyCacheEpoch` 与 explain contract v1（取代不稳定字段集合）。

## REMOVED Requirements

### Requirement: 无版本策略的隐式覆盖
**Reason**: 隐式覆盖不利于治理、回放与缓存一致性。
**Migration**: 现有 RBAC/rowFilters/fieldRules 写入时自动归并到默认 policyRef（如 `default@<version>`），并在发布时生成显式版本记录。 

