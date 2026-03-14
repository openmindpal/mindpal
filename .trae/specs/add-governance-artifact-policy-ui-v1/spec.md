# ArtifactPolicy 治理控制台 UI V1 Spec

## Why
《架构设计.md》与《架构-12-安全中枢》要求：数据产物（artifact）的下载令牌参数、次数限制与水印策略需“可治理、可审计、可回滚”，并且策略应由服务端下发而非由客户端任意指定。

目前后端已提供 ArtifactPolicy 的治理 API（GET/PUT），但治理控制台缺少可视化配置入口，导致策略只能通过接口或脚本变更，不利于运维与审计闭环。

## What Changes
- Web 新增治理页面：`/gov/artifact-policy`
  - 支持 scopeType 切换（space / tenant）
  - 展示并编辑：
    - `downloadTokenExpiresInSec`
    - `downloadTokenMaxUses`
    - `watermarkHeadersEnabled`
  - 支持 Load/Save（GET/PUT `/governance/artifact-policy`）
  - 错误展示沿用 `errorCode/message/traceId`
- 左侧治理导航增加入口：Artifact Policy
- i18n：补齐 zh-CN/en-US 文案
- WEB_E2E：新增 smoke 校验页面可加载

## Impact
- Affected specs:
  - 安全中枢（ArtifactPolicy 可治理化落地）
  - 治理控制台（新增配置入口）
- Affected code:
  - Web：`apps/web/src/app/gov/artifact-policy/*`
  - Web：`apps/web/src/components/shell/ConsoleShell.tsx`（新增导航项）
  - Web：`apps/web/src/locales/*`（文案）
  - Web：`apps/web/scripts/e2e-console-mode.mjs`（smoke）

## ADDED Requirements

### Requirement: GovArtifactPolicyPageV1
系统 SHALL 提供治理页面：
- 路由：`/gov/artifact-policy`
- **WHEN** 用户访问页面
- **THEN** 页面 MUST 可切换 `scopeType=space|tenant`
- **AND** 页面 MUST 通过 `GET /governance/artifact-policy?scopeType=...` 加载当前策略
- **AND** 页面 MUST 通过 `PUT /governance/artifact-policy` 保存策略

#### Scenario: 策略不存在
- **WHEN** `GET /governance/artifact-policy` 返回 404
- **THEN** 页面 MUST 明确提示“未配置/使用默认值”（不阻塞用户保存）

### Requirement: GovNavEntryForArtifactPolicyV1
- **WHEN** 用户打开治理控制台
- **THEN** 左侧导航 MUST 提供 Artifact Policy 入口

### Requirement: GovArtifactPolicyE2ESmokeV1
- **WHEN** 运行 `WEB_E2E` smoke
- **THEN** `/gov/artifact-policy` 页面 MUST 可加载

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

