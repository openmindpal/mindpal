# UI 生成进阶（PageTemplate UI 配置）V1 Spec

## Why
当前 UI 渲染运行时已能基于 PageTemplate + Effective Schema 渲染 list/detail/new/edit，但页面体验仍主要由“默认 select + 简单筛选”决定，缺少可运营的页面级配置能力。需要在不破坏“受控 DataBinding 白名单 + 统一请求链路 + 可发布可回滚”的前提下，让治理侧可以配置列表列、筛选项、排序项与表单字段布局，并可由生成器给出合理默认值。

## What Changes
- 扩展 PageTemplate 草稿结构（V1）
  - 新增可选 `ui` 配置块（纯展示配置，不影响权限与数据访问）
    - list：columns、filters、sortOptions、pageSize
    - form（new/edit）：fieldOrder、groups（字段分组）
    - detail：fieldOrder、groups
- 生成器增强（V1）
  - 生成默认 `ui`：根据 Effective Schema 字段类型推导默认列/筛选/排序/表单顺序
  - 保持 dataBindings/actionBindings 规则不变（仍由白名单与已发布 toolRef 约束）
- Web 渲染运行时适配（V1）
  - list：按 columns 渲染列；按 filters 渲染筛选表单；按 sortOptions 提供排序选择；按 pageSize 控制 limit
  - detail/new/edit：按 fieldOrder/groups 控制展示顺序与分组
- 管理页增强（V1）
  - `/admin/ui` 可编辑并保存 `ui` 配置（仅编辑 draft）

## Impact
- Affected specs: 交互平面（UI）与页面配置、治理控制面（Admin UI）
- Affected code:
  - API：uiConfig/pageModel 校验与存储（draft/released JSON）
  - Web：`/p/[page]` 渲染器、`/admin/ui` 编辑器

## ADDED Requirements

### Requirement: PageTemplate UI 配置（V1）
系统 SHALL 支持在 PageTemplate draft 中保存可选 `ui` 配置块：
- `ui` 仅影响 Web 渲染，不改变 dataBindings/actionBindings 的访问能力
- `ui` 不得引入新的数据绑定 target；所有数据访问仍由 dataBindings 白名单控制

#### Scenario: 配置列表列（成功）
- **WHEN** 治理者在 `/admin/ui` 编辑某页面 draft 的 `ui.list.columns`
- **THEN** 保存 draft 后再次打开 `/p/[page]`（released）或预览 draft（若提供）时，列表列按配置展示
- **AND** 若配置列包含不可见字段（不在 Effective Schema），UI 忽略该列

### Requirement: 配置筛选与排序（V1）
系统 SHALL 支持 `ui.list.filters` 与 `ui.list.sortOptions`：
- filters 支持与字段类型匹配的输入控件（string/number/boolean/datetime）
- sortOptions 的字段必须存在于 Effective Schema
- 当启用 cursor 分页时，仍遵守后端约束（cursor 仅支持 `orderBy=updatedAt desc`）

### Requirement: 配置字段布局（V1）
系统 SHALL 支持 detail/new/edit 的字段顺序与分组：
- fieldOrder 为字段名数组（只渲染可见字段；edit/new 只编辑 writable 字段）
- groups 为分组配置（组名 i18n 可选；组内字段列表）

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

