# Governance Tool Network Policy（工具出站网络策略治理）V1 Spec

## Why
《架构设计.md》明确“客户端上下文不可被信任”“出站治理必须由平台强制执行”。当前工具执行链路（`/tools/:toolRef/execute`、`/orchestrator/execute`）允许调用方携带 `networkPolicy.allowedDomains`，而 Worker 侧会基于该字段放行出站访问；这意味着“调用方可自提白名单绕过默认拒绝”，不符合“策略先于执行/默认拒绝/治理控制面统一下发”的不变式。

因此需要将工具出站网络策略收敛到治理控制面：由治理管理员配置每个 toolRef 的 `allowedDomains`，执行链路忽略客户端传入的 `networkPolicy`，仅使用治理侧策略（缺省为空=默认拒绝）。

## What Changes
- 新增 DB 表：`tool_network_policies`（按 tenant + scope + toolRef 存储 allowedDomains）
- 新增治理 API（V1）：
  - `GET /governance/tools/:toolRef/network-policy`
  - `PUT /governance/tools/:toolRef/network-policy`
  - `GET /governance/tools/network-policies`（便于治理列表页/排查）
- 执行链路行为变更（V1）：
  - `/tools/:toolRef/execute`、`/orchestrator/execute` 忽略请求体中的 `networkPolicy`
  - 从治理配置加载并写入 step.input.networkPolicy（供 Worker 执行）
- 审计（V1）：
  - governance API 写审计（read/update）
  - 执行链路在 outputDigest 中输出 `runtimePolicy.networkPolicyDigest`（仅摘要，不展开明细）

## Impact
- Affected specs:
  - Skill Runtime（出站治理必须可控且不可绕过）
  - 治理控制面（提供配置入口与审计）
  - 工作流执行（step input 携带受控 networkPolicy）
- Affected code:
  - DB migrations：新增表/索引
  - Governance routes + repo：network policy CRUD
  - Tool routes / Orchestrator routes：执行入参处理改为治理下发
  - Tests：e2e 覆盖“忽略客户端白名单”“治理配置生效/默认拒绝”

## ADDED Requirements

### Requirement: ToolNetworkPolicyStorageV1
系统 SHALL 存储工具出站网络策略（V1）：
- 表：`tool_network_policies`
- 主键：`(tenant_id, scope_type, scope_id, tool_ref)`
- 字段：
  - `allowed_domains`：JSONB array of string
  - `created_at/updated_at`

默认策略：
- 若不存在记录，则 `allowedDomains=[]`（默认拒绝出站）

### Requirement: GovernanceToolNetworkPolicyApiV1
系统 SHALL 提供治理 API 管理 tool network policy：
- `GET /governance/tools/:toolRef/network-policy`
  - 返回 `{ toolRef, scopeType, scopeId, allowedDomains, updatedAt }` 或 404
- `PUT /governance/tools/:toolRef/network-policy`
  - Body：`{ scopeType: "tenant"|"space", allowedDomains: string[] }`
  - Upsert 成功返回 `{ ok: true }`

权限（V1）：
- resourceType=`governance`
- action=`tool.network_policy.read|tool.network_policy.write`

### Requirement: ExecutionIgnoresClientNetworkPolicyV1
系统 MUST 在工具执行链路忽略客户端提供的 `networkPolicy`：
- **WHEN** 调用方请求 `/tools/:toolRef/execute` 或 `/orchestrator/execute`
- **THEN** 系统 MUST 不使用请求体中的 `networkPolicy`
- **AND** 系统 MUST 从治理配置加载 `networkPolicy` 并写入 step.input.networkPolicy

### Requirement: NetworkPolicyAuditAndDigestV1
系统 SHALL 满足可审计与不泄露：
- governance API MUST 写审计 inputDigest/outputDigest（不记录过长域名列表原文，可记录 count + sha256_8）
- 执行链路 outputDigest SHOULD 包含 `runtimePolicy.networkPolicyDigest`（例如 `{ allowedDomainsCount, sha256_8 }`）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

