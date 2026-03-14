# Governance Tool Network Policy UI（工具出站网络策略界面）V1 Spec

## Why
平台已落地“工具出站网络策略治理”后端能力（`tool_network_policies` + governance API），但治理控制面缺少可视化入口，无法让管理员在控制台完成策略配置、审计与排障，违背《架构设计.md》中“控制台入口统一、治理控制面完成路由/配额/发布/回滚/审计等操作”的交互目标。

因此需要在 Governance Console 的工具治理页面中补齐“出站网络策略”配置与查看能力。

## What Changes
- 扩展治理页面：`/gov/tools`
  - 新增 “Network Policy” 配置区：按 toolRef + scope（space/tenant）编辑 `allowedDomains`
  - 新增 “Network Policies” 表格：展示当前 scope 下的策略列表（toolRef、allowedDomainsCount、updatedAt）
- 新增 i18n 文案（zh-CN/en-US）用于上述新增 UI
- 错误处理：复用现有治理页面错误展示规范（errorCode/message/traceId）

## Impact
- Affected specs:
  - 治理控制面（工具运行时出站治理可视化配置）
  - Skill Runtime（出站策略的运维入口）
- Affected code:
  - Web：`apps/web/src/app/gov/tools/*`
  - Web locales：`apps/web/src/locales/*`

## ADDED Requirements

### Requirement: GovToolNetworkPolicyEditUiV1
系统 SHALL 在 `/gov/tools` 增加 network policy 编辑能力：
- 数据源：
  - `PUT /governance/tools/:toolRef/network-policy`
  - `GET /governance/tools/:toolRef/network-policy`
- 表单字段：
  - `scopeType`：`space | tenant`（默认 space）
  - `toolRef`：string
  - `allowedDomains`：textarea（按行输入域名；UI 端 trim + 去空行）
- 行为：
  - **WHEN** 用户点击“Load”
  - **THEN** 调用 GET 显示当前策略（若 404 则提示不存在）
  - **WHEN** 用户点击“Save”
  - **THEN** 调用 PUT 保存并提示成功，随后刷新列表

#### Scenario: 权限不足
- **WHEN** 后端返回 403
- **THEN** 页面显示 `AUTH_FORBIDDEN`（含 traceId）

### Requirement: GovToolNetworkPoliciesListUiV1
系统 SHALL 在 `/gov/tools` 增加 network policies 列表展示：
- 数据源：`GET /governance/tools/network-policies?scopeType=space|tenant&limit=...`
- 表格列（V1 最小集合）：
  - `toolRef`
  - `allowedDomainsCount`
  - `updatedAt`

### Requirement: GovToolNetworkPolicyUiI18nV1
系统 SHALL 增加并使用 i18n key（示例）：
- `gov.tools.networkPolicyTitle`
- `gov.tools.networkPolicyScopeType`
- `gov.tools.networkPolicyToolRef`
- `gov.tools.networkPolicyAllowedDomains`
- `gov.tools.networkPolicyLoad`
- `gov.tools.networkPolicySave`
- `gov.tools.networkPoliciesTitle`
- `gov.tools.allowedDomainsCount`

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

