# 平台内核 MVP（元数据驱动 + 策略驱动 + 工具化）Spec

## Why
当前仓库以设计文档为主，缺少可运行的最小闭环实现。需要按《架构设计：元数据驱动 + 策略驱动 + AI 工具化平台》落地一个可验证的 MVP 内核，确保平台不变式从第一天就被代码强制执行。

## What Changes
- 建立单体分层的单仓工程骨架：Web/UI、BFF/API、Metadata、Data、AuthN/AuthZ、Audit、Workflow/Queue、Tool/Skill Registry（MVP）
- 落地“统一请求链路”五段式流程：鉴权 → 校验 → 授权 → 执行 → 审计（成功/拒绝/失败都必须审计）
- 平台支持多语言（i18n），默认中文（zh-CN），并遵循用户/空间/租户的语言优先级
- 落地 Schema Registry（版本化）与 Effective Schema 生成（字段级裁剪视图）
- 落地通用数据面：基于 Schema 的通用 CRUD（Postgres + JSONB），并强制执行字段校验与裁剪
- 落地 RBAC（资源级）起步的 AuthZ 决策输出（可解释摘要 + Policy Snapshot 引用/摘要）
- 落地 append-only 审计域（最小字段集合）与可靠写入边界（MVP 可先强一致写审计）
- 落地 Workflow/Queue（MVP）：高风险写意图进入异步 Run/Step 执行框架（可重试/可死信/可审计）
- 明确未实现边界：模型网关、知识/记忆、安全中枢、连接器、离线同步等仅保留接口占位（不进入 MVP 实现）

## Impact
- Affected specs:
  - 交互平面（UI）与页面配置
  - BFF/API 与统一请求链路
  - 元数据平面（Schema Registry）
  - 数据平面（通用 CRUD 与查询）
  - 认证与授权（AuthN/AuthZ，RBAC 起步）
  - 审计域（Audit，append-only）
  - 工作流与自动化（审批、队列、幂等）
- Affected code:
  - 新增 apps/web、apps/api、apps/worker、packages/shared（或等价结构）
  - 新增数据库迁移与运行配置（对接现有 docker-compose.yml / .env.example）

## ADDED Requirements

### Requirement: 多语言（i18n）与默认中文
系统 SHALL 支持多语言展示，平台默认语言为 zh-CN；系统 SHALL 以“可展示的名称/描述”字段支持 i18n 结构（例如 translations 结构或 { "zh-CN": "...", "en-US": "..." } 形态），并在错误消息与 UI 文案中按语言偏好返回/渲染。

语言优先级（从高到低）：
- 用户偏好语言（User Preference）
- 空间/组织默认语言（Space/Org Default）
- 租户默认语言（Tenant Default）
- 平台默认语言：zh-CN

#### Scenario: 默认中文
- **WHEN** 用户未设置语言偏好且空间/租户无覆盖配置
- **THEN** 系统以 zh-CN 渲染 UI 文案与错误 message

#### Scenario: 用户偏好覆盖
- **WHEN** 用户设置语言偏好为 en-US
- **THEN** 系统以 en-US 返回可多语言的 message 字段与可展示的名称/描述（若缺失则按约定回退）

### Requirement: 统一请求链路（平台不变式）
系统 SHALL 将所有读写请求统一收敛到 API 层执行，并按顺序执行：鉴权 → 参数校验 → 授权计算 → 执行 → 审计落库。

#### Scenario: 读请求成功
- **WHEN** 客户端请求读取某实体数据
- **THEN** 系统建立 Subject + Tenant/Space 上下文
- **AND** 系统基于 Schema/查询契约校验输入
- **AND** 系统完成 AuthZ 决策并生成决策摘要
- **AND** 系统在数据面强制行级约束与字段级裁剪
- **AND** 系统写入审计事件并返回已裁剪数据

#### Scenario: 授权拒绝
- **WHEN** 客户端对某资源动作不具备权限
- **THEN** 系统返回稳定 errorCode 与按语言偏好渲染的 message
- **AND** 系统在审计中记录拒绝原因与命中规则摘要

### Requirement: Schema Registry（版本化）
系统 SHALL 提供 Schema 的存储、获取与版本管理能力，并对发布版本执行兼容性检查（MVP 允许先实现基础规则子集）。

#### Scenario: 发布兼容变更
- **WHEN** 管理者为某实体新增可选字段并发布新版本
- **THEN** 系统判定为兼容变更并生成新的 released 版本
- **AND** 系统可按实体+版本获取 Schema

### Requirement: Effective Schema（字段级裁剪视图）
系统 SHALL 基于 Schema + AuthZ 字段规则生成 Effective Schema，并保证前端仅消费 Effective Schema。

#### Scenario: 不可见字段不下发
- **WHEN** 某字段对主体无读权限
- **THEN** Effective Schema 中不包含该字段（或明确标记不可见且前端不渲染）

### Requirement: 通用 CRUD 数据面（强制校验与裁剪）
系统 SHALL 按 Schema 执行业务数据的通用 CRUD，并在数据面强制执行字段校验、行级过滤与字段级裁剪；系统 SHALL 使用 Postgres + JSONB 作为 MVP 数据存储形态。

#### Scenario: 写入幂等
- **WHEN** 客户端以相同 idempotencyKey 重复提交同一写意图
- **THEN** 系统不产生重复副作用并返回第一次执行结果（或可比较摘要）

### Requirement: AuthN/AuthZ（RBAC 起步）
系统 SHALL 建立 Subject 与租户/空间上下文（AuthN），并对资源动作进行 RBAC 授权决策（AuthZ），输出可解释的决策摘要与可回放的一致性引用（Policy Snapshot 引用或摘要）。

#### Scenario: RBAC 允许
- **WHEN** Subject 在 space 作用域绑定的角色包含目标权限
- **THEN** 决策为 allow，并输出 matchedRules 摘要

### Requirement: 审计域（append-only）
系统 SHALL 对所有请求（成功/拒绝/失败）写入审计事件；审计域 SHALL 仅支持追加写入（append-only），并至少包含 eventId、timestamp、subject、tenant/space、resource/action、policyDecisionSummary、idempotencyKey、traceId 等最小字段集合。

#### Scenario: 执行失败可追踪
- **WHEN** 执行阶段出现错误
- **THEN** 审计中记录 errorCategory 与失败摘要
- **AND** 可通过 traceId/runId/stepId 定位执行链路（MVP 可先 traceId）

### Requirement: Workflow/Queue（高风险写入治理，MVP）
系统 SHALL 支持将高风险写意图转入 Workflow/Queue，以 Run/Step 为执行单元，提供可重试、可死信、可取消（MVP 可仅预留取消接口）能力，并保证每次 attempt 都写审计。

#### Scenario: 高风险写入进入队列
- **WHEN** 某工具/动作被标记为 approvalRequired 或高风险
- **THEN** API 创建 workflow/run 并固化 policySnapshot + toolRef + inputDigest
- **AND** worker 执行步骤并写入 step 级审计事件

### Requirement: 工具化扩展（Tool/Skill Contract，MVP）
系统 SHALL 以 Tool Contract 作为可插拔能力的唯一接入形式，工具执行 SHALL 经过统一请求链路并禁止运行时直连数据库。

#### Scenario: 工具受控读写
- **WHEN** 工具执行需要读写业务数据
- **THEN** 工具只能通过平台受控接口访问数据面，并再次经过授权与字段裁剪

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）
