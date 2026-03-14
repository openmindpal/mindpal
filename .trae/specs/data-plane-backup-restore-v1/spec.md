# 数据平面：备份/恢复（Backup & Restore）V1 Spec

## Why
《架构-04》要求在不破坏平台不变式（统一请求链路、鉴权/授权/审计不可跳过）的前提下提供可恢复能力，覆盖误操作与数据损坏，并将备份/恢复纳入治理（严格权限、审批门槛、可追溯审计、可回放作业）。当前平台已具备 artifacts 与异步 Bulk IO，但缺少“可回放的备份/恢复作业”与对应 API。

## What Changes
- 新增空间级逻辑备份（V1）：`POST /spaces/:spaceId/backups`
- 新增空间级恢复（V1）：`POST /spaces/:spaceId/restores`
- 新增备份列表/查看（V1）：`GET /spaces/:spaceId/backups`、`GET /backups/:backupId`
- 复用 Artifact 下载（V1）：备份产物以 artifact 形式存储与下载（沿用 `GET /artifacts/:artifactId/download`）
- 异步执行（V1）：backup/restore 以 Workflow Run/Step 异步执行（jobType=space.backup / space.restore）
- 安全与审计（V1）：
  - 强制鉴权与作用域校验（tenant/space 不可越界）
  - 备份/恢复写审计（仅摘要），并固化 policySnapshotRef 以支持回放解释

## Impact
- Affected specs:
  - 数据平面（备份恢复）
  - 工作流引擎（Run/Step、重试、取消）
  - 审计域（backup/restore 行为审计）
  - 安全中枢（下载/恢复的 DLP 拦截点）
- Affected code:
  - DB：新增 backups（元信息）表；可复用 artifacts 表存放备份内容与报告
  - API：新增 backups/restores 路由
  - Worker：新增 jobType=space.backup / space.restore 的处理分支

## ADDED Requirements

### Requirement: 备份对象（V1）
系统 SHALL 提供 Backup 一等对象，记录备份元信息与可追溯性。
- 最小字段（V1）：
  - backupId、tenantId、spaceId、status（created/running/succeeded/failed/canceled）
  - scope：`space`
  - schemaName（默认 core）
  - entityNames（V1 可选：为空表示全量实体；否则指定实体集）
  - backupArtifactId（成功后关联 artifacts）
  - reportArtifactId（可选，失败/完成报告）
  - policySnapshotRef、createdBySubjectId、createdAt/updatedAt
  - runId/stepId（用于串联执行生命周期）

#### Scenario: 创建备份可追溯
- **WHEN** 用户创建备份请求
- **THEN** 返回 backupId 与 receipt（含 runId/stepId）
- **AND** 审计记录 backup.create（仅摘要）

### Requirement: 空间级逻辑备份 API（V1）
系统 SHALL 提供空间级逻辑备份接口：
- `POST /spaces/:spaceId/backups`

请求体（V1）：
- schemaName（可选，默认 core）
- entityNames（可选）
- format：`jsonl`（默认）或 `json`

行为（V1）：
- 异步执行，worker 将实体数据导出为 backup artifact（type=backup，format=jsonl/json）
- 导出内容必须按 fieldRules.read 做字段级裁剪（不可读字段不出现在备份中）

响应（V1）：
- backupId
- receipt：{ correlation:{requestId,traceId,runId,stepId}, status }

#### Scenario: 备份成功生成产物
- **WHEN** 备份作业成功完成
- **THEN** backup 关联 backupArtifactId
- **AND** 可通过 artifact download 获取备份内容

### Requirement: 恢复 API（V1）
系统 SHALL 提供空间级恢复接口：
- `POST /spaces/:spaceId/restores`

请求体（V1）：
- backupArtifactId（必填）
- mode：`dry_run|commit`（默认 dry_run）
- conflictStrategy：`fail|upsert`（默认 fail）
- target：`same_space|new_space`（V1 默认 same_space；new_space 作为后续扩展点）
- schemaName（可选，默认 core）

行为（V1）：
- dry_run：预检备份内容格式、schema 兼容性、字段可写性与冲突影响面摘要（不写入）
- commit：异步写入，worker 产出 restore_report artifact（type=restore_report）

响应（V1）：
- dry_run：返回摘要（acceptedCount/rejectedCount/conflictsDigest）
- commit：返回 receipt（runId/stepId）与 restoreReportArtifactId（完成后可查询）

#### Scenario: 恢复前强制预检
- **WHEN** 用户请求 commit 恢复
- **THEN** 系统 MUST 支持 dry_run 预检，并在审计中记录预检摘要

### Requirement: 访问控制与不可越界（V1）
系统 SHALL：
- 禁止跨租户恢复（backupArtifactId 所属 tenant 必须与请求 tenant 一致）
- 禁止跨空间恢复到非目标空间（V1：artifact.spaceId 必须与 :spaceId 一致）
- download/restore 均进入 DLP（denyTargets=artifact:download / backup:restore）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

