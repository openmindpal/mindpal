# Schema 驱动 UI 页面生成（V1）Spec

## Why
当前 UI 已能消费“已发布 PageTemplate + Navigation”，但页面仍需要人工为每个实体配置。按《架构设计.md》3.2/3.2.1 的主路径，应由 Schema + Policy 自动生成通用业务 UI（列表/详情/表单/搜索），并且所有绑定仍受控、可审计、可发布/回滚。

## What Changes
- 新增“页面生成器”（V1）：从 Effective Schema 自动生成 PageTemplate（draft）
  - 覆盖页面类型：`entity.list`、`entity.detail`、`entity.new`、`entity.edit`
  - 自动生成 DataBinding（只绑定平台 API 白名单）与字段投影/排序/过滤配置
  - 自动生成 ActionBinding（选择最新 released 的 toolRef）
- 新增管理侧生成接口（V1）
  - `POST /ui/page-templates/generate`：按 schemaName+entityName 生成/更新草稿
  - 生成行为写审计（resourceType=ui_config, action=generate）
- Web/UI 最小入口（V1）
  - 在 UI 配置管理页提供“生成默认页面”按钮（仅治理权限）
  - 生成后仍需显式 publish 才可对终端用户可见（遵循现有发布机制）

## Impact
- Affected specs:
  - 交互平面（UI）与页面配置：由“手工配置”升级为“可生成 + 可治理”
  - 元数据平面：Effective Schema 作为生成输入来源
  - 数据平面：列表/详情/表单的受控查询与字段裁剪保持一致
  - 工具/工作流：写动作绑定到 released toolRef
  - 审计域：生成/发布/回滚全链路可追溯
- Affected code:
  - API：uiConfig 模块新增 generator 与 `/ui/page-templates/generate`
  - Web：UI 配置管理页新增生成入口（复用既有发布流程）

## ADDED Requirements

### Requirement: PageTemplate Generator（V1）
系统 SHALL 提供从 Effective Schema 自动生成 PageTemplate 草稿的能力：
- 输入：
  - `schemaName`
  - `entityName`
  - `scope`（tenant 或 space；默认跟随当前 subject scope）
  - `pageKinds`（可选：list/detail/new/edit；默认全生成）
  - `overwriteStrategy`（可选：skip_existing / overwrite_draft）
- 输出：
  - 返回生成/更新的 PageTemplate 列表（仅摘要，不包含敏感字段）

#### Scenario: 生成默认页面（成功）
- **WHEN** 治理者请求为 `core.notes` 生成默认页面
- **THEN** 系统读取 Effective Schema（按调用者权限裁剪）
- **AND** 生成 `entity.list/entity.detail/entity.new/entity.edit` 的 draft PageTemplate
- **AND** 每个页面的 DataBinding 与 ActionBinding 均通过白名单/工具发布校验
- **AND** 写入审计（result=success）

### Requirement: 受控 DataBinding 自动生成（V1）
系统 SHALL 自动生成受控 DataBinding，且只能使用平台 API 白名单：
- `entity.list`：
  - 绑定 `GET /entities/:entityName`（query）与 `GET /schemas/:schemaName/effective`（字段元数据）
  - 自动生成默认 `orderBy`（优先 updatedAt/createdAt，否则无）
  - 自动生成默认 `filters` UI（只针对可读字段，类型安全）
- `entity.detail`：
  - 绑定 `GET /entities/:entityName/:id`（read）与 effective schema
- `entity.new/entity.edit`：
  - 绑定 effective schema（渲染表单字段）

约束：
- 必须以 Effective Schema 为准（不可使用未裁剪的 schema）
- 生成器不得引入任何自定义脚本或非白名单 URL

### Requirement: 受控 ActionBinding 自动生成（V1）
系统 SHALL 为写页面自动生成 ActionBinding：
- `entity.new`：绑定到 `entity.create` 的最新 released `toolRef`
- `entity.edit`：绑定到 `entity.update` 的最新 released `toolRef`

约束：
- 若未找到对应 released toolRef，生成 MUST 失败并返回稳定 errorCode
- 绑定到高风险/需审批工具时，执行仍遵循现有审批/队列机制（不在生成器里绕过）

### Requirement: 生成可治理且可回滚（V1）
系统 SHALL 将“生成”纳入治理流程：
- 生成只产生 draft（不可直接让终端用户可见）
- 发布/回滚沿用现有 PageTemplate 发布机制
- overwriteStrategy 不得覆盖已 released 的版本

### Requirement: 审计摘要（V1）
系统 SHALL 对生成行为写审计摘要：
- 输入摘要：schemaName/entityName/pageKinds/overwriteStrategy
- 输出摘要：生成数量、更新数量、被跳过数量、引用的 toolRef 列表（不含敏感）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

