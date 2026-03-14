# 修复 Web 租户/空间 Header 与统一审计写入边界 Spec

## Why
Web 端默认写死 `x-tenant-id/x-space-id` 会制造“客户端可决定租户/空间”的错觉并增加多租户演进噪音。审计写入路径（同步写 + outbox 写）并存会带来重复/遗漏风险，需要明确边界并用代码护栏降低治理成本。

## What Changes
- Web：`apiHeaders()` 不再默认写死 `x-tenant-id/x-space-id`，仅在显式提供时才发送。
- API：明确审计写入边界：成功的写操作优先使用 outbox（与业务写同一事务），避免同步写与 outbox 写同时发生。
- API：增加护栏以发现“写成功但未落审计”的路径（指标/日志或测试断言），并逐步迁移现有写路由到 outbox 策略。
- 测试：补齐回归，确保关键写接口不出现审计重复/遗漏。

## Impact
- Affected specs: BFF/API 统一请求链路、审计域（append-only + outbox）、Web 控制台客户端规范
- Affected code:
  - Web 客户端：[api.ts](file:///d:/trae/openslin/apps/web/src/lib/api.ts)
  - API 审计写入与 hook：[server.ts](file:///d:/trae/openslin/apps/api/src/server.ts)
  - 审计 outbox：`apps/api/src/modules/audit/outboxRepo.ts` 及相关写路由（routes/*）

## ADDED Requirements
### Requirement: Optional Tenant/Space Headers (Web)
Web 客户端 SHALL 默认不发送 `x-tenant-id` 与 `x-space-id` 请求头；仅当调用方显式指定租户/空间选择时才发送。

#### Scenario: Default request
- **WHEN** Web 端调用 API 且未显式传入 tenantId/spaceId
- **THEN** 请求头中不包含 `x-tenant-id/x-space-id`

#### Scenario: Explicit selection
- **WHEN** Web 端调用 API 且显式传入 tenantId/spaceId
- **THEN** 请求头包含对应的 `x-tenant-id/x-space-id`

### Requirement: Audit Write Boundary for Successful Writes
系统 SHALL 对“成功的写操作”使用审计 outbox 写入（与业务写入同一事务原子提交），并避免与同步审计写入重复。

#### Scenario: Successful write request
- **WHEN** 发生一次写操作并返回 2xx
- **THEN** 业务写入与审计 outbox 入队在同一事务内提交
- **AND** 最终只产生一条对应的 `audit_events` 记录（由 outbox 投递器落库）

## MODIFIED Requirements
### Requirement: 审计不可跳过
任何成功或失败的操作都必须产生审计记录；其中对成功的写操作，审计记录的可靠提交 SHALL 通过 outbox（事务内入队 + 异步投递）保证；对 read/deny/error 等不涉及业务提交的路径，允许通过同步写入保证可见性与解释性。

## REMOVED Requirements
（无）

