# Console 模式开关与导航 Spec

## Why
当前平台已具备部分治理与管理能力，但缺少面向用户的“Console”入口与模式化信息架构，导致个人/企业两类使用方式无法清晰分层。

## What Changes
- 新增“交互模式”概念：个人简易模式与企业治理模式（按租户/空间维度生效，默认个人简易模式）。
- 新增模式配置的持久化与读取 API，并将其纳入统一请求链路与审计。
- Web 新增设置页，允许具备权限的用户切换模式并看到生效范围提示。
- Web 设置页扩展为“轻便 Console”入口，提供以下能力的最小可用管理/入口：
  - 模型绑定（Model Gateway Bindings）
  - 通道管理（Connectors / Secrets / Subscriptions）
  - 技能列表（Tools）
  - 定时任务（Subscriptions 的启用/停用与状态查看）
- Web 导航按模式分层：默认展示简易入口；治理入口在治理模式下显示。
- 既有治理页面（如 /admin/*）在简易模式下仍可通过直达 URL 访问，但必须继续由 RBAC 强制保护；仅做导航层折叠，不引入旁路权限。

## Impact
- Affected specs: 交互平面（UI）与页面配置、认证与授权（RBAC）、审计域（Audit）。
- Affected code: apps/web 导航与路由保护、apps/api 新增读取/写入模式配置接口、数据库迁移与配置表、审计写入逻辑。

## ADDED Requirements
### Requirement: UI 模式读取
系统 SHALL 在 Web 初始化与后续请求中能够读取当前空间的 uiMode（simple/governance）。

#### Scenario: 默认模式
- **WHEN** 空间未配置 uiMode
- **THEN** 返回 uiMode=simple

#### Scenario: 已配置模式
- **WHEN** 空间已配置 uiMode
- **THEN** 返回配置值，并提供 effectiveUiMode 字段（用于未来扩展 user override）

### Requirement: UI 模式切换
系统 SHALL 允许具备治理配置权限的主体修改空间 uiMode，并记录审计事件。

#### Scenario: 成功切换
- **WHEN** 具备权限的用户将 uiMode 从 simple 切换到 governance
- **THEN** 持久化配置并立即生效
- **AND** 写入审计（包含 subject、space、旧值/新值摘要、traceId）

#### Scenario: 无权限被拒绝
- **WHEN** 不具备权限的用户尝试修改 uiMode
- **THEN** 返回稳定的 errorCode（权限拒绝）
- **AND** 仍写入审计（拒绝原因摘要）

### Requirement: 导航分层与不变式约束
系统 SHALL 根据 uiMode 控制 Web 导航可见入口，但不改变后端授权边界。

#### Scenario: 简易模式导航
- **WHEN** uiMode=simple
- **THEN** 导航仅展示“简易 Console”入口（如设置、模型绑定等既有或占位页面）
- **AND** 隐藏治理入口（如治理发布、审计导出、RBAC 管理等）

#### Scenario: 治理模式导航
- **WHEN** uiMode=governance
- **THEN** 导航展示治理入口分组
- **AND** 每个入口仍受 RBAC 保护（前端仅做 UI 层折叠）

### Requirement: 轻便 Console 设置页能力聚合
系统 SHALL 在 Web `/settings` 提供“轻便 Console”的能力聚合入口，用于个人与团队的日常配置。

#### Scenario: 能力分区展示
- **WHEN** 用户访问 `/settings`
- **THEN** 页面至少包含：模型绑定、通道管理、技能列表、定时任务四个分区
- **AND** 每个分区的读写请求仍通过统一 API 请求链路并产生审计（由后端强制）

### Requirement: 模型绑定管理（最小可用）
系统 SHALL 允许具备相应权限的主体在设置页查看模型目录与当前 bindings，并创建新的 model binding。

#### Scenario: 查看与创建
- **WHEN** 用户打开“模型绑定”分区
- **THEN** 可查看 `GET /models/catalog` 与 `GET /models/bindings` 的结果摘要
- **AND** 可通过 `POST /models/bindings` 创建绑定（输入：modelRef/connectorInstanceId/secretId）

### Requirement: 通道管理（Connectors/Secrets/Subscriptions）
系统 SHALL 允许具备相应权限的主体在设置页查看 connector instances、secrets 与 subscriptions 的列表摘要，并进行必要的最小操作。

#### Scenario: 查看列表与关键动作
- **WHEN** 用户打开“通道管理”分区
- **THEN** 可查看 `GET /connectors/instances`、`GET /secrets`、`GET /subscriptions` 的结果摘要
- **AND** 支持最小操作集：创建 ConnectorInstance、创建 Secret、创建 Subscription、启用/停用 Subscription

### Requirement: 技能列表（Tools）
系统 SHALL 允许具备相应权限的主体在设置页查看已注册工具列表及其当前生效版本摘要。

#### Scenario: 查看工具列表
- **WHEN** 用户打开“技能列表”分区
- **THEN** 可查看 `GET /tools` 返回的工具与 active/effectiveActive 版本摘要

## MODIFIED Requirements
### Requirement: 管理页入口呈现
现有 /admin/* 相关入口在 uiMode=simple 下默认不出现在导航中，但访问控制仍由后端 RBAC 决策强制执行。

## REMOVED Requirements
无
