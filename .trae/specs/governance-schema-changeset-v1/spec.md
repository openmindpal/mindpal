# Schema 治理变更集（Changeset）V1 Spec

## Why
根据 `架构-03-元数据平面` 与 `架构-16-治理控制面`：Schema 属于核心契约，发布/回滚必须可追溯、默认拒绝（或显式启用路径）、支持预检与审批，并且具备稳定回滚路径。当前 schema 发布以 `/schemas/:name/publish` 直接落库为主，未纳入治理变更集（draft→submitted→approved→released→rolled_back）统一流程，难以与预检/灰度/评测准入等治理能力对齐。

## What Changes
- 将 schema 发布与 active 指针切换纳入 governance changeset：新增 changeset item kind
  - `schema.publish`：提交 schemaDef（draft 形态）并在 release 时发布为 released 版本
  - `schema.set_active`：将 active 指针切到指定 released 版本（tenant/space）
  - `schema.rollback`：将 active 指针回滚到上一 released 版本（tenant/space）
- Changeset Preflight 输出 schema 影响面摘要（仅摘要，不输出整份 schema 原文）
- Changeset Release/Promote/Rollback 对 schema 生效，并写入审计摘要
- **BREAKING**：推荐将 `/schemas/:name/publish` 收敛为“仅生成草稿或仅内部使用”；对外发布走 changeset（V1 可先保留旧接口但标记为 deprecated）

## Impact
- Affected specs:
  - 治理控制面（changeset/preflight/canary/release/rollback）
  - 元数据平面（schema 发布与版本语义、兼容性检查、active 指针）
  - 审计域（治理动作审计）
- Affected code:
  - governance/changeSetRepo：扩展 kind、preflight plan、release/rollback apply 逻辑与 rollbackData
  - metadata/schemaRepo：复用现有发布与 active 指针能力
  - routes/governance：新增 changeset item 的 schema 类入口（或复用通用 addItem 入口并扩展校验）
  - tests：e2e 覆盖 schema changeset 的 preflight/release/rollback

## ADDED Requirements

### Requirement: ChangeSetSchemaPublishV1
系统 SHALL 支持通过变更集发布 Schema：
- changeset item：`kind="schema.publish"`
- payload SHALL 包含：
  - `name`（schemaName）
  - `schemaDef`（draft schema，不含最终 version 或忽略客户端 version）
  - `mode`（可选：`tenant`/`space`，默认 tenant）
- release 行为：
  - 执行兼容性检查：对比当前 effective schema（scope 对齐）
  - 通过后调用发布逻辑生成新的 released 版本
  - 默认将 active 指针切换到新版本（除非 canary 模式要求覆盖到 space）
- 审计：`resourceType="governance"`, `action="changeset.release"`，digest 至少包含 schemaName/newVersion/compatResultDigest

#### Scenario: 发布 schema 通过 changeset 生效
- **WHEN** 创建 changeset 并添加 `schema.publish` item，提交→审批→release
- **THEN** schemas 表出现新 released 版本
- **AND** `/schemas/:name/latest` 返回新 active 版本（按 scope）

### Requirement: ChangeSetSchemaSetActiveV1
系统 SHALL 支持通过变更集切换 schema active 指针：
- changeset item：`kind="schema.set_active"`
- payload：`{ name, version, scopeType }`
- 校验：version 必须存在且 status=released
- 回滚数据：记录 fromVersion/toVersion

#### Scenario: changeset 切换 active
- **WHEN** release 应用 `schema.set_active`
- **THEN** `/schemas/:name/latest` 返回指定版本

### Requirement: ChangeSetSchemaRollbackV1
系统 SHALL 支持通过变更集回滚 schema active 指针：
- changeset item：`kind="schema.rollback"`
- payload：`{ name, scopeType }`
- 行为：将 active 指向上一 released 版本
- 若不存在上一版本：返回稳定错误码（例如 `SCHEMA_NO_PREVIOUS_VERSION`）

### Requirement: ChangeSetSchemaPreflightV1
系统 SHALL 在 preflight 输出 schema 影响面摘要：
- 输出 SHALL 至少包含：
  - `schemaName`
  - `currentActiveVersion`
  - `targetVersion`（若为 publish，则为“将发布的新版本（unknown yet）”并输出 `nextVersionHint`）
  - `compatibility`（ok/failed + reason digest）
  - `riskHints`（例如：新增实体/新增字段数/新增必填字段数）
- preflight MUST 为只读，不改变 schema/active

## MODIFIED Requirements

### Requirement: GovernanceReleaseConsistencyV1
系统 SHALL 通过统一的 changeset release/rollback 流程对 schema/tool 等治理对象生效，并保证：
- 动作顺序可预检
- 失败可回滚（至少恢复 active 指针）
- 全过程写审计（仅摘要）

## REMOVED Requirements
（无）

