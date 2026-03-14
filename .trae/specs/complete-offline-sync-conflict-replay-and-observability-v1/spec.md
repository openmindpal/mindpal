# 架构-15 闭环补齐：离线同步冲突解决与可回放合并摘要 + 可观测性 V1 Spec

## Why
当前离线同步已具备 push/pull、幂等与基础冲突输出，但仍缺少“冲突分类→确定性合并摘要→可视化修复→可回放验证”的闭环；同时可观测性虽已有 OTel tracing 开关与 API metrics（/metrics），但尚未形成“跨链路关联 + 业务 SLO + 治理侧看板”的可运营能力。

## What Changes
- 扩展离线同步冲突能力：引入冲突分类、冲突修复工单（ticket）与可回放的合并运行（merge run）
- 扩展同步返回摘要：`sync.push` 输出确定性合并摘要（canonical + digest）并生成可回放引用
- 增加同步回放验证 API：根据 mergeId 获取 transcript 并可验证 digest
- 增加治理侧可观测性摘要 API：基于审计/指标生成业务 SLO 汇总与关键错误聚合
- 增加治理看板页面：展示 SLO、错误分布与关键链路概览

## Impact
- Affected specs:
  - 离线同步（Sync：变更日志、冲突与可回放）MVP：扩展冲突分类、摘要与回放/修复闭环
  - 审计域（统一链路可追溯）：新增同步合并运行与证据/回放相关审计事件
  - 可观测性（tracing/metrics/logs）：补齐业务 SLO 与治理看板
- Affected code:
  - API：/sync、/governance 新增/扩展路由与返回结构
  - DB：新增 sync_merge_runs / sync_conflict_tickets（或等价）
  - Web：新增 /gov/observability 与 /gov/sync-conflicts（或合并到现有治理入口）
  - Tests：e2e 覆盖冲突分类、摘要确定性、回放验证与观测摘要

## ADDED Requirements

### Requirement: 冲突分类（Conflict Class）
系统 SHALL 对 `sync.push` 的 rejected/conflicts 输出进行可枚举的冲突分类，并保持稳定语义，便于端侧呈现与自动化决策。

#### ConflictClass（V1）
- `base_version_stale`：baseVersion 落后于服务端当前版本
- `field_write_write`：同一字段存在并发写（服务端/客户端都修改）
- `schema_mismatch`：schemaVersion 不匹配或字段不存在
- `authz_denied`：授权拒绝导致无法应用（字段裁剪/写权限）
- `validation_failed`：输入校验失败（类型/范围/必填）
- `unknown`：无法归类的错误（保留原始原因摘要）

#### Scenario: 返回冲突分类
- **WHEN** 客户端 push 包含无法应用的 op
- **THEN** 服务端返回 `conflicts[]`，每项包含 `conflictClass`
- **AND** 返回字段包含：`opId`、`targetRef`、`baseVersion`、`serverVersion?`、`fieldPaths?`、`reasonCode`、`hints?`

### Requirement: 确定性合并摘要（Deterministic Merge Summary）
系统 SHALL 为一次 `sync.push` 生成确定性合并摘要，并支持回放验证。

#### MergeRun（V1）
- 系统 SHALL 为每次 `sync.push` 创建一个 `mergeRun`（合并运行）记录，包含：
  - `mergeId`（稳定标识）
  - `scope`（tenantId/spaceId）
  - `inputDigest`（输入摘要：opId/contentDigest 序列的 digest）
  - `mergeDigest`（合并摘要 digest：canonical transcript 的 digest）
  - `transcript`（可回放 transcript，见下）

#### Transcript Canonicalization（V1）
- transcript SHALL 采用 canonical JSON（字段排序、无冗余空白）以确保 digest 稳定
- transcript SHALL 包含：
  - `mergeId`
  - `accepted[]`：已接收并应用的 op 列表（按 opId 升序）
  - `rejected[]`：被拒绝的 op 列表（按 opId 升序）
  - `conflicts[]`：冲突详情（按 opId 升序；内部字段稳定排序）
  - `sideEffectsSummary`：对记录版本、字段变更的摘要（不包含敏感原文）

