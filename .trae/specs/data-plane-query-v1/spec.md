# 数据平面：结构化查询（Entity Query）V1 Spec

## Why
当前实体 API 仅支持按更新时间倒序分页读取（`GET /entities/:entity`），缺少结构化过滤/排序/投影能力，无法承载数据平面在《架构-04 数据平面》中定义的“安全结构化查询表达”。需要提供一个可校验、可裁剪、可审计的通用查询入口。

## What Changes
- 新增结构化查询接口：`POST /entities/:entity/query`
- 新增 Query DSL（V1）：字段过滤（eq/in/contains/gt/gte/lt/lte）、排序、游标分页、字段投影
- 查询安全与合规（V1）：
  - 仅允许对“可读字段”进行过滤/排序/投影
  - 所有查询必须绑定 tenant/space 作用域，使用参数化 SQL，禁止字符串拼接 where
  - 返回结果在 API 层进行字段级裁剪（复用现有 fieldRules）
- 审计摘要（V1）：记录查询口径摘要（entity、filtersDigest、order、limit、cursor）不记录敏感原文

## Impact
- Affected specs:
  - 数据平面（通用 CRUD 与查询）
  - AuthZ 字段级裁剪（fieldRules）
  - Audit（查询摘要）
- Affected code:
  - API：新增 entities query 路由
  - Data Repo：新增 queryRecords（结构化过滤/排序/游标）
  - Schema 校验：根据 schema 校验字段存在性与类型匹配

## ADDED Requirements

### Requirement: Entity Query API（V1）
系统 SHALL 提供结构化查询接口：
- `POST /entities/:entity/query`

请求体（V1）：
- `schemaName`（可选，默认 `core`）
- `filters`（可选）
  - 支持 `and/or` 组合
  - 支持运算符：`eq`、`in`、`contains`、`gt/gte/lt/lte`
- `orderBy`（可选）：`[{ field, direction: 'asc'|'desc' }]`（V1 限制最多 2 个字段）
- `select`（可选）：返回字段白名单（仅 payload 字段；系统字段始终返回 id/revision/createdAt/updatedAt）
- `limit`：1~200（默认 50）
- `cursor`（可选）：游标对象（V1 使用 `updatedAt + id` 组合）

响应（V1）：
- `items`：记录数组（payload 已裁剪）
- `nextCursor`（可选）：用于下一页
- `summary`：{ `countApprox?`、`filtersDigest`、`orderBy`、`limit` }

#### Scenario: 正常查询
- **WHEN** 用户对某实体发起 query（含 filters/order/select/limit）
- **THEN** 返回 items，并在需要时返回 nextCursor
- **AND** 每条记录的 payload 已按 fieldRules 进行可读裁剪

### Requirement: 过滤/排序/投影字段必须可读（V1）
系统 SHALL 在执行查询前，根据 policyDecision.fieldRules.read 约束：
- filters 中引用的字段必须可读
- orderBy 中引用的字段必须可读
- select 中引用的字段必须可读

#### Scenario: 查询使用不可读字段被拒绝
- **WHEN** filters/orderBy/select 引用不可读字段
- **THEN** 返回 400（policy_violation），且审计记录拒绝原因摘要

### Requirement: 字段存在性与类型匹配校验（V1）
系统 SHALL 在执行查询前，根据 effective schema 校验：
- filters/orderBy/select 的字段必须存在于 schema 的 entity.fields
- 运算符与字段类型兼容（例如 number 才允许 gt/gte/lt/lte）

#### Scenario: 非法字段或类型不匹配
- **WHEN** 查询字段不存在或运算符/值类型不匹配
- **THEN** 返回 400 并给出稳定错误码（BAD_REQUEST）

### Requirement: 安全查询生成（V1）
系统 SHALL：
- 使用参数化 SQL 生成 where/order/limit/cursor 条件
- 禁止将用户输入直接拼接到 SQL 字符串中

## MODIFIED Requirements

### Requirement: 现有实体列表接口（保持兼容）
现有 `GET /entities/:entity` 行为 SHALL 保持不变，作为 query API 的简化路径。

## REMOVED Requirements
（无）

