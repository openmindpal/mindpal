# 租户/空间默认语言管理（Locale Defaults Admin）V1 Spec

## Why
《架构设计.md》2.2 要求语言优先级为 user>space>tenant>platform，且 tenant/space 均有可配置默认语言。当前系统已具备 default_locale 字段与请求解析闭环，但缺少对 `tenants.default_locale`、`spaces.default_locale` 的管理 API，导致无法在运行态完成“空间/组织默认语言”的配置与运营闭环。

## What Changes
- 新增默认语言查询接口（V1）：读取当前 subject 所属 tenant/space 的 default_locale
- 新增默认语言更新接口（V1）：支持更新 tenant default_locale 与 space default_locale
- 鉴权与审计（V1）：更新接口需要权限并写审计（仅摘要）

## Impact
- Affected specs:
  - 多语言/i18n（空间/租户默认语言可运营）
  - 统一请求链路（locale 解析依赖 DB 默认值）
  - RBAC（新增治理类权限点）
  - 审计域（配置变更审计）
- Affected code:
  - API：新增 locale defaults 路由与 repo
  - DB：无新增表（复用 tenants/spaces.default_locale）

## ADDED Requirements

### Requirement: 查询默认语言（V1）
系统 SHALL 提供默认语言查询接口：
- `GET /settings/locale-defaults`

返回（V1）至少包含：
- `tenantId`
- `tenantDefaultLocale`
- `spaceId`（可为空）
- `spaceDefaultLocale`（可为空）
- `effectiveLocale`（当前请求解析后的 locale，用于调试）

#### Scenario: 查询默认语言
- **WHEN** 用户调用 `GET /settings/locale-defaults`
- **THEN** 返回当前 tenant 的 default_locale
- **AND** 若存在 spaceId，则返回 space 的 default_locale

### Requirement: 更新 tenant 默认语言（V1）
系统 SHALL 支持更新 tenant 默认语言：
- `PUT /settings/tenant-locale`
- body：`{ defaultLocale: string }`

约束（V1）：
- defaultLocale MUST 为非空字符串且长度受限
- 更新必须写审计（resourceType=governance, action=locale.tenant.update）

#### Scenario: 更新 tenant 默认语言成功
- **WHEN** 管理员调用 `PUT /settings/tenant-locale`
- **THEN** tenants.default_locale 被更新
- **AND** 审计记录包含旧值/新值摘要（不含敏感信息）

### Requirement: 更新 space 默认语言（V1）
系统 SHALL 支持更新 space 默认语言：
- `PUT /settings/space-locale`
- body：`{ spaceId?: string, defaultLocale: string }`

约束（V1）：
- 若 body.spaceId 未提供，则默认使用当前 subject.spaceId
- 若最终 spaceId 为空 MUST 返回稳定错误码（400）
- 更新必须写审计（resourceType=governance, action=locale.space.update）

#### Scenario: 更新 space 默认语言成功
- **WHEN** 管理员更新 space default_locale
- **THEN** spaces.default_locale 被更新（且 tenant_id 匹配）
- **AND** 审计记录包含旧值/新值摘要

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

