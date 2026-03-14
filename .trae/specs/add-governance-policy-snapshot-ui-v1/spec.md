# Governance Policy Snapshot UI（策略快照界面）V1 Spec

## Why
架构要求“策略先于执行、决策可解释、可回放”。目前后端已具备 `policy snapshot explain` 与 `policy snapshots list` 的治理接口，但控制台缺少可用的 UI 入口，导致授权排障只能靠手工拼 URL/查表，无法在治理控制面形成标准化的排查路径与证据链。

因此需要在 Governance Console 增加“策略快照”页面：可按时间线浏览、筛选，并查看单条快照的解释信息。

## What Changes
- 新增治理控制台页面：
  - `GET /gov/policy-snapshots`：列表页（scope/过滤条件/分页）
  - `GET /gov/policy-snapshots/:snapshotId`：详情页（Explain View）
- 导航与 i18n：
  - 在侧边栏 Governance 区域增加“策略快照”入口
  - 增加对应中英文本地化 key
- UI 行为：
  - 列表页支持按 scope（space 默认、tenant 可选）与常用维度筛选
  - 详情页显示解释输出（decision/reason/matchedRules/fieldRules/rowFilters）并提供复制 snapshotId/snapshotRef
  - 对 403/404 等错误以统一错误展示（errorCode/message/traceId）

## Impact
- Affected specs:
  - 交互平面（治理控制面 UI）
  - 认证与授权（Policy Snapshot 可解释/可检索的产品化入口）
  - 审计域（治理查询行为可追溯，复用后端已落库审计）
- Affected code:
  - Web：`apps/web/src/app/gov/*`
  - Web Shell：侧边栏导航与 locales
  - Web API client：复用现有 `lib/api.ts` 的 fetch 模式

## ADDED Requirements

### Requirement: GovernancePolicySnapshotsListPageV1
系统 SHALL 提供治理控制台策略快照列表页：
- **Route**：`/gov/policy-snapshots`
- **Data source**：`GET /governance/policy/snapshots`

列表页 SHALL 提供：
- scope 选择：`space | tenant`（默认 `space`）
- 筛选项（可选）：`subjectId`、`resourceType`、`action`、`decision`
- 分页：使用 `nextCursor` 进行“加载更多”
- 表格列（V1 最小集合）：`createdAt`、`decision`、`resourceType`、`action`、`subjectId`、`spaceId`、`snapshotId`

#### Scenario: space scope 默认
- **WHEN** 用户打开列表页且不选择 scope
- **THEN** 列表请求 MUST 使用 `scope=space` 并只显示当前 space 下快照

#### Scenario: tenant scope 可选
- **WHEN** 用户切换为 `scope=tenant`
- **THEN** 列表请求 MUST 使用 `scope=tenant` 并允许显示不同 space 的快照

### Requirement: GovernancePolicySnapshotDetailPageV1
系统 SHALL 提供治理控制台策略快照详情页：
- **Route**：`/gov/policy-snapshots/:snapshotId`
- **Data source**：`GET /governance/policy/snapshots/:snapshotId/explain`

详情页 SHALL 显示：
- 快照元信息：`snapshotId/createdAt/resourceType/action/tenantId/spaceId/subjectId`
- 决策信息：`decision/reason`
- 规则信息：`matchedRules/fieldRules/rowFilters`（以 JSON/可折叠方式展示即可）

#### Scenario: 链接跳转
- **WHEN** 用户在列表页点击某条记录
- **THEN** 跳转到详情页并加载该 snapshot 的 explain 数据

### Requirement: GovernancePolicySnapshotUiErrorHandlingV1
UI MUST 统一处理错误返回：
- **WHEN** 后端返回 403
- **THEN** 展示 `AUTH_FORBIDDEN`（含 traceId）
- **WHEN** 后端返回 404
- **THEN** 展示 `NOT_FOUND`（含 traceId）

### Requirement: GovernancePolicySnapshotNavV1
系统 SHALL 在治理侧边栏增加“策略快照”导航入口，并支持 i18n：
- key：`gov.nav.policySnapshots`

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

