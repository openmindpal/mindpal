# 连接器与密钥托管（Connector / Secrets）MVP Spec

## Why
平台已具备受控工具执行、审计与运行时出站治理，但缺少“外部系统接入”的统一抽象与凭证托管。需要按《架构-14-连接器与密钥托管-Connector与Secrets.md》补齐连接器与 SecretRecord 的最小闭环，确保接入真实世界但不失控。

## What Changes
- 新增 ConnectorType 与 ConnectorInstance（MVP 最小字段）
- 新增 SecretRecord（加密托管 + 状态机：active/revoked）
- 新增受控使用接口：工具/运行时只能通过 connector 调用路径使用凭证，禁止读取明文
- 新增 EgressPolicy（allowedDomains）并与运行时 networkPolicy 对齐（MVP：host 白名单）
- 新增审计事件：连接器创建/启用、Secret 创建/撤销、凭证使用（不记录明文）

## Impact
- Affected specs:
  - 连接器与密钥托管（最小授权/安全托管/使用可审计/外发受控）
  - Skill 运行时（networkPolicy 与 egressSummary）
  - 审计域（新增 connector/secret 事件）
  - 工作流与审批（V2 扩展点：高风险启用/扩权/轮换审批）
- Affected code:
  - DB：新增 connectors/connector_instances/secret_records（或等价）迁移
  - API：新增 /connectors/* 与 /secrets/* 路由
  - Worker：为后续 connector 调用路径预留接口（MVP 可只落 API/存储/审计）

## ADDED Requirements

### Requirement: ConnectorType/ConnectorInstance（MVP）
系统 SHALL 支持连接器类型与实例的最小管理：
- ConnectorType：{ name, provider, authMethod, defaultRiskLevel, defaultEgressPolicy }
- ConnectorInstance：{ tenantId, scopeType(tenant/space/user), scopeId, typeName, status(enabled/disabled), egressPolicyOverride? }

#### Scenario: 创建连接器实例
- **WHEN** 管理者创建 ConnectorInstance
- **THEN** 系统写入实例记录并写审计（resourceType=connector, action=create）

### Requirement: SecretRecord（加密托管 + 撤销）
系统 SHALL 以 SecretRecord 形式托管凭证：
- ownerScope：tenant/space/user
- connectorInstanceRef
- encryptedPayload（MVP：对称加密；不引入明文读 API）
- status：active/revoked

#### Scenario: 创建 SecretRecord
- **WHEN** 管理者为连接器实例写入凭证
- **THEN** 系统加密存储并写审计（resourceType=secret, action=create）
- **AND** 响应不包含凭证明文

#### Scenario: 撤销 SecretRecord
- **WHEN** 管理者撤销 SecretRecord
- **THEN** status 变为 revoked 并写审计（resourceType=secret, action=revoke）

### Requirement: 受控使用（禁止明文读取）
系统 SHALL 禁止任何 API 返回 SecretRecord 明文；工具/运行时只能通过受控 connector 调用路径使用凭证（MVP：提供受控“存在性校验 + policy 校验”接口，后续扩展到真实外部调用）。

#### Scenario: 禁止明文读取
- **WHEN** 任意客户端尝试读取 SecretRecord payload
- **THEN** 系统返回拒绝（稳定 errorCode）并写审计

### Requirement: 外发受控（EgressPolicy 对齐）
系统 SHALL 将连接器的 allowedDomains 与运行时 networkPolicy.allowedDomains 对齐：
- 默认拒绝
- allowedDomains 白名单才能放行

#### Scenario: 启用外发白名单
- **WHEN** 连接器实例声明 allowedDomains
- **THEN** 仅允许该集合内域名出站（按运行时生效）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

