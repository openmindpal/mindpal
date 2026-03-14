# AuthN 定位澄清（默认通用版 + 可插拔企业接入）Spec

## Why
平台定位为“安装部署后所有人用同一套系统”，同时覆盖个人/团队/企业。当前架构设计虽提到企业身份集成（SSO/OIDC/SCIM），但缺少明确边界说明：默认不做企业 IdP 集成也应可用；企业需要时应以可插拔方式接入，而不是引入“企业专属版本”或破坏统一请求链路与审计归属。

## What Changes
- 在 `架构设计.md` 增加/补强 AuthN 产品定位：默认通用版（内置认证/Token）即可满足个人与团队使用
- 在 `架构设计.md` 明确企业能力为“可选集成”：SSO/OIDC/SCIM 等作为可插拔 Auth Provider，不作为 MVP 门槛
- 在 `架构设计.md` 强调“多用户与撤销/审计归属”的底线要求：避免共享单一管理员 token；需支持主体归属、撤销与审计可追溯（作为后续演进重点）
- 不引入新的代码实现，仅更新文档边界与演进说明

## Impact
- Affected specs: AuthN/AuthZ 边界定义、产品定位、演进路线表达
- Affected code: 无（本变更仅修改文档）
- Affected docs: `d:\trae\openslin\架构设计.md`

## ADDED Requirements
### Requirement: 默认通用版认证定位
`架构设计.md` SHALL 明确平台默认采用通用认证方案即可运行（个人/团队可用），且不会引入“企业专属版本”。

#### Scenario: 文档读者理解默认可用性
- **WHEN** 读者阅读 `架构设计.md` 的目标/范围或 AuthN 相关段落
- **THEN** 能明确：默认部署后无需企业 IdP 也能完成身份建立（Subject）与租户/空间隔离

### Requirement: 企业身份集成为可选插件
`架构设计.md` SHALL 明确企业 SSO/OIDC/SCIM 仅作为可插拔集成项，不改变统一请求链路与审计不变式。

#### Scenario: 文档读者理解可插拔边界
- **WHEN** 读者查看企业管理面/身份集成相关内容
- **THEN** 能明确：是否接入企业 IdP 仅影响 AuthN 的身份来源，不改变 AuthZ/RBAC/Audit 的治理机制

## MODIFIED Requirements
### Requirement: “企业可用”定义
`架构设计.md` SHALL 将“企业可用”表述调整为“统一系统 + 可选企业接入”，并把“多用户与撤销/审计归属”列为优先补齐项。

## REMOVED Requirements
无

