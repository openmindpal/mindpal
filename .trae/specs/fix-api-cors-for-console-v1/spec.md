# 修复 Console 模式切换 CORS V1 Spec

## Why
本地开发时 Web（`http://localhost:3000`）调用 API（`http://localhost:3001`）的 `PUT /settings/ui-mode` 被浏览器 CORS 预检拦截，导致简易模式/治理模式无法切换。

## What Changes
- API 增加标准 CORS 支持，确保浏览器预检（OPTIONS）与实际请求均返回正确的 CORS 响应头
- 允许的 Origin 可配置（默认仅允许本地 Web Origin），避免放开到任意来源
- 允许的方法与请求头覆盖 Console 实际会发送的 header 集合（含 `authorization`、`x-tenant-id`、`x-space-id`、`x-trace-id` 等）

## Impact
- Affected specs: 交互平面（UI）与 BFF/API 请求链路
- Affected code:
  - API：`apps/api/src/server.ts`（全局 CORS/OPTIONS 处理）
  - API：`apps/api/src/config.ts`（新增可选 CORS 配置项，如已存在则复用）

## ADDED Requirements
### Requirement: API 对 Console 跨域调用提供受控 CORS
系统 SHALL 在 API 层对来自允许 Origin 的跨域请求返回正确的 CORS 响应头：
- `Access-Control-Allow-Origin`：匹配请求 Origin（仅当 Origin 在允许列表中）
- `Access-Control-Allow-Methods`：至少包含 `GET,POST,PUT,DELETE,OPTIONS`
- `Access-Control-Allow-Headers`：至少包含 `content-type, authorization, x-tenant-id, x-space-id, x-user-locale, x-schema-name, x-trace-id, idempotency-key`

#### Scenario: 预检成功
- **WHEN** 浏览器对 `PUT /settings/ui-mode` 发起 OPTIONS 预检
- **THEN** API 返回 2xx 并包含 `Access-Control-Allow-Origin/Methods/Headers`

#### Scenario: 实际请求成功
- **WHEN** 浏览器从允许的 Origin 发起 `PUT /settings/ui-mode`
- **THEN** API 返回业务响应且包含 `Access-Control-Allow-Origin`

### Requirement: 允许 Origin 可配置且默认收敛
系统 SHALL 支持通过配置声明允许的 Origin 列表：
- 默认值仅包含本地开发 Web Origin（例如 `http://localhost:3000`）
- 未命中允许列表的请求不返回 `Access-Control-Allow-Origin`

## MODIFIED Requirements
无

## REMOVED Requirements
无

