# Policy Snapshot Explain（策略决策解释 API）V1 Spec

## Why
平台的不变式要求“策略先于执行、决策可解释、可回放”。当前系统虽已固化 Policy Snapshot，但缺少标准化的“解释入口”，导致：
- 运维/审计/客服无法快速回答“为什么允许/拒绝、哪些规则命中、有哪些字段/行级限制”
- 治理控制面与执行中心无法用一致方式展示决策摘要（易产生旁路/重复实现）
- 回放与复盘缺少可稳定引用的“决策解释契约”

因此需要提供一个受控、可审计、可脱敏的 Policy Snapshot Explain API，作为 UI 与治理工具的统一依赖。

## What Changes
- 新增治理端 API：获取某个 Policy Snapshot 的解释信息（Explain View）
- 访问控制：仅允许具备治理权限的主体读取（按 tenant/space scope 校验）
- 输出脱敏：仅返回结构化摘要（roleIds/permissions 列表、fieldRules/rowFilters、reason、时间、关联引用），不返回明文 payload 或密钥
- 可追溯：对 explain 行为写审计（包含 snapshotId、traceId、result）

## Impact
- Affected specs:
  - 认证与授权（Policy Snapshot 可解释输出）
  - 审计域（读取 explain 的审计记录）
  - 治理控制面 / 执行中心（后续可消费 explain API）
- Affected code:
  - API routes：新增治理路由
  - Auth 模块：policySnapshotRepo 查询扩展（如需）
  - Shared types：解释输出契约（如有公共类型）
  - Tests：e2e 覆盖访问控制与输出形态

## ADDED Requirements

### Requirement: PolicySnapshotExplainEndpointV1
系统 SHALL 提供治理端策略解释接口：
- `GET /governance/policy/snapshots/:snapshotId/explain`

返回结构（V1） SHALL 至少包含：
- `snapshotId`：string
- `tenantId`：string
- `spaceId`：string | null
- `resourceType`：string
- `action`：string
- `decision`："allow" | "deny"
- `reason`：string | null
- `matchedRules`：包含 `roleIds` 与 `permissions`（resource_type/action 及其可用的 fieldRules/rowFilters 摘要）
- `fieldRules`：最终字段级规则（可为 null）
- `rowFilters`：最终行级规则（可为 null）
- `createdAt`：string（ISO）

#### Scenario: 查询成功
- **WHEN** 具备治理权限的主体请求 explain 接口且 snapshot 属于其 tenant/space
- **THEN** 返回 200 且 body 满足上述结构

#### Scenario: 越权访问被拒绝
- **WHEN** 主体不具备治理权限或 snapshot 不属于其 tenant/space
- **THEN** 返回 403 或 404（不泄露存在性），并写审计为拒绝

### Requirement: ExplainOutputRedactionV1
Explain 输出 MUST 不包含敏感明文：
- 不返回任何 step input/output 明文、secret/connector token、加密包络内容
- matchedRules 中允许返回 permission 的结构化元数据（resource/action 与 rule 摘要）

### Requirement: ExplainAuditEventV1
系统 SHALL 对 explain 行为写审计：
- `resourceType="policy_snapshot"`
- `action="explain"`
- `inputDigest` 至少包含 `snapshotId`
- `result` 记录 success/denied/not_found

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

