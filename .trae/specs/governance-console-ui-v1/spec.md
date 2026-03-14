# 治理控制台界面（Governance Console UI）V1 Spec

## Why
当前管理台已具备“轻便 Console”外壳与设置页分区，但《架构设计.md》要求在开启治理模式后展示路由策略、配额并发、审批与审计、发布与回滚等治理能力入口，需要补齐治理控制面 UI 的最小闭环。

## What Changes
- 新增治理控制台页面组（仅在 uiMode=governance 时在 SideNav/Header 显示入口）：
  - 变更集（ChangeSet）：提交/预检/审批/发布（full/canary）/转全量/回滚
  - 工具治理（Tool Governance）：工具启用/禁用与 active 版本切换
  - 审批队列（Approvals）：列表、详情、通过/拒绝决策
  - 审计（Audit）：查询与 hashchain 校验
  - 模型网关观测（Model Gateway）：路由决策测试（调用 /models/chat 展示 routingDecision 与限流错误）
- 治理页统一使用 ConsoleShell/AppShell 视觉结构（PageHeader + Card/Table）。
- i18n 规范化：新增治理页相关 locales keys，TS/TSX 不出现中文。

## Impact
- Affected specs:
  - 交互平面（UI）与页面配置
  - 治理控制面（发布/灰度/回滚与评测）
  - 工作流与自动化（审批队列）
  - 审计域（append-only + hashchain）
  - 模型网关（路由/限流/配额）
- Affected code:
  - Web：新增 `/gov/*` 页面；更新 ConsoleShell 导航分组与入口
  - Web locales：补齐治理相关文案 keys（zh-CN/en-US）

## ADDED Requirements
### Requirement: 治理入口在 governance 模式可见
系统 SHALL 在 uiMode=governance 时展示治理导航分组与入口；在 uiMode=simple 时隐藏治理入口（不改变后端 RBAC 强制保护）。

#### Scenario: 导航可见性
- **WHEN** uiMode=simple
- **THEN** SideNav 不展示治理分组入口（仍允许直达 URL，由后端 RBAC 决策）
- **WHEN** uiMode=governance
- **THEN** SideNav 展示治理分组入口：变更集、工具治理、审批队列、审计、模型网关观测

### Requirement: 变更集（发布/灰度/回滚）UI 最小闭环
系统 SHALL 提供变更集页面，实现治理控制面最小闭环，并使用统一 API 请求链路。

#### Scenario: 创建与提交变更集
- **WHEN** 用户在变更集列表创建变更集（title + scope + 可选 canaryTargets）
- **THEN** UI 调用 `POST /governance/changesets` 并展示创建结果
- **AND** 用户可在详情页添加 items（例如 tool rollout/active 等治理条目）
- **AND** 用户可触发 `submit`，UI 展示 status 变化与 traceId（如有）

#### Scenario: 预检与发布/回滚
- **WHEN** 用户在变更集详情页触发预检
- **THEN** UI 调用 `POST /governance/changesets/:id/preflight` 并展示 plan/差异摘要（以 JSON 形式呈现）
- **WHEN** 用户选择发布模式 `full` 或 `canary`
- **THEN** UI 调用 `POST /governance/changesets/:id/release?mode=...` 并展示发布结果
- **WHEN** 变更集处于 canary 已发布状态且用户触发转全量
- **THEN** UI 调用 `POST /governance/changesets/:id/promote`
- **WHEN** 用户触发回滚
- **THEN** UI 调用 `POST /governance/changesets/:id/rollback` 并展示回滚结果

### Requirement: 工具治理 UI
系统 SHALL 提供工具治理页面，支持按 scope 查看 rollouts、查看 active toolRef，并提供启用/禁用与 active 切换操作入口。

#### Scenario: Rollout 与 Active 管理
- **WHEN** 用户打开工具治理页
- **THEN** UI 调用 `GET /governance/tools`（可选 scope）并展示 rollouts/actives 列表
- **WHEN** 用户对某 toolRef 执行 enable/disable
- **THEN** UI 调用 `POST /governance/tools/:toolRef/enable|disable`
- **WHEN** 用户为某 name 设置 active toolRef
- **THEN** UI 调用 `POST /governance/tools/:name/active`

### Requirement: 审批队列 UI
系统 SHALL 提供审批队列页面，可查看待审批项并做出通过/拒绝决策。

#### Scenario: 审批查看与决策
- **WHEN** 用户打开审批队列页
- **THEN** UI 调用 `GET /approvals` 展示列表（支持分页/limit）
- **WHEN** 用户打开某审批详情
- **THEN** UI 调用 `GET /approvals/:approvalId` 展示 approval + run/steps 摘要
- **WHEN** 用户提交 approve/reject 决策（含可选 reason）
- **THEN** UI 调用 `POST /approvals/:approvalId/decisions` 并刷新详情状态

### Requirement: 审计查询与链校验 UI
系统 SHALL 提供审计页面，支持按 traceId/subjectId/action 查询，并支持 audit hashchain 校验展示结果。

#### Scenario: 查询与 verify
- **WHEN** 用户输入过滤条件并查询
- **THEN** UI 调用 `GET /audit` 并以表格展示事件摘要（event_id、action、resource、created_at、traceId 等）
- **WHEN** 用户触发 hashchain 校验
- **THEN** UI 调用 `GET /audit/verify` 并展示校验结论与失败点（如有）

### Requirement: 模型网关观测（路由决策测试）
系统 SHALL 提供模型网关观测页，允许用户发起一次受控的 `/models/chat` 调用并展示 routingDecision、latencyMs 与错误分类（如 rate limited）。

#### Scenario: 路由决策展示
- **WHEN** 用户提交 purpose + messages（可选 modelRef）
- **THEN** UI 调用 `POST /models/chat` 并展示 routingDecision 与 traceId
- **AND** 若被限流或策略拒绝，UI 展示 errorCode/message/traceId

### Requirement: i18n 与 lint 约束
系统 SHALL 满足 Web 的 `check-no-zh` 约束：
- TS/TSX 代码中不直接包含中文
- 所有可见文案以 key 的形式维护在 locales，并支持 zh-CN/en-US 回退

## MODIFIED Requirements
### Requirement: ConsoleShell 的治理导航扩展
ConsoleShell 在 uiMode=governance 时扩展治理导航分组链接，但不改变任何后端授权边界与请求链路。

## REMOVED Requirements
无

