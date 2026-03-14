# RBAC 管理 UI（V1）Spec

## Why
目前 RBAC 管理 API（Role/Permission/Binding）已具备，但治理者缺少可操作的 Web 界面来完成“创建角色 → 授权 → 绑定到主体/空间”的闭环；这与《架构设计.md》里“治理控制面”要求不匹配，且降低可运营性与可审计变更效率。

## What Changes
- 新增 Web 治理页面（V1）：`/admin/rbac`
  - Role：创建/列表/查看详情
  - Permission：列表（可过滤 resourceType/action）
  - RolePermission：对指定 role grant/revoke
  - RoleBinding：创建/删除绑定（tenant/space scope）
- 最小信息架构（V1）
  - 从 `/admin/ui` 或首页提供入口链接（不要求导航生成）
- 错误与审计展示（V1）
  - UI 对 API 返回的 `errorCode/message/traceId` 进行展示，便于按 traceId 在审计中定位

## Impact
- Affected specs: 认证与授权（RBAC 管理）、治理控制面（Admin UI）
- Affected code:
  - Web：新增 admin/rbac 页面与组件
  - API：不新增接口（复用现有 `/rbac/*`）

## ADDED Requirements

### Requirement: RBAC 管理页面（V1）
系统 SHALL 提供 RBAC 管理页面 `GET /admin/rbac`，允许具备治理权限的主体完成 RBAC 配置：
- 仅当调用者拥有 `rbac.manage` 权限时可用
- UI 仅通过平台 API 操作 RBAC，不允许旁路写 DB

#### Scenario: 创建角色（成功）
- **WHEN** 治理者在页面输入 roleName 并提交
- **THEN** 系统调用 `POST /rbac/roles`
- **AND** UI 展示新角色并可进入详情页

#### Scenario: 授权与撤销（成功）
- **WHEN** 治理者在角色详情页选择 resourceType/action 并点击 grant
- **THEN** 系统调用 `POST /rbac/roles/:roleId/permissions`
- **WHEN** 点击 revoke
- **THEN** 系统调用 `DELETE /rbac/roles/:roleId/permissions`

#### Scenario: 绑定到主体（成功）
- **WHEN** 治理者填写 subjectId/roleId/scopeType/scopeId 并提交
- **THEN** 系统调用 `POST /rbac/bindings`
- **AND** UI 展示 bindingId，并允许删除

#### Scenario: 无权限访问（失败）
- **WHEN** 无治理权限主体访问 `/admin/rbac` 或执行任何 RBAC 操作
- **THEN** UI 展示错误（含 errorCode 与 traceId），且不显示敏感信息

### Requirement: 可观测错误呈现（V1）
系统 SHALL 在 UI 中展示后端错误信息的可定位字段：
- errorCode
- message（按 locale 渲染）
- traceId

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

