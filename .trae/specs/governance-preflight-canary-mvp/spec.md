# 治理控制面（Governance）Preflight + Canary MVP Spec

## Why
当前治理变更已具备变更集（draft→submitted→approved→released）与回滚能力，但仍缺少《架构-16》强调的两类关键治理门槛：发布前的**差异预检（dry-run / preflight）**与**灰度发布（按空间逐步启用/回退）**。需要先落地最小可用闭环，让高风险变更具备“先看影响面再发布、先灰度再全量、可随时回滚”的可运营路径。

## What Changes
- 新增 Changeset Preflight（MVP）：对变更集产出可比对的影响面摘要与回滚预览
- 新增 Changeset Canary（MVP）：支持把同一变更集先发布到一组 space（canaryTargets），再提升为全量发布
- 新增空间级 activeToolRef 覆盖（MVP）：canary 阶段不影响全租户默认版本
- 新增审计对齐：preflight/canaryRelease/promote/rollback 全部写审计（只写摘要）

## Impact
- Affected specs:
  - 治理控制面（发布、灰度、回滚、评测准入的前置形态）
  - 工具注册表（active 版本指针的空间级覆盖）
  - BFF/API 统一请求链路与审计域（治理动作审计）
  - 工作流与自动化（工具执行链路可见的启用状态变化）
- Affected code:
  - DB：新增 changeset 扩展字段、tool_active_overrides（space 级）
  - API：新增 /governance/changesets/:id/preflight 与 canary/promote 相关路由；修改 /tools 与 /tools/:name 返回 effective activeToolRef
  - Tests/Docs：新增 e2e 覆盖 preflight、canary→promote→rollback

## ADDED Requirements

### Requirement: Changeset Preflight（差异预检）
系统 SHALL 为任意变更集提供可重复计算的 preflight 摘要，用于发布前评审与准入。
- 入口：`POST /governance/changesets/:id/preflight`
- 输出 SHALL 至少包含：
  - gate：{ riskLevel, requiredApprovals, approvalsCount }
  - plan：按顺序列出将要应用的动作（kind + 目标 scope + toolRef/name）
  - currentStateDigest：对当前启用状态/active 指针的摘要（仅 keys/digests）
  - rollbackPreview：若发布成功，rollback 将恢复到的摘要（仅摘要）
  - warnings：潜在风险提示（例如：高风险工具、审批不足、目标空间为空）
- preflight MUST 写审计（resourceType=governance, action=changeset.preflight）

#### Scenario: 预检输出影响面摘要
- **WHEN** 对一个含 tool.enable + tool.set_active 的变更集执行 preflight
- **THEN** 返回包含动作列表与回滚预览的摘要
- **AND** 不改变任何运行期状态（只读）

### Requirement: Canary 发布与提升（灰度→全量）
系统 SHALL 支持把变更集先应用到一组指定 space，再提升为全量发布。
- Changeset 需支持 canaryTargets：spaceId 列表（空则拒绝 canary 发布）
- canary 发布入口：`POST /governance/changesets/:id/release?mode=canary`
  - 规则：只对 canaryTargets 写入 tool_rollouts 与 space 级 active 覆盖
  - 变更集状态：记录 canaryReleasedAt（具体存储字段实现自定，但必须可审计/可追溯）
- 提升为全量入口：`POST /governance/changesets/:id/promote`
  - 规则：将同一变更应用到 changeset.scope（space 或 tenant），并清理 canary 覆盖（以避免双重来源）
- canary/promote MUST 写审计（action=changeset.release_canary / changeset.promote）

#### Scenario: 先灰度后全量
- **WHEN** 变更集先 canary 发布到 spaceA/spaceB
- **THEN** spaceA/spaceB 生效，其它空间不生效
- **WHEN** promote
- **THEN** 全量生效并保留回滚路径

### Requirement: 空间级 activeToolRef 覆盖
系统 SHALL 支持 space 级 activeToolRef 覆盖以配合 canary。
- 新增存储：tool_active_overrides（tenant_id, space_id, name, active_tool_ref）
- 工具查询接口 SHALL 返回 effectiveActiveToolRef：
  - space 级覆盖优先于 tenant 默认 activeToolRef

#### Scenario: canary 不影响全局默认
- **WHEN** canary 阶段设置 spaceA 的 active 覆盖
- **THEN** spaceA 返回覆盖版本，spaceB 返回 tenant 默认版本

## MODIFIED Requirements

### Requirement: Release 必须具备可预检与可灰度路径
系统 SHALL 在 release 流程中支持：
- 预检（preflight）产物可被审计与用于准入决策
- canary→promote 的灰度路径（按 space）

## REMOVED Requirements
（无）

