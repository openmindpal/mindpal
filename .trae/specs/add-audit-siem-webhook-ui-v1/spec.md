# 审计 SIEM Webhook 目的地控制台 UI V1 Spec

## Why
审计域已具备 SIEM Webhook 增量投递能力（destination/cursor/outbox + API），但治理控制台缺少可视化配置入口，导致运维只能通过 API/脚本管理，无法形成“配置 → 测试 → 启用 → 回放”的日常操作闭环。

## What Changes
- 在治理控制台审计页（`/gov/audit`）新增 “SIEM Webhook Destinations” 区块：
  - 列表：展示当前租户所有 destinations（name/enabled/batchSize/timeoutMs/updatedAt）
  - 创建：通过 `name + secretId` 创建 destination（默认 enabled=false，可手动启用）
  - 更新：支持启停、更新 batchSize/timeoutMs、替换 secretId
  - 测试：对指定 destination 执行 `POST /audit/siem-destinations/:id/test` 并展示结果
  - 回放：对指定 destination 执行 `POST /audit/siem-destinations/:id/backfill`（默认清空 outbox 并重置游标）
- i18n：补齐 zh-CN/en-US 文案（沿用现有 errorCode/message/traceId 展示）
- WEB_E2E：smoke 校验审计页包含 SIEM 区块（不要求真实投递）

## Impact
- Affected specs:
  - 审计域（外送能力可运营）
  - 治理控制面（控制台可配置）
- Affected code:
  - Web：`apps/web/src/app/gov/audit/ui.tsx`
  - Web：`apps/web/src/locales/{zh-CN,en-US}.json`
  - Web：`apps/web/scripts/e2e-console-mode.mjs`

## ADDED Requirements

### Requirement: GovAuditSiemDestinationsUiV1
系统 SHALL 在 `/gov/audit` 页面提供 SIEM Webhook Destinations 管理：
- **WHEN** 用户点击加载
- **THEN** 页面 MUST 调用 `GET /audit/siem-destinations` 并展示列表
- **WHEN** 用户填写 `name + secretId` 并提交创建
- **THEN** 页面 MUST 调用 `POST /audit/siem-destinations`
- **WHEN** 用户修改配置并保存
- **THEN** 页面 MUST 调用 `PUT /audit/siem-destinations`
- **WHEN** 用户点击测试
- **THEN** 页面 MUST 调用 `POST /audit/siem-destinations/:id/test` 并展示 ok/httpStatus/traceId
- **WHEN** 用户点击回放（backfill）
- **THEN** 页面 MUST 调用 `POST /audit/siem-destinations/:id/backfill` 并展示结果

### Requirement: GovAuditSiemSecretSafetyV1
- **THEN** 页面 MUST 不展示 webhookUrl 明文（仅使用 secretId 引用）
- **AND** 错误展示 MUST 使用 errorCode/message/traceId（与现有治理页面一致）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

