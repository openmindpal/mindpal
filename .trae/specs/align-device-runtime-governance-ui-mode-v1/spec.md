# Device Runtime 治理加固与 UI 模式对齐 Spec

## Why
当前仓库已实现 device-agent 与 device executions，但 DevicePolicy 的默认语义未做到“默认拒绝”，且 DeviceExecution 的 policySnapshotRef 未形成稳定可信的执行快照；同时 UI 的 simple/governance uiMode 与架构设计 0.2 “不做模式切换、由 RBAC/Policy 决定”存在冲突，需要统一对齐。

## What Changes
- Device Runtime：将设备侧执行的关键护栏提升为默认行为（默认拒绝、白名单、快照固化）
- Device Runtime：DeviceExecution 创建与领取都强制基于 DevicePolicy.allowedTools 的 allow-list（缺失即拒绝）
- Device Runtime：服务端在创建 DeviceExecution 时生成并固化 policySnapshotRef（不再信任调用方传入）
- Device Runtime：当调用方未显式指定 requireUserPresence 时，按工具风险默认开启本机确认
- 架构文档：更新 `架构设计.md`，将 Device Runtime 的“规划项”表述改为“已实现最小闭环（受控/默认拒绝）”并明确边界
- UI 模式：移除/禁用 simple/governance uiMode 切换链路，使“界面呈现由 RBAC/Policy 决定”成为唯一产品原则
- 架构文档：更新 `架构设计.md` 的 0.2 相关表述，使其与实际代码一致且无自相矛盾

- **BREAKING**：若当前环境依赖 `/settings/ui-mode` 或 spaces.ui_mode，将被移除或不再生效
- **BREAKING**：若某些设备未配置 DevicePolicy.allowedTools，设备将无法领取执行任务（默认拒绝）

## Impact
- Affected specs: Device Runtime / AuthZ Policy Snapshot / Governance 默认拒绝 / Console 产品策略
- Affected code:
  - API：device execution 路由与 repo、devices policy 写入、tool/permission 快照生成、settings/ui-mode 路由（如仍存在）
  - Web：ConsoleShell/AppShell 与 settings 页面（如仍存在 uiMode 展示/切换）
  - Docs：`d:\trae\openslin\架构设计.md`

## ADDED Requirements
### Requirement: DeviceExecution 默认拒绝与 allow-list
系统 SHALL 在设备领取与执行阶段实施“默认拒绝”的 DevicePolicy 护栏。

#### Scenario: 设备领取成功（allow-list 命中）
- **WHEN** device-agent 调用 `POST /device-agent/executions/:id/claim`
- **AND** device 处于 active
- **AND** 存在 DevicePolicy 且 allowedTools 非空，且包含 `toolRef` 的 toolName
- **THEN** 返回 claim 成功并进入 claimed 状态

#### Scenario: 设备领取拒绝（缺少策略/空 allow-list）
- **WHEN** device-agent 调用 `POST /device-agent/executions/:id/claim`
- **AND** DevicePolicy 不存在或 allowedTools 为空/缺失
- **THEN** 返回 403（policy_violation）并写审计摘要

#### Scenario: 管理侧创建拒绝（工具不在 allow-list）
- **WHEN** 管理侧调用 `POST /device-executions`
- **AND** 目标 device 的 DevicePolicy.allowedTools 不包含该 toolName
- **THEN** 返回 400/403 并写审计摘要（不创建 execution）

### Requirement: DeviceExecution policySnapshotRef 由服务端固化
系统 SHALL 在创建 DeviceExecution 时生成并固化 policySnapshotRef，且不信任调用方传入的快照引用。

#### Scenario: 创建 DeviceExecution 自动固化快照
- **WHEN** 管理侧调用 `POST /device-executions`
- **THEN** 服务端基于“目标工具对应的 resourceType/action”进行授权决策并产出 snapshotRef
- **AND** DeviceExecution.policySnapshotRef 存储为该 snapshotRef
- **AND** 审计 outputDigest 包含 snapshotRef 摘要

### Requirement: requireUserPresence 的安全默认值
系统 SHALL 在创建 DeviceExecution 时对高风险/非低风险工具默认开启 requireUserPresence（调用方未传入时）。

#### Scenario: 未传入 requireUserPresence
- **WHEN** 管理侧创建 DeviceExecution 未传 `requireUserPresence`
- **THEN** 若目标工具风险等级非 low，则 requireUserPresence 默认为 true

## MODIFIED Requirements
### Requirement: 架构设计文档的阶段边界与产品原则一致
`架构设计.md` SHALL 与仓库已实现能力保持一致，且对外表达清晰的阶段边界与默认拒绝原则。

#### Scenario: Device Runtime 章节对齐
- **WHEN** 阅读 `架构设计.md` 的 Device Runtime 相关段落
- **THEN** 文档明确该能力已实现的最小闭环与未纳入范围的扩展项
- **AND** 文档明确默认拒绝与关键护栏（allow-list、确认闸门、审计/证据）

### Requirement: 不提供 UI “模式切换”
系统 SHALL 不提供 simple/governance 的 uiMode 切换能力；界面可见性与可执行操作由 RBAC/Policy 决定。

#### Scenario: Web 控制台无模式切换入口
- **WHEN** 用户打开 Settings/Console
- **THEN** 不存在“交互模式/治理模式”切换 UI 或接口依赖

## REMOVED Requirements
### Requirement: `/settings/ui-mode` 与 spaces.ui_mode
**Reason**: 与“单一标准能力 + RBAC/Policy 决定界面呈现”的产品原则冲突。
**Migration**: 若需要“隐藏治理入口”，应使用 RBAC/Policy 控制访问与导航呈现，而非模式开关。

