# BFF/API 统一请求链路（认证上下文 + 审计可靠写入）V1 Spec

## Why
当前 API 已有 traceId/locale/审计的基础骨架，但仍存在关键不变式缺口：租户/空间上下文可被调用方通过 header 伪造、审计写入失败被吞掉（仅日志记录）、requestId 未显式区分与贯穿。需要按《架构-02-BFF与统一API请求链路.md》补齐“唯一入口 + 统一安全链路 + 审计可追踪”的 V1 能力。

## What Changes
- 认证上下文收敛：subject/tenant/space 仅由 AuthN 建立，禁止调用方通过 header 注入（**BREAKING** 对现有 header 行为）
- 统一 requestId：每次请求生成 requestId，与 traceId 并存并写入审计
- 审计可靠边界（V1）：审计写入失败不再静默；写操作必须失败（或进入 outbox 可靠补偿，V1 先实现“失败即失败”）
- 审计事件字段补齐：policyDecision 摘要、input/output digest、requestId/traceId/idempotencyKey 等最小集合
- BFF（Web）与 API 头部约定固化：traceId/requestId/locale/idempotencyKey 的来源与透传规则

## Impact
- Affected specs:
  - BFF/API 与统一请求链路（AuthN/Validation/AuthZ/Execution/Audit）
  - 审计域（可靠写入边界与字段集合）
  - 工具执行/工作流（idempotencyKey/traceId/requestId 贯穿）
- Affected code:
  - API：server hooks、auth 模块、audit 写入路径、错误规范
  - Web：请求头透传（可选，V1 可仅保证 API 侧兼容）
  - 测试：需要调整依赖 x-tenant-id/x-space-id 的用例

## ADDED Requirements

### Requirement: 认证上下文只由 AuthN 建立
系统 SHALL 在 API 层建立 Subject + tenant/space 上下文，且禁止由调用方自带身份。
- API SHALL 忽略/拒绝来自客户端的 `x-tenant-id`/`x-space-id` 作为身份来源
- tenantId/spaceId 必须来自认证凭证（token/会话）解析结果

#### Scenario: 调用方试图伪造租户
- **WHEN** 客户端携带 `x-tenant-id=other` 但认证为 tenant_dev
- **THEN** 系统仍以认证解析出的 tenantId 为准，并写审计摘要

### Requirement: requestId 与 traceId 并存
系统 SHALL 为每次请求生成 requestId：
- requestId 在服务端生成（UUID）
- traceId 用于端到端追踪（可由调用方提供，否则服务端生成）
- 审计事件中必须同时包含 requestId 与 traceId

#### Scenario: 无 traceId
- **WHEN** 客户端未提供 traceId
- **THEN** 系统生成 traceId 与 requestId，并回显在响应体或响应头

### Requirement: 审计可靠边界（V1）
系统 SHALL 对所有请求写审计事件；对写操作审计失败不得静默。
- 对写操作（create/update/delete/execute/publish/approve 等）：
  - **IF** 审计写入失败
  - **THEN** 请求返回失败（稳定 errorCode），并输出 traceId/requestId 以便追踪
- 对只读操作（read）：
  - V1 可保持“尽力写审计”，但必须可配置为强一致（后续 V2）

#### Scenario: 写操作审计失败
- **WHEN** 审计写入失败
- **THEN** 返回 5xx 且 errorCode=AUDIT_WRITE_FAILED

### Requirement: 审计最小字段集合（V1）
系统 SHALL 在审计事件中记录至少：
- subjectId/tenantId/spaceId
- resourceType/action
- policyDecision（摘要或 snapshotRef）
- inputDigest/outputDigest（脱敏摘要）
- requestId/traceId/idempotencyKey
- result（success/denied/error）与 errorCategory（如有）
- latencyMs

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

