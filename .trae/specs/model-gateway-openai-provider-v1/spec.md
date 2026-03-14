# 模型网关 OpenAI Provider 适配（Model Gateway OpenAI Provider）V1 Spec

## Why
当前 Model Gateway 的 `/models/chat` 仅支持 mock provider，无法满足《架构设计.md》与《架构-09-模型网关-路由限流配额与回归.md》提出的“多模型接入 + BYOK + 出站治理 + 可审计”的最小落地。需要补齐 OpenAI provider 适配，使平台在统一请求链路内完成真实模型调用，同时保持 Secrets 不明文外泄与审计摘要化。

## What Changes
- 扩展 Model Catalog：增加至少 1 个 `provider=openai` 的可用 `modelRef` 条目（endpointHost=api.openai.com）。
- 实现 OpenAI Provider Adapter：在 `/models/chat` 中对 `provider=openai` 进行真实请求转发（chat.completions），其他 provider 保持既有策略（mock 可用，其他返回 NOT_IMPLEMENTED）。
- Secrets 对齐：从 `SecretRecord.encrypted_payload` 解密出 API Key（不写日志、不写审计原文），仅用于当次请求 Authorization。
- 审计对齐：审计记录包含 routingDecision、latencyMs、usage 摘要（如可得）、errorCategory（如有），不记录 prompts 原文与凭证。
- 错误模型：为上游失败提供稳定 errorCode（例如 MODEL_UPSTREAM_FAILED），保留 traceId 以便排障。

## Impact
- Affected specs:
  - 模型网关（路由/限流/审计/凭证对齐）
  - 连接器与密钥托管（BYOK、加密存储、明文不可读）
  - 审计域（invoke 的摘要与错误分类）
- Affected code:
  - API：`apps/api/src/routes/models.ts`
  - Model Gateway：`apps/api/src/modules/modelGateway/catalog.ts`（新增 openai 条目）
  - Secrets：`apps/api/src/modules/secrets/*`（复用 decryptJson）
  - Errors：`apps/api/src/lib/errors.ts`（新增上游失败类错误码，如需）
  - Tests：API e2e/单测（覆盖 openai provider 分支）

## ADDED Requirements
### Requirement: Model Catalog 提供 openai modelRef
系统 SHALL 在 `/models/catalog` 返回至少 1 个 `provider=openai` 的条目：
- `modelRef` 形如 `openai:<model>`（例如 `openai:gpt-4o-mini`）
- `endpointHost` 为 `api.openai.com`

#### Scenario: catalog 可见
- **WHEN** 用户查询 `GET /models/catalog`
- **THEN** 返回包含 `provider=openai` 的条目

### Requirement: `/models/chat` 支持 openai provider
系统 SHALL 在 `/models/chat` 中对 `provider=openai` 完成一次真实模型调用：
- 从当前 scope（space/tenant）的 binding 解析 `modelRef → provider/model/connectorInstanceId/secretId`
- 强制出站治理：目标 host 必须在 allowedDomains 内，否则拒绝并标记 errorCategory=policy_violation
- 解密 SecretRecord 获取 apiKey，仅用于当次请求，不写入审计原文与日志
- 调用 OpenAI Chat Completions（最小形态：messages → outputText）
- 响应返回 `routingDecision/latencyMs/traceId`，usage 如可得则返回摘要

#### Scenario: openai 调用成功
- **WHEN** 用户在已创建 binding（provider=openai）且 connector/secret 有效时调用 `/models/chat`
- **THEN** 返回 `outputText` 且包含 `routingDecision.provider=openai`
- **AND** 写审计（resourceType=model, action=invoke），不包含 apiKey 与 prompts 原文

#### Scenario: 上游失败
- **WHEN** OpenAI 返回非 2xx 或网络错误/超时
- **THEN** 返回稳定 `errorCode`（例如 `MODEL_UPSTREAM_FAILED`）
- **AND** 响应包含 traceId
- **AND** 审计记录 errorCategory=upstream_error（或等价分类）

## MODIFIED Requirements
### Requirement: Provider 适配策略扩展
`/models/chat` 的 provider 分支 SHALL 支持 `openai`，保持 `mock` 行为不变，其他 provider 仍可返回 NOT_IMPLEMENTED。

## REMOVED Requirements
无

