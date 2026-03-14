# 审计 SIEM Destinations 权限与审计动作对齐 V1 Spec

## Why
审计 SIEM Webhook 外送已落地（destinations API + worker 投递），并在控制台提供了管理入口。但该能力需要一组清晰、可分配的 RBAC 权限，否则在实际租户/空间中无法按最小权限原则安全开放给运维人员。

此外，当前部分 SIEM destinations API 的审计 action 命名与实际鉴权 action 不一致，容易造成“审计里看起来做了 create/update，但权限检查是 write”的语义分裂，不利于合规追溯与策略解释。

## What Changes
- 新增 SIEM destinations 的 RBAC permissions（精确 action，不依赖 `xxx.*` 前缀匹配）：
  - resourceType=`audit`
  - actions：
    - `siem.destination.read`
    - `siem.destination.write`
    - `siem.destination.test`
    - `siem.destination.backfill`
- seed：在初始化时写入上述 permissions，并为 admin 角色绑定（与现有 seed 习惯一致）
- 审计动作对齐：SIEM destinations API 的审计 action 与鉴权 action 对齐（read/write/test/backfill），保持可解释性一致
- 回归：api e2e 仍通过（不修改既有业务语义）

## Impact
- Affected specs:
  - 审计域（审计外送能力可按最小权限开放）
  - 认证与授权（RBAC 权限目录完整）
- Affected code:
  - API：`apps/api/src/cli/seed.ts`
  - API：`apps/api/src/routes/audit.ts`
  - Tests：`apps/api/src/__tests__/e2e.test.ts`（如需更新断言或 trace）

## ADDED Requirements

### Requirement: AuditSiemDestinationPermissionsV1
系统 SHALL 提供并可分配以下 permissions（resourceType=`audit`）：
- `siem.destination.read`
- `siem.destination.write`
- `siem.destination.test`
- `siem.destination.backfill`

#### Scenario: 默认可用
- **WHEN** 执行 seed 初始化
- **THEN** 上述 permissions MUST 存在于 `permissions` 表
- **AND** admin 角色 MUST 默认拥有上述 permissions

### Requirement: AuditActionConsistencyForSiemV1
- **WHEN** 调用 SIEM destinations 相关 API
- **THEN** 审计事件的 `action` MUST 与鉴权 action 一致（read/write/test/backfill）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