#### Scenario: 相同输入得到相同合并摘要
- **GIVEN** 同一 scope、同一服务端状态、同一 ops 集合（忽略提交顺序）
- **WHEN** 发起 `sync.push`
- **THEN** 返回的 `mergeDigest` 必须一致
- **AND** 返回的 transcript（canonical 形式）必须一致

### Requirement: 冲突修复工单（Repair Ticket）
系统 SHALL 在存在可修复冲突时生成冲突修复工单（ticket），支持端侧/治理侧可视化修复并再次提交。

#### Ticket（V1）
- `ticketId`
- `mergeId`（来源 merge run）
- `status`：`open | resolved | abandoned`
- `conflicts[]`（用于 UI 渲染的结构化冲突详情）

#### Scenario: 生成修复工单
- **WHEN** `sync.push` 返回存在 `conflicts[]` 且可修复（非 authz_denied / validation_failed）
- **THEN** 系统创建 `ticketId` 并在响应中返回 `repairTicketId`

#### Scenario: 解决冲突并生成新的 merge run
- **WHEN** 端侧提交 resolution（例如按 fieldPath 选择 server/client/merged 值）
- **THEN** 系统生成新的 `mergeRun`，并把 ticket 标记为 resolved

### Requirement: 合并回放验证（Replay）
系统 SHALL 提供按 `mergeId` 获取 transcript 并验证 digest 的能力，用于问题复盘、合规审计与回归验证。

#### API（V1）
- `GET /sync/merge-runs/:mergeId` -> `{ mergeId, inputDigest, mergeDigest, transcript }`
- `POST /sync/merge-runs/:mergeId/verify` -> `{ ok: boolean, recomputedDigest, expectedDigest }`

#### Scenario: 回放验证通过
- **WHEN** 调用 verify
- **THEN** 服务端以相同 canonicalization 规则重新计算 transcript digest
- **AND** 若一致返回 ok=true，否则 ok=false 且输出差异摘要（不含敏感原文）

### Requirement: 可观测性上下文关联（Trace/Logs/Audit）
系统 SHALL 统一并贯穿可观测性上下文字段，确保跨 API/Worker/治理查询可关联。

#### Context Fields（V1）
- `traceId`、`requestId`：所有 API 审计事件与关键日志必须包含
- `runId`、`stepId`：工作流/作业执行相关事件必须包含
- `taskId`：collab/agent runtime 相关事件必须包含（如有）

#### Scenario: 治理侧可按 traceId 定位链路
- **WHEN** 在治理侧输入 traceId
- **THEN** 可检索到同 traceId 的审计事件集合，并可区分 API/Worker 子链路

### Requirement: 业务 SLO 汇总与治理看板（V1）
系统 SHALL 提供最小可运营的业务 SLO 汇总，并在治理侧可视化展示。

#### SLO 集合（V1，最小集）
- API 可用性：成功率（2xx/总请求）按 routePattern 聚合
- API 延迟：p50/p95（或等价分位近似）按 routePattern 聚合
- 同步质量：sync.push 冲突率（conflicts/ops）按 space 聚合（可匿名化）
- 检索质量：knowledge.search 成功率与空结果率（如适用）

#### API（V1）
- `GET /governance/observability/summary?window=1h|24h` -> `{ window, routes[], sync[], knowledge[], topErrors[] }`

#### Scenario: 看板展示 SLO
- **WHEN** 打开治理看板
- **THEN** 展示所选窗口内 SLO 汇总与 topErrors
- **AND** 提供 drill-down 到 audit 查询（traceId/action/resourceType）

## MODIFIED Requirements

### Requirement: sync.push 返回结构扩展
系统 SHALL 在 `sync.push` 响应中新增：
- `mergeId`、`mergeDigest`、`repairTicketId?`
- `mergeSummary`（不包含敏感 payload 原文）

**BREAKING**：若现有客户端严格校验 response schema，需更新客户端以接受新增字段（字段新增不应破坏宽松解析）。

## REMOVED Requirements
（无）

