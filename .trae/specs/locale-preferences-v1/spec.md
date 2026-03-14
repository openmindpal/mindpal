# Locale 偏好（User/Space/Tenant）V1 Spec

## Why
《架构设计.md》2.2 要求语言优先级为 user>space>tenant>platform，且默认中文。当前后端仅从 header/accept-language 推导 locale，未与 DB 的 `tenants.default_locale`、`spaces.default_locale` 打通，也缺少用户语言偏好的持久化与 API，导致“默认语言”“用户覆盖”“跨端一致”无法形成闭环。

## What Changes
- Locale 解析闭环（V1）：
  - 将请求 locale 解析与 DB 偏好打通：user(偏好) → space.default_locale → tenant.default_locale → platformLocale → zh-CN
  - 仍支持显式 header 覆盖（`x-user-locale` 等）作为最高优先级
- 用户偏好存储（V1）：
  - 复用 `memory_user_preferences`（pref_key=`locale`）存储 subject 级语言偏好
- 偏好 API（V1）：
  - `GET /me/preferences`：返回当前 subject 的偏好（至少含 locale）
  - `PUT /me/preferences`：更新 subject 偏好（至少支持 locale）
- 可观测与审计（V1）：
  - 偏好变更写审计（resourceType=memory 或 profile，action=preferences.update，input/output 仅摘要）

## Impact
- Affected specs:
  - 统一请求链路（locale 解析）
  - 多语言/i18n（优先级闭环）
  - 记忆层（用户偏好存储）
  - 审计域（偏好变更审计）
- Affected code:
  - API：requestContext/locale 解析增加 DB 查询（tenant/space 默认 + user pref）
  - API：新增 /me/preferences 路由与 repo

## ADDED Requirements

### Requirement: Locale 优先级闭环（V1）
系统 SHALL 按以下优先级解析每个请求的 `locale`：
1) 显式 header（V1）：
   - `x-user-locale`、`x-space-locale`、`x-tenant-locale`（保持现有语义）
2) user 偏好（V1）：`memory_user_preferences.pref_key='locale'`
3) space 默认（V1）：`spaces.default_locale`
4) tenant 默认（V1）：`tenants.default_locale`
5) platform 默认（V1）：`platformLocale`（配置）
6) fallback：`zh-CN`

#### Scenario: 用户偏好覆盖默认
- **GIVEN** tenant/space 默认均为 zh-CN，用户偏好为 en-US
- **WHEN** 用户不显式传 `x-user-locale`
- **THEN** `req.ctx.locale` 解析为 en-US

#### Scenario: header 覆盖用户偏好
- **GIVEN** 用户偏好为 zh-CN
- **WHEN** 请求带 `x-user-locale=en-US`
- **THEN** `req.ctx.locale` 为 en-US

### Requirement: 用户偏好 API（V1）
系统 SHALL 提供用户偏好读写接口：
- `GET /me/preferences` → `{ locale, ... }`
- `PUT /me/preferences`（body: `{ locale: string }`）→ 返回更新后的偏好

约束（V1）：
- locale MUST 为非空字符串，长度受限
- 写入使用 upsert（同 subject 多次更新覆盖）
- 写入必须可审计，且仅记录摘要（不记录敏感内容）

#### Scenario: 更新 locale 偏好
- **WHEN** 用户调用 `PUT /me/preferences` 提交 locale
- **THEN** 偏好被写入（pref_key=locale）
- **AND** 后续请求在不带 header 时使用该 locale

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

