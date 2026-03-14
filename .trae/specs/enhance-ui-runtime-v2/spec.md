# UI 渲染运行时增强（V2）Spec

## Why
当前 V1 已实现 PageTemplate + Effective Schema 驱动的 list/detail/new/edit 基础渲染，但仍缺少可用性与稳定性能力：列表缺少游标分页与排序约束、筛选能力过弱、表单缺少必填与类型校验、json/datetime 体验不佳。需要在不破坏“统一请求链路/受控 DataBinding/可审计可治理”的前提下提升交互质量。

## What Changes
- List 视图增强（V2）
  - 支持游标分页（nextCursor）与“加载更多”
  - 支持受约束排序（默认 updatedAt desc；启用 cursor 时仅允许该排序）
  - 筛选增强：string contains；number 支持范围（gte/lte）；boolean 支持 true/false；datetime 支持精确匹配
  - 表格列展示更稳定：优先使用 PageTemplate 里的 select；否则使用 schema 字段顺序/白名单策略
- Detail 视图增强（V2）
  - 使用 i18n displayName 作为字段标签（按 locale 渲染）
  - json 以折叠/摘要显示，必要时可展开查看完整 JSON
  - datetime 提供可读格式展示
- New/Edit 表单增强（V2）
  - required 字段提示与提交前校验
  - json 输入解析失败时给出可读错误（不崩溃）
  - number/boolean/datetime 的输入与序列化更稳定（保持与后端 schema validate 一致）
- 模板/绑定兼容性（V2）
  - 保持现有 DataBinding 白名单不变
  - 不新增后端接口；仅使用既有 `/entities/:entity/query`、`/entities/:entity/:id`、`/schemas/:entity/effective` 与 tool execute

## Impact
- Affected specs: 交互平面（UI）与页面配置、数据平面（query 游标约束）
- Affected code:
  - Web：`/p/[page]` 渲染器、列表/详情/表单组件（V2 抽取可复用组件）
  - API：不新增接口；仅需要确保模板生成的 query 与后端约束一致（cursor + orderBy 规则）

## ADDED Requirements

### Requirement: 游标分页（V2）
系统 SHALL 在 entity.list 页面支持游标分页：
- **WHEN** 后端返回 `nextCursor`
- **THEN** UI 渲染“加载更多”链接/按钮
- **AND** 下一次请求携带 cursor（通过 querystring 序列化）
- **AND** 当启用 cursor 时，UI 仅允许 `orderBy=updatedAt desc`（与后端约束一致）

### Requirement: 表单校验与稳定错误（V2）
系统 SHALL 在 new/edit 表单中提供前置校验：
- required 字段未填写时禁止提交并提示
- json 字段解析失败时提示错误并禁止提交
- 任何解析错误不得导致页面崩溃

### Requirement: 标签与格式化（V2）
系统 SHALL 在 detail/list 渲染中使用 Effective Schema 的 displayName 作为字段标签，并按字段类型做最小格式化：
- datetime：按 ISO 或 locale 友好格式展示
- json：默认摘要显示，允许展开查看

## MODIFIED Requirements
（无）

## REMOVED Requirements
（无）

