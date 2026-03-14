# 审计完整性校验（Hash Chain Verify）控制台与权限 V1 Spec

## Why
审计域已实现 append-only 与 hash chain（event_hash/prev_hash），并提供 `/audit/verify` 接口用于检测篡改/缺失。但目前缺少默认可用的 RBAC 权限与治理控制台入口，导致运维无法在不接触数据库的情况下进行“在线完整性自检”，不符合“可运营、可观测、可治理”的平台不变式。

## What Changes
- RBAC permissions：新增 `audit/verify` 并在 seed 中默认绑定 admin
- 控制台：在 `/gov/audit` 页面增加 “审计完整性校验” 区块
  - 支持填写可选参数 `from/to/limit`
  - 点击执行后调用 `GET /audit/verify` 并展示 ok/checkedCount/firstEventId/lastEventId/failures/lastEventHash
- WEB_E2E：smoke 校验审计页包含完整性校验区块
- 回归：api/web 测试通过

## Impact
- Affected specs:
  - 审计域（不可篡改校验可运营）
  - 认证与授权（RBAC 权限目录扩展）
  - 治理控制面（控制台入口）
- Affected code:
  - API：`apps/api/src/cli/seed.ts`
  - Web：`apps/web/src/app/gov/audit/ui.tsx`
  - Web：`apps/web/src/locales/{zh-CN,en-US}.json`
  - Web：`apps/web/scripts/e2e-console-mode.mjs`
  - Tests：`apps/api/src/__tests__/e2e.test.ts`

## ADDED Requirements

### Requirement: AuditVerifyPermissionV1
系统 SHALL 提供并可分配 permission：
- resourceType=`audit`
- action=`verify`

#### Scenario: 默认可用
- **WHEN** 执行 seed 初始化
- **THEN** `audit/verify` MUST 存在于 `permissions` 表
- **AND** admin 角色 MUST 默认拥有该 permission

### Requirement: GovAuditVerifyUiV1
系统 SHALL 在 `/gov/audit` 页面提供审计完整性校验入口：
- **WHEN** 用户点击执行
- **THEN** 页面 MUST 调用 `GET /audit/verify`（可选 query：from/to/limit）
- **AND** MUST 展示返回的 ok/checkedCount/failures/lastEventHash 等摘要

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

