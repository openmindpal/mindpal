# ABAC 演进体系化与证据链强约束 V1 Spec

## Why
当前系统已具备 RBAC/字段裁剪/行级过滤与 Policy Snapshot 的基础能力，但缺少体系化的“策略可解释/可调试/缓存失效/治理闭环”与“答案证据链强约束”的全局契约，导致排障链路割裂、缓存一致性依赖经验、以及知识类回答的审计可追溯性不足。

## What Changes
- 策略调试面板（API + 控制台 UI）：提供可控的“策略评估/预检/解释”入口，统一输出解释摘要并可追溯到 Policy Snapshot。
- 策略缓存失效体系（Epoch）：引入 tenant/space 维度的 `policyCacheEpoch`，RBAC/ABAC 变更自动 bump，运行时缓存以 epoch 作为强一致失效信号；提供治理侧可视化与手动失效入口（含审计）。
- 治理闭环最小集：提供“策略变更→epoch 变化→审计记录→可解释快照”的可串联链路；支持通过 changeset 发布“失效/刷新”类操作（最小可控治理动作）。
- 知识层证据链强约束：当答案依赖检索证据时，系统强制“答案必须携带引用证据并写入审计”，形成跨路由/跨运行时的一致契约；未满足契约时拒绝输出或降级为不可发布状态。
- **BREAKING**：对启用“证据链强约束”的链路，缺少证据的最终回答将不再被视为成功输出（返回错误码或进入待处理状态，见 Requirements）。

## Impact
- Affected specs:
  - enhance-policy-dsl-schema-migrations-tracing-v1（ABAC/DSL 与预检理念）
  - add-policy-snapshot-list-v1、add-policy-decision-explain-v1、add-governance-policy-snapshot-ui-v1（策略快照检索/解释/UI）
  - add-knowledge-search-tool-v1、complete-rag-and-offline-sync-product-loop-v1（检索日志/证据链引用）
- Affected code:
  - API：治理策略接口与 RBAC 写链路（policy cache epoch bump + 审计）
  - API：治理 changeset（新增 item kind：policy.cache.invalidate 或等价）
  - Worker：编排器/运行时输出契约（证据链强约束与审计）
  - Web：治理控制台新增 Policy Debugger 页面与缓存状态展示
  - Shared：EvidenceRef/AnswerEnvelope 契约与错误码

## ADDED Requirements

### Requirement: PolicyDebuggerEvaluateEndpointV1
系统 SHALL 提供治理端策略调试评估接口：
- `POST /governance/policy/debug/evaluate`

Request（V1）SHALL 包含：
- `scopeType`: `"tenant" | "space"`
- `scopeId`: string
- `subjectId`: string
- `resourceType`: string
- `action`: string
- `context`（可选）：用于调试的最小上下文对象（例如：`entityName`、`record`、`requestedFields`），不得包含 secret/connector 明文
- `mode`（可选）：`"read" | "write"`（默认 `"read"`）

Response（V1）SHALL 包含：
- `decision`: `"allow" | "deny"`
- `reason`: string | null
- `policySnapshotId`: string（UUID，可用于后续 explain 与分享）
- `matchedRulesSummary`: 结构化摘要（roleIds、permissions 计数、命中规则类型、涉及字段路径集合）
- `fieldRulesEffective`: json | null
- `rowFiltersEffective`: json | null
- `warnings`: string[]（例如 unsupported expr、字段路径不存在等）

#### Scenario: 调试评估成功且可回溯
- **WHEN** 具备治理权限的主体提交评估请求
- **THEN** 系统返回 200 并返回 `policySnapshotId`
- **AND** 随后 `GET /governance/policy/snapshots/:snapshotId/explain` 可读取对应解释摘要

#### Scenario: 调试输入非法可解释
- **WHEN** 请求包含不合法的 rowFilters/字段路径
- **THEN** 系统返回 400 且 errorCode=`POLICY_DEBUG_INVALID_INPUT`
- **AND** messageI18n 指出失败原因分类（不返回 SQL 原文）

