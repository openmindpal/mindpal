# 管理台轻量化界面（Console UI）V1 Spec

## Why
当前管理台页面以功能可用为先，但页面风格偏“工具页/原型页”，信息层级不够清晰，与《架构设计.md》提出的“轻便 Console、低噪声、现代治理 UI”目标不一致。需要一套轻量、清晰、可扩展的管理台界面骨架，并在不改变权限与统一请求链路的前提下提升可用性。

## What Changes
- 引入统一的管理台外壳（AppShell）：顶部 Header + 左侧导航 + 内容区（响应式）。
- 统一信息层级：PageHeader + PageBody；列表类页面默认使用表格/卡片与轻量状态标记。
- 轻便 Console 首页化：/settings 作为管理台入口，分区卡片化展示模型、通道、技能、定时任务；默认懒加载（按分区拉取）。
- 治理入口折叠：uiMode=simple 时隐藏治理入口，仅保留直达 URL（仍由 RBAC 强制保护）；uiMode=governance 时显示治理入口分组。
- 统一错误与状态呈现：按标准错误模型（errorCode/message/traceId），列表/动作具备 loading/empty/error 三态。
- i18n 规范化：TS/TSX 不直接出现中文；界面文案全部落到 `src/locales/*.json`，使用 `t(locale,key)` 渲染。
- 仅参考外部产品的信息架构与交互密度，不引入第三方代码/素材/商标。

## Impact
- Affected specs: 交互平面（UI）与页面配置、治理控制面（Admin Console）、认证与授权（RBAC 展示层折叠）
- Affected code:
  - Web：`apps/web/src/app/layout.tsx`、`apps/web/src/app/page.tsx`、`apps/web/src/app/settings/*`、`apps/web/src/app/admin/*`
  - Web 组件：新增 `AppShell`、`SideNav`、`PageHeader`、`Card`、`Table` 等基础组件与样式
  - 文案：`apps/web/src/locales/zh-CN.json`、`apps/web/src/locales/en-US.json`

## ADDED Requirements
### Requirement: 管理台统一外壳
系统 SHALL 为管理台页面提供统一 AppShell（Header + SideNav + Content）。

#### Scenario: 导航分组与模式折叠
- **WHEN** uiMode=simple
- **THEN** SideNav 仅显示“Console”分组（设置、模型绑定、通道管理、技能、定时任务）
- **AND** “Governance”分组默认不显示（仍允许直达 URL，由后端 RBAC 决策）
- **WHEN** uiMode=governance
- **THEN** SideNav 显示“Governance”分组（UI 配置、RBAC、审计等现有入口）

### Requirement: 轻便 Console 分区卡片化
系统 SHALL 在 `/settings` 以卡片分区呈现 4 个能力区块，并支持分区级刷新。

#### Scenario: 懒加载与状态三态
- **WHEN** 用户打开 `/settings`
- **THEN** 默认仅渲染分区骨架与“加载/刷新”按钮
- **AND** 每个分区独立触发拉取并显示 loading/empty/error 状态
- **AND** error 展示包含 errorCode + message + traceId（如有）

### Requirement: 统一页面信息层级
系统 SHALL 统一管理台页面结构为 PageHeader + PageBody：
- PageHeader：标题、关键状态（如 uiMode）、主按钮（如刷新）、更多菜单（可选）
- PageBody：仅展示当前任务必需信息；其余进入折叠区或分区卡片

### Requirement: i18n 与 lint 约束
系统 SHALL 满足 Web 的 `check-no-zh` 约束：
- TS/TSX 代码中不直接包含中文
- 所有可见文案以 key 的形式维护在 locales，并支持 zh-CN/en-US 回退

## MODIFIED Requirements
### Requirement: 设置页作为 Console 入口
`/settings` 从“仅模式切换”升级为管理台入口页，但不改变任何后端授权边界与请求链路。

## REMOVED Requirements
无

