# Governance Policy Snapshots List（策略快照列表查询）V1 Spec

## Why
平台要求“策略先于执行、决策可解释、可回放”。目前仅支持按 `snapshotId` 读取/解释，但缺少标准化的“列表查询入口”，导致问题排查与治理界面无法按 subject/space/时间线定位授权决策，更无法在执行中心做“从 run/step/audit 跳转到同一批决策”的聚合视图。

因此需要补齐治理端 `policy_snapshots` 的 list/filter/cursor 能力，并确保不泄露跨 scope 的数据存在性。

## What Changes
- 新增治理端列表接口：按 scope（tenant/space）、subjectId、resourceType/action、decision 与时间游标查询 policy snapshots
- 统一参数校验：snapshotId 统一为 UUID；列表接口对 limit/cursor 严格校验
- 访问控制：仅允许具备治理权限的主体访问；默认 scope=space（与大多数治理接口一致）
- 输出脱敏：仅返回结构化摘要字段（不包含任何 step input/output 明文）
- 审计：对 list 查询写审计（包含过滤条件摘要与返回数量）

## Impact
- Affected specs:
  - 认证与授权（policy snapshot 的治理可观测入口）
  - 审计域（治理查询行为可追溯）
  - 治理控制面/执行中心（后续 UI 可直接消费）
- Affected code:
  - API routes：新增治理路由
  - Auth：policySnapshotRepo 增加 list/search
  - Tests：e2e 覆盖权限与 scope 行为

## ADDED Requirements

### Requirement: GovernancePolicySnapshotsListEndpointV1
系统 SHALL 提供治理端策略快照列表接口：
- `GET /governance/policy/snapshots`

Query（V1）：
- `scope`：`tenant | space`，默认 `space`
- `subjectId`：可选 string（仅用于过滤；仅返回同 tenant 的记录）
- `resourceType`：可选 string
- `action`：可选 string
- `decision`：可选 `allow | deny`
- `limit`：可选 int，默认 50，最大 200
- `cursorCreatedAt`：可选 string(ISO)
- `cursorSnapshotId`：可选 string(UUID)

Response（V1）：
- `items`：数组，元素为 `PolicySnapshotSummary`
- `nextCursor`：可选，形如 `{ createdAt: string(ISO), snapshotId: string(UUID) }`

`PolicySnapshotSummary` SHALL 包含：
- `snapshotId`
- `tenantId`
- `spaceId`
- `subjectId`
- `resourceType`
- `action`
- `decision`
- `reason`
- `rowFilters`
- `fieldRules`
- `createdAt`

#### Scenario: 默认 space scope
- **WHEN** 主体调用列表接口且不提供 `scope`
- **THEN** 系统 MUST 仅返回 `spaceId = subject.spaceId` 的记录（若 subject 没有 spaceId，则返回 400）

#### Scenario: tenant scope
- **WHEN** 主体提供 `scope=tenant`
- **THEN** 系统 MUST 返回当前 tenant 下的记录（spaceId 可为不同值或 NULL）

#### Scenario: 越权被拒绝
- **WHEN** 主体不具备治理权限
- **THEN** 返回 403（`AUTH_FORBIDDEN`）且写审计为拒绝

### Requirement: GovernancePolicySnapshotsListPermissionV1
系统 SHALL 在治理端列表接口上强制权限校验：
- `resourceType = "governance"`
- `action = "policy_snapshot.read"`

### Requirement: GovernancePolicySnapshotsListAuditV1
系统 SHALL 对列表查询写审计：
- `resourceType="policy_snapshot"`
- `action="list"`
- `inputDigest` 包含 `scope/filters/limit`
- `outputDigest` 包含 `count/nextCursor`

### Requirement: PolicySnapshotNoSensitivePlaintextV1
列表输出 MUST 不包含任何敏感明文：
- 不返回 step input/output、加密包络、secret 明文
- matchedRules 允许返回结构化摘要（如需，V1 可先不返回 matchedRules）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）
