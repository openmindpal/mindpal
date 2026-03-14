# 审计 SIEM Webhook 出站治理（Egress Guard）V1 Spec

## Why
《架构设计.md》与《架构-06-审计域》强调：任何外发必须受出站治理约束且可审计。当前审计 SIEM Webhook 外送（worker 投递、API test）直接对 webhookUrl 发起网络请求，绕过了既有的 egressPolicy / allowedDomains 机制，违反“客户端不可信 + 出站必须被治理”的不变式，并带来数据外泄风险。

V1 以最小改动补齐：SIEM Webhook 投递与 test 在发起请求前强制执行域名白名单校验，并将 egress 审计字段写入 audit outputDigest，便于追溯与对账。

## What Changes
- API：`POST /audit/siem-destinations/:id/test` 增加出站域名白名单校验
- Worker：SIEM Webhook 投递在 fetch 前执行出站校验；不通过则拒绝投递并记录可解释审计
- 审计字段补齐：`siem.delivery` 事件 outputDigest 增加 `egressSummary` 与 `egressPolicySnapshot`（最小集合）
- 测试：新增/扩展 e2e 覆盖“允许域名放行、禁止域名拒绝”的行为

## Impact
- Affected specs:
  - 审计域（外送必须可治理、可追溯）
  - 连接器与密钥托管（复用 connector egressPolicy 作为出站约束来源）
- Affected code:
  - API：`apps/api/src/routes/audit.ts`
  - Worker：`apps/worker/src/audit/siemWebhook.ts`
  - Tests：`apps/api/src/__tests__/e2e.test.ts`、`apps/worker/src/__tests__/processor.test.ts`

## ADDED Requirements

### Requirement: AuditSiemEgressGuardV1
系统 SHALL 在 SIEM Webhook 出站前执行域名白名单校验：
- 白名单来源（V1）：
  - destination.secretId → secret_records.connector_instance_id
  - connector_instances.egress_policy.allowedDomains（优先），缺省回退到 connector_types.default_egress_policy.allowedDomains
- 校验口径（V1）：
  - 仅允许 hostname 精确匹配 allowedDomains（不支持通配与子域自动放行）

#### Scenario: API test 放行/拒绝
- **WHEN** 调用 `POST /audit/siem-destinations/:id/test`
- **THEN** 系统 MUST 在发起请求前校验 webhookUrl.hostname 是否允许
- **AND** 若不允许 MUST 拒绝请求并返回结构化错误（errorCode/message/traceId）
- **AND** 该行为 MUST 写入审计（resourceType=audit，action=siem.destination.test，errorCategory=policy_violation）

#### Scenario: Worker 投递放行/拒绝
- **WHEN** worker 对 destination 执行增量投递
- **THEN** worker MUST 在 fetch 前校验 webhookUrl.hostname 是否允许
- **AND** 若不允许 MUST 不发送网络请求，写入 `siem.delivery` 审计事件，result=error，errorCategory=policy_violation

### Requirement: AuditSiemEgressAuditFieldsV1
系统 SHALL 在 `siem.delivery` 审计事件 outputDigest 中补齐最小 egress 字段：
- `egressPolicySnapshot: { allowedDomains: string[] }`
- `egressSummary: [{ host: string, method: "POST", allowed: boolean, status?: number, errorCategory?: string }]`

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

