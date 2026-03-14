# UI 生成增强（Schema 渲染运行时）V1 Spec

## Why
当前已具备“生成 PageTemplate 草稿 + 发布 + 导航可见”的闭环，但终端 UI 仍以跳转/JSON 展示为主，无法体现《架构设计.md》3.2 的核心价值：前端应消费 Effective Schema 与 PageTemplate，通过受控 DataBinding 自动渲染列表/详情/表单/搜索，并保持统一的授权裁剪与可治理发布链路。

## What Changes
- 扩展 UI PageTemplate 契约（V1）
  - pageType：补齐 `entity.detail`、`entity.edit`
  - dataBindings：补齐 `entities.get`、`entities.query`（用于详情与带 filters 的列表）
- 扩展页面生成器（V1）
  - list 页默认生成 `entities.query` binding（含默认 orderBy/limit/select）
  - detail/edit 页默认生成 `entities.get` binding（含 idParam）
- Web 渲染运行时（V1）
  - `/p/[page]` 根据 released PageTemplate 执行 bindings 并渲染：
    - entity.list：表格 + 基础筛选（从 schema 推导）+ 行内跳转（detail/edit）
    - entity.detail：字段详情（按 schema 字段顺序/可读裁剪）
    - entity.new/entity.edit：表单（按字段类型组件渲染；仅 writable 字段可编辑）
- 治理侧（Web）最小增强（V1）
  - `/admin/ui` 的“生成默认页面”支持选择 schemaName/entityName，而非固定 notes

## Impact
- Affected specs: 交互平面（UI）与页面配置、元数据平面（Effective Schema）、数据平面（query 合约）、治理控制面（生成/发布）
- Affected code:
  - API：uiConfig/pageModel + ui route validate + generator
  - Web：PageRenderer（/p/[page]）与基础组件库（list/detail/form/filter）

## ADDED Requirements

### Requirement: 受控 DataBinding（V1）
系统 SHALL 支持以下 DataBinding 目标（白名单）：
- `schema.effective`（现有）：读取 Effective Schema
- `entities.get`（新增）：读取单条实体记录
- `entities.query`（新增）：按 filters/orderBy/select 查询实体列表

#### Scenario: entities.query（成功）
- **WHEN** PageTemplate 的 entity.list 使用 `entities.query`
- **THEN** Web 端按 binding 参数调用 `POST /entities/:entity/query`
- **AND** 返回 items 与 nextCursor（若有）用于渲染列表
- **AND** 查询请求与返回数据均受 AuthZ/字段裁剪与审计约束

### Requirement: Schema 驱动字段渲染（V1）
系统 SHALL 按 Effective Schema 的字段类型生成 UI 控件：
- string/number/datetime：input
- boolean：checkbox
- json：textarea（仅用于可写字段；只显示摘要）

约束：
- 只渲染 Effective Schema 内可见字段
- edit/new 只允许编辑 writable 字段（read-only 字段只读展示或隐藏）

### Requirement: 页面生成器增强（V1）
系统 SHALL 在生成默认页面时补齐以下绑定与默认策略：
- list：生成 `entities.query`（默认 limit=50，默认 orderBy=updatedAt desc 若字段存在）
- detail/edit：生成 `entities.get`（默认从 querystring 读取 `id`）

### Requirement: 管理入口（V1）
系统 SHALL 在治理侧提供可操作入口：
- **WHEN** 治理者在 `/admin/ui` 选择 schemaName/entityName 并点击“生成”
- **THEN** 触发 `POST /ui/page-templates/generate`
- **AND** 提示 review + publish（生成不自动发布）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

