# AuthN PAT + Sync 写入链路加固 Spec

## Why
当前平台的统一请求链路主干已成型，但仍存在两类高风险缺口：生产级可撤销鉴权（避免共享固定 token）与 Sync 写入可能绕开数据面校验/字段级授权，二者都会削弱“唯一写入口/审计不可跳过/策略先于执行”的平台不变式。

## What Changes
- 新增“可撤销的个人访问令牌（PAT）”鉴权模式：令牌可创建/列出/撤销，撤销立即生效，并全链路写审计
- 加固 `sync.push` 写入链路：对每个 op 强制执行 Schema 校验、字段级写规则与实体写权限（含行级约束），并输出可解释拒绝/冲突摘要
- **BREAKING**（受控）：当 `AUTHN_MODE=pat` 时，不再接受 dev token/hmac token 作为有效鉴权（可通过配置选择保留兼容窗口）

## Impact
- Affected specs: 认证与授权（AuthN/AuthZ）、数据平面（通用 CRUD/校验/字段规则）、离线同步（Sync）、审计域（Audit）
- Affected code:
  - API：`apps/api/src/modules/auth/*`、`apps/api/src/routes/sync.ts`、`apps/api/src/routes/*auth*`（新增）、`apps/api/migrations/*`
  - RBAC：permissions/role_permissions 的 seed 或迁移（如需要新增资源动作）
  - Tests：`apps/api/src/__tests__/*`（新增 e2e/单测）

## ADDED Requirements

### Requirement: Personal Access Token (PAT)
系统 SHALL 提供可撤销的 Personal Access Token（PAT），用于生产环境鉴权，避免共享固定管理员 token。

#### Scenario: 创建 PAT（成功）
- **WHEN** 已认证主体调用创建 PAT 接口并提供名称（可选）与过期时间（可选）
- **THEN** 系统返回一次性明文 token（仅本次可见），并持久化其哈希与元数据
- **AND** 审计记录包含：subject/tenant/space、action=auth.token.create、tokenId、expiresAt 摘要（不包含 token 明文）

#### Scenario: 使用 PAT（成功）
- **WHEN** 客户端以 `Authorization: Bearer <pat>` 访问任意受保护 API
- **THEN** 系统根据 token 哈希查找到 subject/tenant/space 并建立请求上下文
- **AND** 若 token 绑定了 space，则请求上下文的 space 固定为该 space（客户端 header 不可覆盖）

#### Scenario: 使用 PAT（拒绝）
- **WHEN** token 不存在 / 已撤销 / 已过期
- **THEN** 返回 401（错误码稳定），且不泄露 token 是否存在

#### Scenario: 撤销 PAT（成功）
- **WHEN** token 创建者（或具备治理权限者）撤销该 token
- **THEN** token 立即失效，后续请求使用该 token 均返回 401
- **AND** 撤销动作写审计（action=auth.token.revoke）

### Requirement: PAT 权限与隔离
系统 SHALL 将 PAT 管理能力纳入 RBAC。

#### Scenario: 仅能管理自己的 token（默认）
- **WHEN** 普通用户列出 token
- **THEN** 仅返回归属该 subject 的 token 元数据（不返回 token 明文）

#### Scenario: 治理角色可查看/撤销 space 范围内 token（可选）
- **WHEN** 具备治理权限者在指定 scope 下操作 token
- **THEN** 系统按 scope 隔离与 RBAC 决策放行或拒绝，并写审计

## MODIFIED Requirements

### Requirement: AuthN（生产模式）
当 `AUTHN_MODE=pat` 时：
- 系统 SHALL 仅接受 PAT 作为有效鉴权凭据
- 系统 SHALL 在鉴权阶段完成 token 吊销/过期校验
- 系统 SHALL 保持现有 traceId/requestId/locale 与审计链路行为不变

### Requirement: Sync Push（写入必须受控）
系统 SHALL 在 `sync.push` 中对每个 op 强制执行与数据面一致的护栏：
- 参数校验：op 结构合法，schemaName/entityName/recordId/patch 必填且类型正确
- Schema 校验：patch 中字段必须存在且类型匹配（至少覆盖 string/number/boolean/object/array/null 的基础一致性）
- 字段级写规则：对不可写字段必须拒绝或裁剪（策略可配置；默认拒绝并返回可解释原因摘要）
- 实体写权限：根据 record 是否存在映射为 entity.create 或 entity.update，并执行 AuthZ 决策
- 行级约束：若决策包含写入 rowFilters，则必须在写入前强制验证（例如 owner_only / payload_field_eq_*）
- 审计：请求级审计必须包含批次摘要（opCount、accepted/rejected/conflicts 计数、deterministic digest），不得包含 patch 明文

## REMOVED Requirements
无

