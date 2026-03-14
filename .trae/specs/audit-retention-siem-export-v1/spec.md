# 审计域：保留策略（Retention/Legal Hold）与导出（SIEM Export）V1 Spec

## Why
《架构-06》要求审计不仅 append-only 与可验真，还要具备合规必需的“保留策略/冻结（legal hold）/归档与对外导出（SIEM）”。当前系统已有审计写入与 hashchain 校验，但缺少保留与导出闭环，无法支撑合规取证、外部审计与安全运营对接。

## What Changes
- 审计保留策略（V1）：
  - 支持按 tenant 定义 `retentionDays`（默认保留，不做删除）
  - 支持 legal hold（冻结范围/原因/状态），用于未来归档/清理的豁免判定
- 审计导出（V1）：
  - 新增审计导出作业：按筛选条件导出为 JSON Lines（jsonl）
  - 导出结果写入 artifact，并返回可下载的 artifactRef
  - 导出过程与结果本身写入审计（resourceType=audit，action=export.*）
- 权限与安全（V1）：
  - 导出与保留策略变更受 RBAC 控制（resourceType=audit）
  - 导出内容仅包含审计事件“可比较的结构化字段 + 既有脱敏 digest”，不得输出 secrets 明文

## Impact
- Affected specs:
  - 审计域（合规：保留/冻结/导出）
  - 数据平面（artifact 作为导出落地介质）
  - 工作流与自动化（导出作业异步化、可重试）
- Affected code:
  - DB：新增 `audit_retention_policies / audit_legal_holds / audit_exports`
  - API：`auditRoutes` 增加 retention/legal-hold/export 端点
  - Worker：新增 audit export job 处理器（生成 artifact）

## ADDED Requirements
### Requirement: 审计保留策略（V1）
系统 SHALL 支持为 tenant 配置审计保留策略：
- `retentionDays`（正整数；默认值表示不主动清理）
- 该策略用于“归档/清理”作业的判定依据（V1 不实现物理删除）

#### Scenario: 读取与更新保留策略
- **WHEN** 管理者读取 `GET /audit/retention`
- **THEN** 返回当前 tenant 的保留策略（含默认值）
- **WHEN** 管理者提交 `PUT /audit/retention`
- **THEN** 更新策略并写入审计事件（action=retention.update）

### Requirement: Legal Hold（冻结）管理（V1）
系统 SHALL 支持创建与管理 legal hold，用于冻结特定范围的审计记录以满足合规取证：
- hold 字段（V1）至少包含：`scope(tenant|space)`、`spaceId?`、`from?`、`to?`、`subjectId?`、`traceId?`、`runId?`、`reason`、`status(active|released)`、`createdBy`、`createdAt`
- 任何“归档/清理”作业在计算候选范围时 MUST 排除 active hold 覆盖的范围

#### Scenario: 创建与释放 legal hold
- **WHEN** 管理者 `POST /audit/legal-holds` 提交冻结条件与原因
- **THEN** 返回 holdId 且写入审计（action=legalHold.create）
- **WHEN** 管理者 `POST /audit/legal-holds/:id/release`
- **THEN** 状态变为 released 且写入审计（action=legalHold.release）

### Requirement: 审计导出作业（V1）
系统 SHALL 提供审计导出能力，将符合筛选条件的审计事件导出为 jsonl 并落地为 artifact：
- 创建导出：`POST /audit/exports`
- 查询导出：`GET /audit/exports`、`GET /audit/exports/:id`
- 导出筛选条件（V1）至少支持：`from/to`、`spaceId`、`subjectId`、`action`、`toolRef`、`workflowRef`、`traceId`
- 导出结果字段（V1）仅包含 audit_events 已存字段与脱敏 digest（不得包含 secrets）

#### Scenario: 创建导出并获得 artifactRef
- **WHEN** 管理者创建导出作业并轮询状态
- **THEN** 作业完成后返回 `artifactRef` 可用于下载导出文件
- **AND** 导出请求/生成/失败都会写入审计（export.requested/generated/failed）

### Requirement: 权限与最小暴露（V1）
系统 SHALL 对以下能力进行 RBAC 授权控制（resourceType=audit）：
- `audit.read`（已有）
- `audit.verify`（已有）
- `audit.export`（新增）
- `audit.retention.update`（新增）
- `audit.legalHold.manage`（新增）

导出内容约束（V1）：
- MUST 不输出任何 secret plaintext
- MUST 复用审计事件内的 inputDigest/outputDigest（已脱敏）

## MODIFIED Requirements
无

## REMOVED Requirements
无

