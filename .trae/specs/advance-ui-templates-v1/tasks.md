# Tasks
- [x] Task 1: 扩展 PageTemplate 模型以支持 ui 配置块
  - [x] SubTask 1.1: 定义 ui schema（list/detail/form）
  - [x] SubTask 1.2: validateDraft/发布校验允许 ui（仍保持 bindings 白名单约束）
  - [x] SubTask 1.3: Web types 同步（UiPageVersion 增补 ui）

- [x] Task 2: 生成器生成默认 ui 配置
  - [x] SubTask 2.1: list 默认 columns/filters/sortOptions/pageSize
  - [x] SubTask 2.2: detail/new/edit 默认 fieldOrder 与 groups（可选）

- [x] Task 3: Web 渲染运行时适配 ui 配置
  - [x] SubTask 3.1: list：按 columns 渲染列；按 filters 渲染筛选；按 sortOptions 渲染排序选择；pageSize→limit
  - [x] SubTask 3.2: detail/new/edit：按 fieldOrder/groups 渲染
  - [x] SubTask 3.3: 配置鲁棒性：非法字段忽略；不崩溃

- [x] Task 4: /admin/ui 编辑器支持 ui 配置
  - [x] SubTask 4.1: draft 编辑区支持编辑 ui（以 JSON 编辑器起步）
  - [x] SubTask 4.2: 保存后可立即查看渲染效果（复用现有发布/查看流程）

- [x] Task 5: 回归与文档
  - [x] SubTask 5.1: e2e：ui 配置保存→发布→渲染列/筛选/排序生效
  - [x] SubTask 5.2: README：说明 ui 配置块与约束（不影响权限/不新增 bindings）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1
- Task 5 depends on Task 2, Task 3, Task 4
