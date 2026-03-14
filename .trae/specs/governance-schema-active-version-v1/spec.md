# Schema 治理：Active 版本指针与回滚 V1 Spec

## Why
《架构-03-元数据平面》与《架构-16-治理控制面》要求 Schema 变更具备可治理闭环：默认通过统一链路发布、可追溯、并且**可一键回滚到上一稳定版本**。当前系统发布 Schema 仅依赖“最新 released 版本即生效”，缺少“当前稳定版本（active）”的显式指针与回滚路径，导致一旦发布出现问题无法快速稳定切回。

## What Changes
- 引入 Schema 的 active 版本指针（tenant 级，V1 可选支持 space 覆盖）
- 新增治理 API：设置 active 版本、回滚到上一稳定版本（均写审计）
- 调整 Schema 读取与数据面依赖：`/schemas/:name/latest` 与数据写入校验从“最新 released”改为“当前 active”
- 增加约束：active 只能指向同名 schema 的已 released 版本

## Impact
- Affected specs:
  - 元数据平面（Schema Registry 的版本语义与发布/回滚）
  - 数据平面（通用 CRUD 的校验依赖 active schema）
  - 治理控制面（发布/回滚/审计）
- Affected code:
  - DB：新增 schema_active_versions（可选：schema_active_overrides）
  - API：schemas 路由与 metadata/schemaRepo 扩展；governance 新增 schema 管理路由
  - Tests：e2e 覆盖 setActive/rollback 与数据写入使用 active 的行为

## ADDED Requirements

### Requirement: SchemaActivePointerV1
系统 SHALL 为每个 tenant 的每个 schemaName 维护一个“当前稳定版本”指针：
- 存储：`schema_active_versions(tenant_id, name, active_version, updated_at)`
- `active_version` MUST 指向该 `name` 的已 released 版本

#### Scenario: 读取 latest 等于 active
- **WHEN** 调用 `GET /schemas/:name/latest`
- **THEN** 返回 `active_version` 对应的 schema（而不是最大 version）

### Requirement: GovernanceSetActiveSchemaV1
系统 SHALL 提供治理接口设置 active schema 版本：
- `POST /governance/schemas/:name/set-active`
- body：`{ version: number, scopeType?: "tenant" | "space" }`（V1 默认 tenant）
- 访问控制：仅允许具备治理权限的主体（resourceType=governance, action=schema.set_active 或等价）
- 审计：写入 `resourceType="governance"`, `action="schema.set_active"`，digest 至少包含 name/version/scopeType

#### Scenario: 设置 active 成功
- **WHEN** 管理者将 `core` 的 active 设置为 version=3
- **THEN** `/schemas/core/latest` 返回 version=3
- **AND** 后续数据写入校验以 version=3 的 schema 为准

### Requirement: GovernanceRollbackSchemaV1
系统 SHALL 提供治理接口回滚 schema 到上一稳定版本：
- `POST /governance/schemas/:name/rollback`
- 行为：将 active_version 切换到“上一 released 版本”（按 version 倒序，排除当前 active）
- 若不存在上一版本：返回稳定错误码（例如 `SCHEMA_NO_PREVIOUS_VERSION`）
- 审计：写入 `resourceType="governance"`, `action="schema.rollback"`，digest 至少包含 name/fromVersion/toVersion

#### Scenario: 回滚成功
- **WHEN** active=version=3 且存在 version=2
- **THEN** rollback 后 active=version=2
- **AND** `/schemas/:name/latest` 立即返回 version=2

### Requirement: OptionalSpaceOverrideV1
系统 MAY 支持 space 级 active 覆盖（用于灰度）：
- 存储：`schema_active_overrides(tenant_id, space_id, name, active_version, updated_at)`
- 解析优先级：space override > tenant active

## MODIFIED Requirements

### Requirement: SchemaPublishBehaviorV1
系统 SHALL 在发布新 released schema 时保持现有兼容性检查，并明确 active 行为：
- 发布成功后 MAY 自动将 active 指针切换到新版本（若未开启灰度）
- 或由治理显式 set-active 决定（若需要更严格门禁）

## REMOVED Requirements
（无）

