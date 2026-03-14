# `/gov/models` 简易模型接入 Spec

## Why
当前 `/gov/models` 的模型接入需要依次创建 Connector Instance、Secret、Binding 三个资源；对只想“填 Key 立刻能聊”的用户来说心智负担偏高。

## What Changes
- Web `/gov/models` 改为“单表单接入”：选择 Provider（OpenAI 兼容 / DeepSeek / 混元 / 千问 / 豆包 / 智谱 / Kimi）后，填写：
  - Base URL（地址）
  - API Key
  - Model Name（模型名称）
  点击保存即可完成接入
- 新增后端“一键接入”接口：一次请求完成 connector instance + secret + model binding 的创建，并返回创建结果（不回显密钥明文）
- 新增“测试”能力：保存成功后可点击测试，调用 Model Gateway 进行一次最小对话请求并展示结果
- 为模型绑定新增 Base URL 存储与运行时路由支持（用于 OpenAI 兼容类 Provider 的自定义地址）
- 保持现有 `/connectors/*`、`/secrets/*`、`/models/bindings` 等接口可用（不要求在 UI 暴露）

## Impact
- Affected specs: Model Gateway、Connector/Secrets、Governance Console（模型接入 UI）
- Affected code: `apps/api/src/routes/models.ts`、`apps/api/src/modules/modelGateway/*`、`apps/api/src/modules/modelGateway/bindingRepo.ts`、`apps/api/migrations/*`、`apps/web/src/app/gov/models/*`

## ADDED Requirements
### Requirement: Simple Model Onboarding UI
系统 SHALL 在 `/gov/models` 提供单表单模型接入体验，不提供高级模式。

#### Scenario: Save（保存成功）
- **WHEN** 用户在 `/gov/models` 选择 Provider，并填写 Base URL、API Key、Model Name 点击保存
- **THEN** 系统创建（或复用）一个已启用的 connector instance，其 `egressPolicy.allowedDomains` 至少包含 Base URL 的 host
- **AND** 系统创建一个 active secret（payload 至少包含 apiKey），且不回显明文
- **AND** 系统创建一个可用于 `/models/chat` 的 model binding，并持久化 provider/model/baseUrl 等信息
- **AND** 页面展示“保存成功”与创建后的 modelRef（或显示名），并展示“测试”按钮

#### Scenario: Test（点击测试）
- **WHEN** 用户点击测试
- **THEN** 前端以该 binding 的 modelRef 调用一次 `/models/chat`，并展示 outputText 与 traceId
- **AND** 若返回错误，展示 errorCode/message/traceId（不展示敏感信息）

#### Scenario: Validation failure（输入无效）
- **WHEN** Base URL 不是合法 URL（或协议不被允许）
- **THEN** 返回明确的错误码与可读 message，且不创建任何资源
- **WHEN** API Key 为空或 Model Name 为空
- **THEN** 返回明确错误码与 message，且不创建任何资源

#### Scenario: Atomicity（原子性）
- **WHEN** 一键接入流程中任一步骤失败（例如 secret 创建失败或 binding 校验失败）
- **THEN** 系统不应留下“半成品资源”，或必须通过事务/补偿保证最终一致并可被安全清理

#### Scenario: Idempotency（幂等）
- **WHEN** 客户端带同一个幂等键重复提交相同请求
- **THEN** 系统返回相同的创建结果或语义等价的结果，并避免重复创建多份资源

#### Scenario: Audit & DLP（审计与脱敏）
- **WHEN** 用户成功或失败发起一键接入
- **THEN** 系统写入审计事件（至少涵盖创建的资源 id 与 scope）
- **AND** 审计与响应必须不泄露密钥明文，并遵循现有 DLP/脱敏策略

### Requirement: One-Click Model Onboarding API
系统 SHALL 提供一个“一键接入模型”的 API，使 Web 在单次提交中完成模型接入所需的资源创建，并返回可用于调用的 binding 信息。

#### Request Shape（概念）
- 输入应至少包含：
  - `providerKey`（枚举：`openai_compatible`、`deepseek`、`hunyuan`、`qianwen`、`doubao`、`zhipu`、`kimi`）
  - `baseUrl`
  - `apiKey`
  - `modelName`
- 输入可选包含：
  - `connectorInstanceName`（缺省时后端生成可读默认值）
  - `modelRef`（缺省时后端按稳定规则生成；若提供则必须满足命名约束）

#### Response Shape（概念）
- 响应应包含：
  - `connectorInstanceId`
  - `secretId`
  - `bindingId`
  - `modelRef`
  - `provider`、`model`、`baseUrl`（用于 UI 展示与后续测试）

### Requirement: Binding Base URL Support
系统 SHALL 支持为 openai 兼容类模型绑定保存并使用 Base URL。

#### Scenario: Runtime routing（运行时路由）
- **WHEN** `/models/chat` 选择到一个 provider=openai 的 binding
- **AND** 该 binding 具备 `baseUrl`
- **THEN** 网关使用该 `baseUrl` 发起上游请求
- **AND** 出站域名白名单校验基于 `baseUrl` 的 host，而不是静态 catalog 的 endpointHost

## MODIFIED Requirements
### Requirement: Existing Model Onboarding Wizard
现有三步向导（Connector → Secret → Binding）不再要求在 UI 暴露，但其 API/校验语义保持不变且可继续被调用。

## REMOVED Requirements
无
