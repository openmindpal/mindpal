# 认证（AuthN）：令牌校验与主体绑定 V1 Spec

## Why
《架构设计.md》与《架构-05》要求“唯一鉴权源”：Subject 与 tenant/space 上下文只能由认证层建立，且客户端上下文不可被信任。当前 AuthN 仅把 Bearer 明文映射为 subjectId 并硬编码 tenantId/spaceId，无法满足上线所需的身份真实性与可治理性。

## What Changes
- 新增 AuthN 模式（V1）：
  - `AUTHN_MODE=dev`：保持现状（明文 token → subjectId[@spaceId]），仅用于本地/测试
  - `AUTHN_MODE=hmac`：启用 HMAC 签名令牌校验（包含 tenantId/subjectId/spaceId/exp）
- 认证层严格绑定上下文（V1）：
  - tenantId/spaceId 仅来自 token payload（忽略 header 注入）
  - token 校验失败统一返回 401
- Subject 自动落库（V1）：
  - 在 token 校验成功但 subject 不存在时自动创建 subjects 记录（tenant 绑定）
- 审计对齐（V1）：
  - 认证失败/成功不写业务审计（避免噪声）
  - 但所有受保护资源的审计仍包含 subjectId/tenantId/spaceId（来自 AuthN）

## Impact
- Affected specs:
  - 认证与授权（AuthN/AuthZ，RBAC 起步）
  - BFF/API 与统一请求链路（Subject 贯穿链路）
- Affected code:
  - API：`authenticate()` 与请求链路的 subject 注入
  - DB：subjects 表写入路径（可能新增索引/约束）
  - 测试：e2e/单测需要覆盖 hmac 模式

## ADDED Requirements

### Requirement: AuthN 模式切换（V1）
系统 SHALL 支持通过环境变量切换 AuthN 模式：
- `AUTHN_MODE=dev|hmac`，默认 `dev`

#### Scenario: dev 模式兼容
- **GIVEN** `AUTHN_MODE=dev`
- **WHEN** 请求携带 `Authorization: Bearer admin@space_dev`
- **THEN** 认证层建立 `subjectId=admin, tenantId=tenant_dev, spaceId=space_dev`

#### Scenario: hmac 模式校验
- **GIVEN** `AUTHN_MODE=hmac` 且配置 `AUTHN_HMAC_SECRET`
- **WHEN** 请求携带有效签名且未过期的 token
- **THEN** 认证层建立 token payload 指定的 tenantId/subjectId/spaceId
- **AND** 忽略客户端 `x-tenant-id/x-space-id` 注入

### Requirement: HMAC Token 格式（V1）
系统 SHALL 支持 HMAC-SHA256 的简易令牌格式：
- `token = base64url(payloadJson) + "." + base64url(hmacSha256(secret, payloadPart))`
- payload 最小字段（V1）：
  - `tenantId`（必填）
  - `subjectId`（必填）
  - `spaceId`（可选）
  - `exp`（必填，unix 秒）

#### Scenario: token 过期拒绝
- **WHEN** `exp <= now`
- **THEN** 认证 MUST 失败并返回 401

### Requirement: Subject 自动落库（V1）
系统 SHALL 在认证成功时确保 subject 存在：
- 若 `subjects(id)` 不存在，系统 MUST 创建 `subjects(id, tenant_id)`
- 若已存在且 tenant 不一致，系统 MUST 拒绝（401 或 403，按实现约定）

#### Scenario: 首次登录自动创建 subject
- **WHEN** 一个合法 token 的 subjectId 首次出现
- **THEN** subjects 表新增对应记录并绑定 tenantId

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

