# Tasks
- [x] Task 1: 扩展 UI PageTemplate 合约与校验
  - [x] SubTask 1.1: pageType 增补 entity.detail/entity.edit
  - [x] SubTask 1.2: dataBindings 增补 entities.get/entities.query 并纳入发布校验白名单
  - [x] SubTask 1.3: Web types 同步（UiPageVersion 结构补齐 bindings）

- [x] Task 2: 增强页面生成器
  - [x] SubTask 2.1: list 默认生成 entities.query（limit/orderBy/select）
  - [x] SubTask 2.2: detail/edit 默认生成 entities.get（idParam）
  - [x] SubTask 2.3: /admin/ui 支持选择 schemaName/entityName 触发生成

- [x] Task 3: 实现 Schema 渲染运行时（Web）
  - [x] SubTask 3.1: PageRenderer 执行 bindings 并渲染 list/detail/new/edit
  - [x] SubTask 3.2: 字段类型组件与 writable 约束
  - [x] SubTask 3.3: list 基础筛选与跳转（detail/edit）

- [x] Task 4: 回归与文档
  - [x] SubTask 4.1: e2e：生成→发布→list/detail/edit 可用
  - [x] SubTask 4.2: README：说明 entities.query 与 UI 渲染约束

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
