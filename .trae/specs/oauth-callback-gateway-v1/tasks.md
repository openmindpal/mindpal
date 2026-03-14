# Tasks
- [x] Task 1: OAuth State/Grant 数据模型与存储
  - [x] SubTask 1.1: 新增 migrations：oauth_states、oauth_grants 表与索引（TTL/consumed）
  - [x] SubTask 1.2: 实现 oauthStateRepo（create/get/consume）
  - [x] SubTask 1.3: 实现 oauthGrantRepo（upsertByConnectorInstance/getById）

- [x] Task 2: OAuth API（authorize/callback/refresh）
  - [x] SubTask 2.1: `POST /oauth/authorize`（创建 state，返回 authorizeUrl）
  - [x] SubTask 2.2: `GET /oauth/callback/:provider`（校验 state，交换 code→token，写 SecretRecord + grant）
  - [x] SubTask 2.3: `POST /oauth/:provider/refresh`（读取 SecretRecord 刷新并写回）

- [x] Task 3: 出站与审计对齐
  - [x] SubTask 3.1: token endpoint 出站纳入 allowedDomains（默认拒绝）
  - [x] SubTask 3.2: 审计覆盖 authorize/callback/refresh（成功/失败/拒绝均写摘要）
  - [x] SubTask 3.3: DLP：token 相关字段仅写入 digest（禁止明文）

- [x] Task 4: 回归测试与文档
  - [x] SubTask 4.1: e2e：authorize→callback（mock provider）后 grant 与 SecretRecord 生效
  - [x] SubTask 4.2: e2e：state 过期/重复使用/跨租户拒绝
  - [x] SubTask 4.3: README：补齐 OAuth 回调托管使用方式与安全说明

- [x] Task 5: OAuth Provider 插件化与配置化（V2）
  - [x] SubTask 5.1: 新增 oauth provider 配置数据模型（按 connectorInstanceId+provider 存储端点/PKCE/参数/凭证引用）
  - [x] SubTask 5.2: 新增/扩展 API：支持写入/读取 provider 配置（权限+审计摘要）
  - [x] SubTask 5.3: 新增 `GET /oauth/providers` 返回支持的 provider 列表与能力元数据

- [x] Task 6: 实现真实 Provider：企业微信/钉钉/飞书/Google（V2）
  - [x] SubTask 6.1: /oauth/authorize：根据 provider 配置生成 authorizeUrl（PKCE/extra params）
  - [x] SubTask 6.2: /oauth/callback：按 provider 配置交换 code→token（受 egressPolicy.allowedDomains 约束）
  - [x] SubTask 6.3: /oauth/:provider/refresh：按 provider 配置刷新并更新 SecretRecord
  - [x] SubTask 6.4: 适配差异：支持 provider 的 token endpoint 认证方式（header/body）与参数差异（extraTokenParams）

- [x] Task 7: 回归测试（V2）
  - [x] SubTask 7.1: e2e：为每个 provider 覆盖 authorizeUrl 生成（含 PKCE 可选）与回调校验
  - [x] SubTask 7.2: e2e：出站域名不在白名单内时拒绝（默认拒绝）
  - [x] SubTask 7.3: e2e：refresh 路径与审计摘要不泄露敏感信息

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
- Task 5 depends on Task 1
- Task 6 depends on Task 5
- Task 7 depends on Task 6
