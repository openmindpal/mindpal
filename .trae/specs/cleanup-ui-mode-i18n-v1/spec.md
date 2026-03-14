# 清理 UI 模式相关 i18n 残留（V1）Spec

## Why
系统已按《架构设计.md》改为统一标准模式并移除 uiMode（简易/治理）功能，但 Web 的 locales 仍残留相关文案 key，造成误导与维护噪音。

## What Changes
- 移除 Web i18n 中与“交互模式/简易模式/治理模式”相关的未使用 key（zh-CN/en-US）。
- 保留与当前功能仍相关的 key（例如刷新控制台数据按钮文案）。

## Impact
- Affected specs: 交互平面（UI）与页面配置、i18n 资源维护规范
- Affected code:
  - `apps/web/src/locales/zh-CN.json`
  - `apps/web/src/locales/en-US.json`

## ADDED Requirements
（无）

## MODIFIED Requirements
### Requirement: i18n 资源一致性（V1）
系统 SHALL 不包含已移除功能的 i18n 文案 key，避免在 UI/文档中暗示存在“简易/治理模式”切换能力。

#### Scenario: i18n key 清理
- **WHEN** 已删除 uiMode 功能
- **THEN** locales 中不应再包含 `settings.mode.*`（除仍被现有 UI 使用的 key）与 `settings.governance.*` 中专用于模式切换的 key

## REMOVED Requirements
（无）
