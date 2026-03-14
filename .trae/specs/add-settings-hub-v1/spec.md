# 设置页聚合入口（Settings Hub）V1 Spec

## Why
《架构设计.md》要求“控制台入口统一：设置页聚合模型绑定、通道管理、技能列表与定时任务”，并强调界面呈现与可用操作由 RBAC/Policy 决定。当前控制台入口分散，缺少一个面向运维/管理的统一聚合页，增加了上手与治理成本。

## What Changes
- Web：新增 Settings Hub 页面（控制台设置聚合入口）
  - 以 Card/Tile 形式聚合关键能力入口：模型绑定、连接器与密钥、通道/订阅、技能与工具、定时/任务等
  - 每个入口展示短描述与跳转按钮
- 可见性：按 RBAC/Policy 决定哪些入口可见/可用（V1 采用“代表性探测”策略）
- i18n：补齐 zh-CN/en-US 文案 keys
- WEB_E2E：smoke 断言设置页存在并包含关键入口文案

## Impact
- Affected specs:
  - 交互平面（UI）与页面配置
  - BFF/API 与统一请求链路（入口跳转仍走统一链路）
  - 认证与授权（入口呈现基于 RBAC/Policy）
- Affected code:
  - Web：`apps/web/src/app/settings/*` 或等价路由
  - Web：`apps/web/src/components/shell/*`（如需增加导航入口）
  - Web locales：`apps/web/src/locales/{zh-CN,en-US}.json`
  - Web e2e：`apps/web/scripts/e2e-console-mode.mjs`

## ADDED Requirements

### Requirement: SettingsHubPageV1
系统 SHALL 提供设置聚合页（Settings Hub）作为控制台统一入口：
- **WHEN** 用户打开设置页
- **THEN** 页面展示若干入口卡片（至少包含：模型绑定、连接器与密钥、通道/订阅、技能与工具、定时/任务）
- **AND** 每个入口提供跳转按钮进入对应功能页面

### Requirement: SettingsHubVisibilityV1
系统 SHALL 根据 RBAC/Policy 控制设置页入口的可见/可用：
- V1 策略：对每个入口选择一个“代表性 API”进行探测
  - **WHEN** 代表性 API 返回 403/denied
  - **THEN** 对应入口在设置页隐藏或禁用（二选一，保持一致）
  - **WHEN** 代表性 API 返回 200
  - **THEN** 对应入口可见且可用

### Requirement: SettingsHubI18nV1
系统 SHALL 为设置页新增的可见文案提供 i18n keys，并支持 zh-CN/en-US。

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

