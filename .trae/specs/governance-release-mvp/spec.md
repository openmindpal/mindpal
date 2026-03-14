# 治理控制面（Governance）Release MVP Spec

## Why
平台已具备 Schema/Tool/Page 等“发布”能力，但缺少治理控制面的关键不变式落地：**默认拒绝**（新能力默认不可用）与 **可回滚**（可一键禁用/切换稳定版本）以及全过程审计。需要按《架构-16-治理控制面-发布灰度回滚与评测.md》先落地最小可治理闭环。

## What Changes
- 新增 Tool 启用开关（MVP）：按 tenant/space 维度启用/禁用某个 toolRef
- 新增 Tool 版本“当前稳定版本”指针（MVP）：同名工具在租户内维护一个 active toolRef 供编排/前端默认选择
- 新增治理 API（MVP）：enable/disable/setActive/list（全部写审计）
- 新增执行护栏（MVP）：/tools/:toolRef/execute 仅允许执行“在当前 scope 已启用”的 toolRef

## Impact
- Affected specs:
  - 治理控制面（默认拒绝、可回滚、审计可追溯）
  - AI 编排层（默认工具版本选择与可用性约束）
  - 工作流与自动化（工具执行链路的治理闸门）
  - 审计域（治理动作审计）
- Affected code:
  - DB：新增 tool_rollouts/tool_active_versions（或等价结构）
  - API：新增 /governance/tools/* 路由；修改 /tools/:toolRef/execute 增加启用校验
  - Worker：无需改动执行逻辑（由 API 做治理闸门），仅保证审计串联不变

## ADDED Requirements

### Requirement: 默认拒绝（Tool 启用开关）
系统 SHALL 以“启用开关”实现默认拒绝：未启用的 toolRef 不可被执行。
- 作用域：tenant + space（MVP 先支持 space 级；tenant 级作为全局默认）
- 规则：空间级配置优先于租户级默认
- 默认行为：新发布的 toolRef 默认 disabled（除非显式 enable）

#### Scenario: 未启用工具被拒绝
- **WHEN** 用户调用 `POST /tools/:toolRef/execute` 且该 toolRef 在当前 space 未启用
- **THEN** 返回 `403`（errorCode=TOOL_DISABLED 或等价稳定错误码）
- **AND** 写审计（result=denied，errorCategory=policy_violation，不泄露敏感原文）

#### Scenario: 启用后可执行
- **WHEN** Space Admin 启用某 toolRef
- **THEN** 该 space 内允许执行该 toolRef
- **AND** 禁用后立即生效（无缓存穿透风险）

### Requirement: 可回滚（切换当前稳定版本）
系统 SHALL 支持为同名工具维护“当前稳定版本”（active toolRef），用于默认选择与快速回退。
- API SHALL 支持设置 active toolRef（必须属于同名工具且已 released）
- API SHALL 在列出工具/版本时返回 active toolRef

#### Scenario: 切换 active 版本
- **WHEN** 将 active 从 `tool@2` 切换为 `tool@1`
- **THEN** 后续“默认选择”使用 `tool@1`
- **AND** 动作写审计（resourceType=governance, action=tool.set_active）

### Requirement: 治理动作审计
系统 SHALL 对以下治理动作写审计（仅摘要）：
- enable/disable toolRef（scope=tenant/space）
- setActive toolRef

## MODIFIED Requirements

### Requirement: 工具执行链路必须经过治理闸门
系统 SHALL 在 `POST /tools/:toolRef/execute` 入口增加启用校验：
- 若 toolRef 未启用，则拒绝并可审计
- 若启用，则按现有流程创建 job/run/step 并投递队列

## REMOVED Requirements
（无）

