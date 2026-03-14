# 模型网关（Model Gateway）MVP Spec

## Why
平台已具备受控工具执行、审计、运行时出站治理与 Connector/Secrets 托管，但缺少统一“模型调用能力”的入口与治理面（路由、限流、审计、凭证与出站策略对齐）。需要按《架构-09-模型网关-路由限流配额与回归.md》补齐 Model Gateway MVP，为后续编排层与 Skill 生态提供可控的模型调用能力。

## What Changes
- 新增 Model Gateway API：统一模型调用入口（MVP：chat.completions 文本输出）
- 新增 Model Catalog（MVP）：模型清单/能力/默认限制（静态 seed + 可扩展存储）
- 新增 Provider Binding（MVP）：租户/空间将 provider+model 绑定到 ConnectorInstance+SecretRecord（BYOK）
- 新增限流（MVP）：按 tenant 维度对模型调用做速率限制（Redis 计数窗口）
- 新增审计（MVP）：记录 routingDecision 摘要、input/output digest、usage 摘要、latencyMs、错误分类
- 新增出站治理对齐：模型调用的目标 host 必须落在 ConnectorInstance 的 allowedDomains 白名单内（与运行时 networkPolicy 语义一致）

## Impact
- Affected specs:
  - 模型网关（路由/限流/审计/凭证对齐）
  - 连接器与密钥托管（BYOK、禁止明文读取、使用审计）
  - Skill 运行时（出站治理语义对齐与 egressSummary）
  - 审计域（新增 model 事件与摘要字段）
- Affected code:
  - API：新增 /models/* 路由与 modelGateway 模块
  - DB：新增 provider_bindings（或等价）与可选 model_catalog 存储（MVP 可 seed）
  - Redis：新增 rate limit 计数 key（MVP）

## ADDED Requirements

### Requirement: Model Gateway 统一调用入口（MVP）
系统 SHALL 提供模型调用入口：
- `POST /models/chat`
- 请求体最小字段：{ purpose, modelRef?, messages, constraints?, timeoutMs? }
- 响应体最小字段：{ outputText, routingDecision, usage?, latencyMs, traceId }

#### Scenario: 成功调用
- **WHEN** 用户在已绑定 provider 的租户/空间发起 /models/chat
- **THEN** 系统返回 outputText
- **AND** routingDecision 指明 provider/model 及选择原因（摘要）
- **AND** 写审计（resourceType=model, action=invoke）

### Requirement: Model Catalog（MVP）
系统 SHALL 提供模型清单读取：
- `GET /models/catalog` 返回 provider/model/capabilities/defaultLimits
- MVP 可使用静态 seed（不要求动态管理）

#### Scenario: 查询模型清单
- **WHEN** 管理者查询 /models/catalog
- **THEN** 返回至少 1 个 provider 与 1 个模型条目

### Requirement: Provider Binding（BYOK，MVP）
系统 SHALL 支持将租户/空间的 “provider+model” 绑定到 ConnectorInstance 与 SecretRecord：
- `POST /models/bindings` 创建绑定（仅引用 connectorInstanceId 与 secretId，不返回明文）
- `GET /models/bindings` 查询绑定
- 绑定生效前必须校验：connector enabled 且 secret active 且 scope 匹配

#### Scenario: 绑定模型提供方凭证
- **WHEN** 管理者创建 binding
- **THEN** binding 可被 /models/chat 使用
- **AND** 写审计（resourceType=model, action=bind）

### Requirement: 限流（MVP）
系统 SHALL 对 /models/chat 按 tenantId 维度执行速率限制：
- 默认阈值：每分钟 N 次（可配置，MVP 可常量）
- 超限返回 429（稳定 errorCode）并写审计（denied）

#### Scenario: 超限拒绝
- **WHEN** 同一 tenant 在窗口内超过阈值
- **THEN** 返回 429 并包含 traceId

### Requirement: 出站治理对齐（MVP）
系统 SHALL 强制校验模型调用的目标 host 在 binding 对应 ConnectorInstance.allowedDomains 内：
- 默认拒绝
- 任何放行必须来自 connector 的 allowedDomains

#### Scenario: 域名不在白名单
- **WHEN** 绑定的 allowedDomains 不包含目标 host
- **THEN** /models/chat 拒绝并标记 errorCategory=policy_violation，写审计

### Requirement: 可审计（MVP）
系统 SHALL 对每次 /models/chat 调用写审计，至少包含：
- routingDecision 摘要
- inputDigest/outputDigest（脱敏摘要，不含原文与凭证）
- usage 摘要（如 token 计数可用则记录，否则记录缺省）
- latencyMs、errorCategory

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

