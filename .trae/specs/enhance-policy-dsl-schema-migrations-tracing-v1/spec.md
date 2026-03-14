# 策略 DSL/ABAC、Schema 迁移策略与分布式 Tracing V1 Spec

## Why
当前平台的核心不变式（统一链路、默认拒绝、可审计可回放）已落地，但在三处仍停留在 MVP：策略表达（ABAC/DSL）、Schema 演进迁移体系、以及端到端分布式 tracing。需要补齐“可表达、可验证、可治理、可运营”的关键基础设施，避免平台后续扩展被这些能力瓶颈卡住。

## What Changes
- 扩展策略表达：在现有 RBAC 基础上引入 **Policy Expression DSL V1**，支持更通用的行级（row filter）表达，并提供解释器（interpreter）在数据面强制执行。
- 扩展策略管理体验：在 RBAC 管理页提供“可视化/表单化”的常用规则编辑，并保留高级 JSON 编辑模式；新增“预检/预览”能力，返回可解释摘要（不泄露敏感数据）。
- 补齐 Schema 演进/迁移体系：引入 Schema Migration 资源与在线迁移作业（批处理 backfill、双写/回填窗口），并与 schema 发布治理（changeset）联动。
- 引入端到端分布式 Tracing：接入 OpenTelemetry（API + Worker），实现 HTTP→队列→Worker 的 trace 上下文传播与导出。

## Impact
- Affected specs:
  - 架构-05 认证与授权（AuthZ/RBAC → ABAC 演进）
  - 架构-03 元数据平面（Schema Registry）
  - 架构-04 数据平面（通用 CRUD 与强制约束）
  - 架构-16 治理控制面（发布/预检/回滚门槛）
  - 架构-02 BFF 与统一请求链路（可观测性）
- Affected code:
  - API：授权引擎与策略快照（apps/api/src/modules/auth/*）
  - API：RBAC 管理接口与页面（apps/api/src/routes/rbac.ts，apps/web/src/app/admin/rbac/*）
  - API：Schema/治理（apps/api/src/routes/schemas.ts，apps/api/src/routes/governance.ts，migrations）
  - Data：实体查询与写入约束（apps/api/src/modules/data/*）
  - Worker：队列处理与作业（apps/worker/src/*）
  - Shared：策略决策结构与类型（packages/shared）

## ADDED Requirements

### Requirement: Policy Expression DSL V1（用于行级授权）
系统 SHALL 支持一种受控的、可验证的 Policy Expression DSL V1 来表达行级过滤规则（row filter）：
- 表达形式为 JSON AST（禁止任意代码执行）。
- 支持最小运算集合：`and`、`or`、`not`、`eq`、`in`、`exists`。
- 支持受控取值来源（operand）：
  - `subject.*`（如 subjectId、tenantId、spaceId）
  - `record.ownerSubjectId`
  - `payload.<fieldPath>`（仅限 Schema 中存在的字段路径）
- 解释器 MUST 以参数化方式将表达式转为 SQL where 条件（禁止字符串拼接注入）。
- 无法解释或包含未允许操作符/字段路径的表达式 MUST 返回“拒绝”并写入 policy snapshot（reason=unsupported_policy_expr）。

#### Scenario: ABAC 行级规则生效（owner + payload 组合）
- **WHEN** 管理员为某权限配置 rowFilters 为 `or(eq(record.ownerSubjectId, subject.subjectId), eq(payload.projectId, subject.subjectId))`
- **AND** 用户执行 entities.query/list/get
- **THEN** 仅返回满足表达式的记录
- **AND** 审计记录包含可解释摘要（命中规则类型、字段路径集合、决策）

### Requirement: 策略编辑与预检（RBAC 管理面）
系统 SHALL 在 RBAC 管理面提供策略编辑体验：
- 常用模板（owner_only、payload_field_eq_subject、payload_field_eq_literal、expr 组合）以表单/选择器呈现。
- 高级模式支持直接编辑 rowFilters JSON（仅对具备治理权限主体开放）。
- 提供“策略预检”接口：输入候选 rowFilters/fieldRules，返回可解释摘要（表达式是否合法、涉及的字段路径、是否会被拒绝），不得返回 SQL 原文与敏感数据。

#### Scenario: 策略预检失败可解释
- **WHEN** 管理员在 UI 中提交包含未知操作符的表达式
- **THEN** 预检返回 errorCode=POLICY_EXPR_INVALID 并指出不支持的节点类型

### Requirement: Schema Migration 资源与在线迁移作业（V1）
系统 SHALL 支持 Schema 迁移作为一等治理对象：
- 引入 SchemaMigration（资源）与 MigrationRun（执行）概念，支持以下最小迁移类型：
  - `backfill_required_field`：为新增必填字段回填默认值（批处理、可恢复）
  - `rename_field_dual_write`：在迁移窗口内支持旧字段读兼容、新字段写入并回填（双写/回填策略）
- 迁移执行 MUST 通过 Worker 队列异步运行，支持：
  - 分批处理（batch size 可配置）
  - 进度记录（processedCount/totalEstimate/lastCursor）
  - 可重试与失败分类
  - 可取消（将后续 batch 停止）
- 迁移过程 MUST 写审计摘要（不包含记录明文 payload）。

#### Scenario: 新增必填字段发布前要求迁移
- **WHEN** schema changeset preflight 检测到“新增必填字段且无默认值策略”
- **THEN** preflight 返回 requiresMigration=true 与 migrationPlan 摘要
- **AND** 未完成迁移前 release 返回 errorCode=MIGRATION_REQUIRED

### Requirement: Schema 发布治理与迁移联动（V1）
系统 SHALL 将 Schema Migration 与 schema 发布治理联动：
- schema.publish（changeset release）在存在 migration gate 时必须校验对应 MigrationRun 已成功完成。
- rollback 只回滚 schema active 指针，不自动回滚已落地数据迁移（数据回滚需显式迁移计划）。

### Requirement: OpenTelemetry Tracing（API + Worker）
系统 SHALL 提供端到端分布式 tracing（V1）：
- API 侧为每个请求创建 root span，并从入站 headers 解析父上下文（W3C traceparent）。
- API→Worker：入队的队列消息 MUST 携带 trace 上下文（traceparent + tracestate 或等价序列化形式）。
- Worker 侧处理 job 时 MUST 以该上下文作为父 span，并为关键阶段创建子 span（例如：step.process、db.query、tool.execute、subscription.tick）。
- Tracing 导出通过标准 OpenTelemetry exporter（OTLP）配置开启/关闭；关闭时不影响功能正确性。
- traceId/requestId 仍保留在响应字段中，并作为 span attribute 记录以便关联。

#### Scenario: HTTP→Queue→Worker 的 trace 连通
- **WHEN** 用户触发一个产生队列任务的请求（例如 backup/restore、workflow step）
- **THEN** 在 tracing 后端可看到同一 traceId 下的 API span 与 Worker span 链路

## MODIFIED Requirements

### Requirement: rowFilters 的兼容与扩展
系统 SHALL 兼容既有 rowFilters V1（owner_only、payload_field_eq_*、or）并新增支持 `expr` 形式：
- 旧规则按既有行为解释与执行
- 新规则可与旧规则共存（合并策略明确且可解释）

## REMOVED Requirements
（无）
