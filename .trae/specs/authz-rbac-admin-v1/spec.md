# 认证与授权：RBAC 管理与 Policy Snapshot V1 Spec

## Why
《架构-05》要求授权决策具备“可解释 + 可审计 + 可回放一致性”的契约输出，并以 RBAC（资源级）作为起步模型。当前系统虽已有 RBAC 表结构与 authorize() 计算，但缺少可运营的“角色/权限/绑定”管理入口与 Policy Snapshot 的可追溯存储，导致权限只能靠 seed，且回放/合规链路不完整。

## What Changes
- RBAC 管理 API（V1）：
  - Role：创建/列表/查看（tenant 级）
  - Permission：注册/列表（资源+动作）
  - RolePermission：为角色授予权限
  - RoleBinding：将角色绑定到 subject（tenant/space scope）
- Policy Snapshot 存储（V1）：
  - 将每次 allow/deny 的决策摘要与命中规则写入 policy_snapshots
  - snapshotRef 统一引用 snapshotId（或可复用的 digestRef）
- 审计对齐（V1）：
  - RBAC 变更与授权决策写审计（仅摘要，不写敏感原文）

## Impact
- Affected specs:
  - 认证与授权（AuthZ，RBAC 起步）
  - 审计域（权限变更与决策审计）
  - 数据平面/工具化（所有读写依赖 requirePermission 的决策输出）
- Affected code:
  - DB：新增 policy_snapshots 表；可能新增约束/索引
  - API：新增 /rbac/* 或等价管理路由
  - AuthZ：authorize() 返回 snapshotRef 绑定到存储的 snapshot

## ADDED Requirements

### Requirement: RBAC 管理 API（V1）
系统 SHALL 提供 RBAC 管理接口，用于运营化配置授权策略（资源级）。

最小对象（V1）：
- Role：{ id, tenantId, name }
- Permission：{ resourceType, action }
- RolePermission：{ roleId, permissionId }
- RoleBinding：{ subjectId, roleId, scopeType, scopeId }

约束（V1）：
- Role 与 RoleBinding 的 tenantId MUST 与 subject.tenantId 一致
- RoleBinding 的 scopeType 仅允许：tenant/space
- Permission 的 resourceType/action 支持 `*` 通配
- RBAC 变更 MUST 写审计（resourceType=rbac, action=...）

#### Scenario: 创建角色并授权
- **WHEN** 管理员创建 role 并为其绑定 permissions
- **THEN** 后续 authorize() 对命中权限的请求返回 allow
- **AND** 审计记录包含 roleId/permission 摘要

### Requirement: Policy Snapshot（V1）
系统 SHALL 为授权决策生成可引用的 Policy Snapshot，并在审计与回放中使用 snapshotRef。

最小字段（V1）：
- snapshotId（UUID）
- tenantId、subjectId、spaceId（可选）
- resourceType、action
- decision（allow/deny）、reason（可解释）
- matchedRulesDigest（摘要）
- fieldRulesDigest、rowFiltersDigest（摘要，可为空）
- createdAt

约束（V1）：
- authorize() 返回的 snapshotRef MUST 可定位到一条 policy_snapshots 记录
- snapshot 内容 MUST 只保存摘要（不存敏感原文）

#### Scenario: deny 也可回放解释
- **WHEN** 请求被拒绝（deny）
- **THEN** snapshotRef 仍可定位到决策摘要与拒绝原因
- **AND** 审计记录中包含 snapshotRef

### Requirement: 授权决策审计对齐（V1）
系统 SHALL 对 RBAC 变更与关键授权决策写审计：
- RBAC 管理类：rbac.role.create / rbac.role.bind / rbac.role.grant 等
- 资源访问类：沿用现有 resourceType/action，并把 policyDecision.snapshotRef 写入审计

#### Scenario: 决策与审计串联
- **WHEN** API 通过 requirePermission 进行授权
- **THEN** 审计记录包含 policyDecision（含 snapshotRef 与 matchedRules 摘要）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

