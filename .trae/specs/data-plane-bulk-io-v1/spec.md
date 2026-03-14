# 数据平面：导入/导出（Bulk IO）V1 Spec

## Why
《架构-04 数据平面》明确导入导出属于高风险能力，需要与 Workflow 联动实现异步执行、可重试、可取消、可审计，并确保导出数据字段级裁剪与安全脱敏。当前平台缺少统一的导入/导出入口与“导出产物 artifact”模型，导致无法运营化与合规化交付数据批处理能力。

## What Changes
- 新增导出 API（V1）：`POST /entities/:entity/export`，以 Workflow Run/Step 异步产出导出产物
- 新增导入 API（V1）：`POST /entities/:entity/import`（支持 dry-run 预检），写入同样走 Workflow
- 新增数据产物（Artifact）模型（V1）：记录导入/导出产物元信息与可下载内容引用
- 下载与访问控制（V1）：`GET /artifacts/:artifactId/download`（鉴权 + 作用域校验 + DLP）
- 安全策略（V1）：
  - 导出/导入强制执行 Schema 校验与字段级规则（read/write）
  - 仅允许 JSONL/JSON 格式（V1），并限制最大体积（防止 DoS）
  - 所有动作写审计（仅摘要，不记录原文数据）

## Impact
- Affected specs:
  - 数据平面（通用 CRUD、查询、导入导出）
  - 工作流引擎（Run/Step、重试、取消）
  - Safety/DLP（导出下载与审计摘要脱敏）
  - AuthZ（fieldRules read/write 强制执行）
- Affected code:
  - DB：新增 artifacts（或 data_artifacts）表；导入/导出作业记录绑定 run/step
  - API：新增导入/导出路由与 artifacts 下载路由
  - Worker：新增 jobType=entity.export/entity.import 的处理逻辑（复用现有数据面校验与写入逻辑）

## ADDED Requirements

### Requirement: Artifact 模型（V1）
系统 SHALL 提供数据产物（Artifact）一等对象，用于承载导入/导出结果。
- 最小字段（V1）：
  - artifactId、tenantId、spaceId、type（export/import_report）
  - format（jsonl/json）、contentType、byteSize
  - contentRef（V1 可为 DB 存储或本地文件引用）
  - createdBySubjectId、createdAt、expiresAt（可选）
  - source（entityName、schemaName、queryDigest 或 importBatchDigest）
  - runId/stepId（可选）

#### Scenario: 产物创建与可追溯
- **WHEN** 导出/导入作业生成产物
- **THEN** 产物记录包含 runId/stepId 与来源摘要
- **AND** 审计中可通过 traceId/runId 追溯到产物

### Requirement: 导出 API（V1）
系统 SHALL 提供异步导出接口：
- `POST /entities/:entity/export`

请求体（V1）：
- schemaName（可选，默认 core）
- query（可选，复用 Entity Query DSL 的 filters/orderBy/cursor/limit 语义；导出内部可分片拉取）
- select（可选）：导出字段白名单（仅 payload 字段；必须可读）
- format：`jsonl`（默认）或 `json`

响应（V1）：
- receipt：{ correlation:{requestId,traceId,runId,stepId?}, status }
- runId

#### Scenario: 导出成功
- **WHEN** 用户请求导出并完成执行
- **THEN** 生成 artifact(type=export) 并可下载
- **AND** 导出内容已按 fieldRules.read 裁剪

### Requirement: 导入 API（V1）
系统 SHALL 提供导入接口：
- `POST /entities/:entity/import`

请求体（V1）：
- schemaName（可选，默认 core）
- format：`jsonl`（默认）或 `json`
- mode：`dry_run|commit`（默认 dry_run）
- records：数据数组（V1 限制最大条数与总字节数）
- idempotencyKey：写入幂等键（commit 必填；dry_run 可选）

响应（V1）：
- dry_run：返回预检报告（acceptedCount/rejectedCount/reasonsDigest）
- commit：返回 receipt + runId（异步写入）

#### Scenario: dry-run 预检
- **WHEN** 用户以 dry_run 导入
- **THEN** 返回将被写入/拒绝的统计与原因摘要（不落库写入）

#### Scenario: commit 导入成功
- **WHEN** 用户以 commit 导入并执行完成
- **THEN** 记录批次写入结果摘要（成功/失败计数、首批错误摘要）
- **AND** 所有写入必须通过 schema 校验与 fieldRules.write 约束

### Requirement: 下载与 DLP（V1）
系统 SHALL 提供下载接口：
- `GET /artifacts/:artifactId/download`

约束（V1）：
- 必须鉴权并校验 tenant/space 作用域一致
- 输出内容进入 DLP（deny 模式下可拒绝下载）

#### Scenario: 无权限下载被拒绝
- **WHEN** 用户尝试下载非本租户/非本空间产物
- **THEN** 返回 403（policy_violation）并写审计

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

