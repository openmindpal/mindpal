# 修复审计 outputDigest 覆盖问题 V1 Spec

## Why
《架构设计.md》要求审计事件可追溯且可解释；业务路由侧会写入 `req.ctx.audit.outputDigest` 以记录关键摘要（例如 artifactId、tokenId、执行状态等），但当前审计插件在 `onSend` 钩子里会无条件把 `outputDigest` 覆盖为 `{ length }`，导致关键摘要无法落库，破坏可追溯性，也使得安全中枢相关能力（产物下载 token、水印/来源标识等）的审计无法可靠实现。

因此需要调整审计插件的 outputDigest 写入策略：**仅在业务未写 outputDigest 时补充长度摘要；若业务已写则 merge（追加 length 而不覆盖）**。

## What Changes
- 审计插件（V1）：
  - `onSend` 不再无条件覆盖 `req.ctx.audit.outputDigest`
  - 行为变更为：
    - 若 `outputDigest` 为空：写入 `{ length }`
    - 若 `outputDigest` 已存在：追加 `length` 字段（若已有 length 则保持业务侧值）
- 回归测试（V1）：
  - e2e：断言 artifact token 下载/签发相关审计事件的 `output_digest` 包含 `artifactId/tokenId`（不被覆盖）

## Impact
- Affected specs:
  - 审计域（outputDigest 作为统一摘要入口）
  - 安全中枢（下载/导出/回放/水印等依赖审计摘要）
- Affected code:
  - API：`apps/api/src/plugins/audit.ts`
  - Tests：`apps/api/src/__tests__/e2e.test.ts`

## ADDED Requirements

### Requirement: AuditOutputDigestMergeV1
- **WHEN** 路由侧设置了 `req.ctx.audit.outputDigest`
- **THEN** 审计插件 MUST 不覆盖该对象
- **AND** 审计插件 MAY 追加 `length` 字段用于记录响应体长度摘要

#### Scenario: 路由侧未设置 outputDigest
- **WHEN** `req.ctx.audit.outputDigest` 为空
- **THEN** 审计插件 SHALL 写入 `{ length }` 作为默认输出摘要

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

