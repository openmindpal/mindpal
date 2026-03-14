# OAuth 回调托管（OAuth Callback Gateway）V2：Provider 插件化与企业生态接入 Spec

## Why
当前 OAuth 回调托管仅支持 `mock` provider（演示/测试路径），不满足企业真实接入场景（企业微信/钉钉/飞书/Google 等）。需要将 OAuth provider 接入“插件化/配置化”：平台提供统一的 state/回调托管/审计护栏，但 provider 的端点、参数与凭证（clientId/clientSecret）由连接器实例显式配置，默认不内置任何可直接使用的上游（必须绑定才能用）。

## What Changes
- Provider 插件化（V2）：
  - 将 provider 的 OAuth 端点与参数从“代码写死/仅 mock”升级为“连接器实例可配置”
  - 支持的 provider 集合新增：`wecom`（企业微信）、`dingtalk`（钉钉）、`feishu`（飞书）、`google`（Google OAuth/OIDC），并允许扩展更多 provider
  - 平台默认不提供可直接使用的 clientId/clientSecret：必须先创建 ConnectorInstance 并配置 OAuth provider 参数与凭证（SecretRecord 托管）
- OAuth Provider 配置存储（V2）：
  - 新增 `oauth_provider_configs`（或等价资源）：按 `connector_instance_id + provider` 存储 authorize/token/refresh/userinfo 端点、scopes、clientId、clientSecretSecretId、PKCE 选项、额外参数
  - 端点出站必须受 connectorInstance 的 egressPolicy.allowedDomains 约束（默认拒绝）
- OAuth API（V2）：
  - `GET /oauth/providers`：列出平台支持的 provider key 与能力元数据（不包含端点与密钥）
  - `POST /oauth/authorize`：根据 connectorInstance 的 provider 配置生成 authorizeUrl（支持 PKCE）
  - `GET /oauth/callback/:provider`：根据 provider 配置交换 code→token 并写入 SecretRecord / oauth_grants
  - `POST /oauth/:provider/refresh`：根据 provider 配置刷新 token 并更新 SecretRecord
- 审计（V2）：
  - 审计摘要包含 provider/connectorInstanceId/grantId/endpointHost/tokenMetaDigest（不含 code/state/token/clientSecret 明文）

## Impact
- Affected specs:
  - 连接器与密钥托管（SecretRecord 用于存 token，不暴露明文）
  - 渠道接入/接入底座（OAuth 回调托管）
  - 安全中枢（回调参数与 token 摘要脱敏）
  - 审计域（授权链路可追溯）
- Affected code:
  - DB：新增 oauth provider 配置表（按 connectorInstance 绑定）
  - API：oauth 路由从 mock 扩展为配置化 provider，并新增 providers 列表接口

## ADDED Requirements

### Requirement: OAuth Provider 配置（V2）
系统 SHALL 支持为每个 ConnectorInstance 配置一个 OAuth provider：
- provider MUST 为平台支持的 provider key（`wecom`/`dingtalk`/`feishu`/`google`/未来扩展）
- 配置 MUST 包含：authorizeEndpoint、tokenEndpoint（refreshEndpoint 可选）、scopes（可选）、clientId、clientSecretSecretId（指向 SecretRecord）
- 配置 MAY 包含：pkce(required/enabled)、extraAuthorizeParams、extraTokenParams、userinfoEndpoint（可选）
- 配置读写 MUST 受权限控制，并写审计摘要（不包含密钥明文）

#### Scenario: 配置 provider（成功）
- **WHEN** 管理员为 connectorInstance 写入 OAuth provider 配置
- **THEN** 配置持久化且可被 authorize/callback/refresh 使用
- **AND** 审计仅记录 provider/connectorInstanceId/endpointHost/scopesLen 等摘要

### Requirement: OAuth State 绑定与过期（V2）
系统 SHALL 在发起授权时创建并持久化 state（单次使用）：
- state MUST 为高熵随机串
- state MUST 绑定：tenantId、spaceId（可空）、subjectId、connectorInstanceId、provider、createdAt、expiresAt
- state MUST 单次使用：成功回调后标记 consumed（或删除）
- state MUST 有 TTL：过期后回调必须拒绝（稳定 errorCode）

#### Scenario: 发起授权
- **WHEN** 用户调用 `POST /oauth/authorize`
- **THEN** 系统读取 connectorInstance 的 provider 配置生成 authorizeUrl（必须包含 redirect_uri/response_type/code/state，按配置附加 scope/pkce/extra params）
- **AND** 审计记录包含 provider/connectorInstanceId/stateDigest/endpointHost（不含明文 state）

### Requirement: OAuth Callback 校验与 Token 托管（V2）
系统 SHALL 在回调时：
- 校验 state 未过期且未消费
- 校验回调的 tenant/space/subject 与 state 绑定一致（防越权）
- 以受控出站调用配置的 tokenEndpoint 交换 code→token（遵循 allowedDomains）
- 将 token payload 以 SecretRecord 加密托管（不提供明文读取 API）
- 创建/更新 oauth_grants，将 connectorInstanceId 绑定到 SecretRecord

#### Scenario: 回调成功
- **WHEN** `GET /oauth/callback/:provider?code=...&state=...` 被调用且校验通过
- **THEN** SecretRecord 被创建或更新
- **AND** oauth_grants 记录更新为 active
- **AND** 审计记录包含 provider、connectorInstanceId、grantId、endpointHost、tokenMetaDigest（不含 token 明文）

#### Scenario: state 失效或越权
- **WHEN** state 不存在/过期/已消费/绑定不一致
- **THEN** 回调返回 400/403（稳定 errorCode）
- **AND** 审计记录拒绝原因摘要

### Requirement: Token Refresh（V2）
系统 SHALL 支持刷新 token：
- `POST /oauth/:provider/refresh`（输入仅引用 connectorInstanceId 或 grantId）
- 服务端从 SecretRecord 中取 refresh_token 并调用配置的 refreshEndpoint（若缺省则复用 tokenEndpoint）刷新
- 写回 SecretRecord（并记录 updatedAt）
- 全程不暴露 token 明文

#### Scenario: 刷新成功
- **WHEN** 用户/系统触发 refresh
- **THEN** SecretRecord 更新
- **AND** 审计记录刷新摘要（不含明文）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）
