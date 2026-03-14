# 工具注册表与受控执行（Tool/Skill Contract MVP）Spec

## Why
当前代码已具备 Schema/CRUD/AuthZ/Audit/Workflow 的最小闭环，但“扩展只走契约（Tool/Skill）”尚未落地为可注册、可治理、可审计、可回放的执行入口，需要按《架构设计：元数据驱动 + 策略驱动 + AI 工具化平台》继续推进。

## What Changes
- 新增 Tool Registry：支持工具定义与版本化发布（toolRef = name@version + 依赖摘要占位）
- 新增 Tool Contract：为每个工具声明 inputSchema/outputSchema、风险等级、是否需要审批、展示信息（i18n）
- 新增受控执行入口：统一走 API 创建 Run/Step，worker 执行并写入 step 级审计
- 新增执行回执/回放查询：按 runId/stepId 获取 inputDigest/outputDigest、toolRef、policySnapshotRef、attempt 记录
- 明确边界：工具执行禁止直连数据库；工具只能通过受控接口访问数据面（由平台再执行授权与裁剪）

## Impact
- Affected specs:
  - AI 编排层（受控工具调用与回放）
  - 工作流与自动化（队列、重试、幂等）
  - 审计域（tool/step 级审计）
  - 授权（工具资源的权限与字段规则复用）
- Affected code:
  - API：新增 /tools 路由与 Tool Registry 模块
  - Worker：扩展 step 处理器支持通用 toolRef 执行（先支持最小内置工具集）
  - DB：新增 tool_definitions/tool_versions/tool_invocations（或等价表）迁移

## ADDED Requirements

### Requirement: Tool Registry（工具定义与版本化发布）
系统 SHALL 提供工具的定义、版本管理与发布能力，toolRef 必须可稳定定位到某个已发布版本。

#### Scenario: 发布工具版本
- **WHEN** 管理者发布一个工具新版本
- **THEN** 系统生成可引用的 toolRef（name@version）
- **AND** 系统固化 inputSchema/outputSchema、风险等级与展示信息（支持 i18n）

### Requirement: 受控工具执行（统一链路 + Workflow）
系统 SHALL 提供受控工具执行入口，执行必须经过鉴权→校验→授权→执行→审计；高风险工具 SHALL 进入 Workflow/Queue（Run/Step）执行并记录每次 attempt。

#### Scenario: 低风险工具同步执行（MVP 可选）
- **WHEN** 工具风险等级为 low 且不要求审批
- **THEN** 系统允许同步执行或仍走队列（以实现为准，但必须产出审计）

#### Scenario: 高风险工具进入队列
- **WHEN** 工具标记为 approvalRequired 或风险等级为 high
- **THEN** API 创建 job/run/step 并入队
- **AND** worker 执行 step，失败按统一重试/退避策略处理
- **AND** 每次 attempt 产生 tool/step 级审计事件并可检索

### Requirement: 工具执行回执与回放查询（MVP）
系统 SHALL 支持按 runId/stepId 查询工具执行回执与关键摘要字段，支撑“可解释 + 可回放”。

#### Scenario: 查询回执
- **WHEN** 用户查询某次执行的 runId
- **THEN** 返回 toolRef、policySnapshotRef、inputDigest、outputDigest、状态与 attempt 列表

### Requirement: 禁止旁路直连数据库（执行平面不变式）
系统 SHALL 禁止工具/worker 直接访问业务数据库进行旁路读写；工具执行对业务数据的访问 SHALL 通过平台受控接口进行，并再次执行授权与裁剪。

#### Scenario: 工具尝试旁路写入
- **WHEN** 工具尝试绕过平台接口直接写入业务数据
- **THEN** 系统拒绝执行并记录审计（errorCategory=policy_violation）

## MODIFIED Requirements

### Requirement: Workflow/Queue（高风险写入治理，MVP）
系统 SHALL 将 toolRef 作为一等公民贯穿 Job/Run/Step，Run/Step 级记录 SHALL 可关联到某个 toolRef 版本，并在审计中持久化该引用。

## REMOVED Requirements
（无）

