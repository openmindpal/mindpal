# AuthZ Row Filters（行级访问约束）V1 Spec

## Why
目前平台授权已覆盖资源级与字段级（Effective Schema/写入强约束），但对“同一实体内不同记录”的访问约束仍仅有 tenant/space 粒度隔离，缺少可演进的行级约束（rowFilters）来表达 owner、成员关系、项目归属等记录级规则。

依据 `架构设计.md` 与 `架构-05-认证与授权-AuthNAuthZ与RBAC.md` 的契约：AuthZ 必须输出 `rowFilters` 并由数据平面强制执行，以实现**最小权限、可解释、可回放（Policy Snapshot 固化）**的一致链路。

## What Changes
- 权限模型扩展（V1）
  - 为 `permissions` 增加 `row_filters_read/row_filters_write`（JSONB），用于描述 entity 记录的行级访问约束
- 数据模型扩展（V1）
  - 为 `entity_records` 增加 `owner_subject_id` 字段，并在读写路径强制使用（避免依赖 payload 字段命名一致性）
- 授权引擎增强（V1）
  - `authorize()` 合并命中的 rowFilters 输出到 decision，并写入 Policy Snapshot
- 数据平面强制执行（V1）
  - 读：`getRecord/queryRecords` 必须叠加 rowFilters（owner-only 时只返回本人记录）
  - 写：`insert/update/delete` 必须校验 rowFilters（owner-only 时仅允许 owner 更新；创建时 owner_subject_id 固定为 subjectId）
- 工具/工作流链路对齐（V1）
  - Tool 执行的 policy snapshot 与 toolContract 必须携带 rowFilters（防止 worker 路径绕过）

## Impact
- Affected specs:
  - 认证与授权（rowFilters 输出与快照固化）
  - 数据平面（CRUD/query 强制行级约束）
  - 工作流/工具执行（policy snapshot→worker 强制一致）
- Affected code:
  - DB：permissions、entity_records 迁移
  - AuthZ：authorize/Policy Snapshot 存储与返回
  - Data：dataRepo 查询/写入路径
  - Worker：tool.execute 的 entity 操作应用 rowFilters

## ADDED Requirements

### Requirement: PermissionRowFiltersSchemaV1
系统 SHALL 在 permission 维度支持行级规则存储：
- `permissions.row_filters_read`：JSONB
- `permissions.row_filters_write`：JSONB

V1 仅定义一种标准表达：
- `{"kind":"owner_only"}`：仅允许访问 `owner_subject_id = subjectId` 的记录

#### Scenario: owner_only 生效
- **WHEN** 主体仅获得带 `row_filters_read={"kind":"owner_only"}` 的 entity.read 权限
- **THEN** 对同一 entity 的查询结果 MUST 仅包含 `owner_subject_id=subjectId` 的记录

### Requirement: RowFiltersMergePolicyV1
系统 SHALL 定义并实现稳定的 rowFilters 合并策略（同一 subject 在同一 scope 下多 permission 合并）：
- V1 合并规则：
  - 若任一命中 permission 的 row_filters_* 为 NULL，则视为“不施加行级限制”（最终 rowFilters 为空）
  - 否则若所有命中 permission 均为 `owner_only`，则最终 rowFilters 为 `owner_only`
  - 其他组合在 V1 视为不支持，必须拒绝发布/拒绝执行（errorCode 例如 `POLICY_UNSUPPORTED_ROW_FILTERS`）

### Requirement: PolicySnapshotIncludesRowFiltersV1
系统 SHALL 将最终 rowFilters 写入 Policy Snapshot，并在 decision 中返回：
- **WHEN** authorize() 完成授权
- **THEN** decision.rowFilters MUST 可用于数据平面强制执行

### Requirement: EntityRecordsOwnerSubjectIdV1
系统 SHALL 为 entity_records 引入并维护 `owner_subject_id`：
- **WHEN** 创建记录
- **THEN** `owner_subject_id` MUST 被设置为当前 subjectId（不允许由客户端输入覆盖）
- **AND** 后续更新不得改变 `owner_subject_id`

### Requirement: DataPlaneEnforcesRowFiltersV1
系统 SHALL 在数据平面强制执行 rowFilters：
- **WHEN** 读路径（get/query/list/export）
- **THEN** 必须叠加 rowFilters（owner_only 时过滤为 owner 记录）
- **WHEN** 写路径（create/update/delete/import/restore）
- **THEN** 必须校验 rowFilters（owner_only 时仅 owner 可修改/删除；创建固定 owner）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

