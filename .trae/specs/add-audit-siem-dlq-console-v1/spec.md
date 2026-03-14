# 审计 SIEM 投递 DLQ 可观测与运维 V1 Spec

## Why
审计 SIEM Webhook 增量外送已具备 outbox 重试与 DLQ 落库，但治理控制台与 API 缺少对 DLQ 的查询与运维入口，导致投递失败后只能通过直连数据库排障，无法满足“可运营、可观测、可治理”的平台不变式要求。

V1 以最小能力闭环为目标：提供 DLQ 列表查询、单目的地清空与重投（requeue）能力，并在 `/gov/audit` 的 SIEM 区块提供可视化入口。

## What Changes
- API（审计域）新增 DLQ 运维接口：
  - `GET /audit/siem-destinations/:id/dlq?limit=50`
  - `POST /audit/siem-destinations/:id/dlq/clear`
  - `POST /audit/siem-destinations/:id/dlq/requeue`（把 DLQ 重新入 outbox，attempts 重置，便于重投）
- RBAC permissions（resourceType=`audit`）新增并可分配：
  - `siem.dlq.read`
  - `siem.dlq.write`
  - seed：默认绑定 admin
- 审计记录：
  - DLQ 查询/清空/重投 MUST 写入审计（resourceType=audit，action=siem.dlq.*）
- 控制台（治理审计页 `/gov/audit`）扩展 SIEM 区块：
  - 在每个 destination 行提供 “DLQ” 按钮进入列表（弹出/内联均可）
  - 提供 “Clear / Requeue” 操作并展示结果摘要（errorCode/message/traceId）
- WEB_E2E：smoke 校验 SIEM 区块包含 DLQ 文案入口（不要求真实重投）

## Impact
- Affected specs:
  - 审计域（外送可运营、可观测）
  - 认证与授权（RBAC 权限目录扩展）
  - 治理控制面（控制台运维入口）
- Affected code:
  - API：`apps/api/src/routes/audit.ts`、`apps/api/src/modules/audit/siemRepo.ts`、`apps/api/src/cli/seed.ts`
  - Web：`apps/web/src/app/gov/audit/ui.tsx`、`apps/web/src/locales/{zh-CN,en-US}.json`、`apps/web/scripts/e2e-console-mode.mjs`

## ADDED Requirements

### Requirement: AuditSiemDlqApiV1
系统 SHALL 提供 DLQ 运维 API：
- **WHEN** 调用 `GET /audit/siem-destinations/:id/dlq`
- **THEN** 返回该 destination 的 DLQ 条目列表（最小字段：eventId/eventTs/attempts/createdAt/lastErrorDigest）
- **WHEN** 调用 `POST /audit/siem-destinations/:id/dlq/clear`
- **THEN** 清空该 destination 的 DLQ，并返回清理条数
- **WHEN** 调用 `POST /audit/siem-destinations/:id/dlq/requeue`
- **THEN** 将 DLQ 条目重新入 outbox（幂等处理），并返回 requeue 条数

### Requirement: AuditSiemDlqRbacV1
系统 SHALL 以最小权限开放 DLQ 运维：
- `siem.dlq.read` 控制 DLQ 查询
- `siem.dlq.write` 控制 DLQ 清空/重投
- seed 后 admin 角色默认拥有上述权限

### Requirement: GovAuditSiemDlqUiV1
系统 SHALL 在 `/gov/audit` 的 SIEM 区块提供 DLQ 可视化运维入口：
- **WHEN** 用户点击 DLQ
- **THEN** 页面调用 DLQ list API 并展示条目
- **WHEN** 用户点击 Clear/Requeue
- **THEN** 页面调用相应 API 并展示结果摘要

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