#### Scenario: 越权被拒绝
- **WHEN** 主体不具备治理权限
- **THEN** 返回 403（不泄露更多信息）

### Requirement: PolicyCacheEpochV1
系统 SHALL 引入策略缓存 epoch（强一致失效信号）：
- 每个 `(tenantId, scopeType, scopeId)` 维护一个 `policyCacheEpoch`（单调递增整数或等价标识）
- 运行时的授权决策缓存 key MUST 包含 `policyCacheEpoch`
- epoch bump 后，旧缓存 MUST 在下一次读取时失效（无需等待 TTL）

#### Scenario: RBAC/ABAC 变更触发 epoch bump
- **WHEN** 发生任意影响授权决策的写操作（例如 role_permissions、role_bindings、fieldRules/rowFilters 变更）
- **THEN** 系统 MUST bump 对应 scope 的 `policyCacheEpoch`
- **AND** 写入审计 `policy_cache.epoch_bumped`（包含 scope 与 newEpoch）

### Requirement: PolicyCacheGovernanceInvalidateV1
系统 SHALL 提供治理端手动失效接口（用于紧急排障）：
- `POST /governance/policy/cache/invalidate`

Request（V1）：
- `scopeType`: `"tenant" | "space"`
- `scopeId`: string
- `reason`: string（必填，进入审计）

Response（V1）：
- `previousEpoch`: number
- `newEpoch`: number

#### Scenario: 手动失效可追溯
- **WHEN** 治理主体调用失效接口
- **THEN** epoch 递增并返回新旧值
- **AND** 写审计事件，包含 `reason`

### Requirement: PolicyCacheInvalidateChangeSetKindV1
系统 SHALL 支持通过治理变更集触发策略缓存失效（最小治理闭环动作）：
- changeset item kind：`policy.cache.invalidate`
- payload：`{ scopeType, scopeId, reason }`

#### Scenario: 通过 changeset 失效
- **WHEN** 变更集 release 执行 `policy.cache.invalidate`
- **THEN** epoch bump 成功并在 rollbackPreview 中显示不可逆提示（仅提示，不做回滚）

### Requirement: EvidenceContractV1
系统 SHALL 定义“答案证据链”统一契约（V1）：
- `EvidenceRef`：包含 `retrievalLogId`、`evidenceRef`、`snippet`（最小片段）、`source`（最小元数据）等字段
- `AnswerEnvelope`：包含 `answer`、`evidence[]`、`evidencePolicy`（required/optional/none）、`traceId`

### Requirement: EvidenceRequiredWhenRetrievalUsedV1
当一次运行/请求使用了检索（如 knowledge.search 或等价 retrieval pipeline）时：
- 系统 MUST 将该回答的 `evidencePolicy` 设为 `required`
- 最终回答 MUST 携带至少 1 条 `EvidenceRef`，且其 `retrievalLogId` 指向本次运行产生的检索日志
- 若不满足：系统 MUST 以稳定错误码拒绝将该输出视为成功（错误码：`EVIDENCE_REQUIRED`）

#### Scenario: 满足证据链契约
- **WHEN** 运行产生检索日志并生成最终回答
- **THEN** 最终回答包含 evidence[]
- **AND** 系统写审计事件 `knowledge.answer`，关联 `runId/stepId` 与 `retrievalLogIds`

#### Scenario: 缺失证据链被拒绝
- **WHEN** 运行使用检索但最终回答未携带证据
- **THEN** 系统返回/记录 `EVIDENCE_REQUIRED`
- **AND** 写审计事件 `knowledge.answer.denied`（包含原因摘要，不包含明文）

## MODIFIED Requirements

### Requirement: Orchestrator/Collab 输出契约扩展
系统 SHALL 扩展编排器/协作运行时的输出结构以携带 `AnswerEnvelope`（或等价字段集合），并保证 reveal/详情页可展示证据链引用与 traceId。

## REMOVED Requirements
无

