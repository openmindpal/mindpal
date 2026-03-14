# Tasks
- [x] Task 1: 增强 entity.list（分页/排序/筛选）
  - [x] SubTask 1.1: nextCursor 分页与“加载更多”（cursor 序列化）
  - [x] SubTask 1.2: 排序约束与 UI 选择（cursor 模式固定 updatedAt desc）
  - [x] SubTask 1.3: 筛选增强（string/number/boolean/datetime）
  - [x] SubTask 1.4: 列展示策略（优先 select，其次 schema 字段顺序/白名单）

- [x] Task 2: 增强 entity.detail（标签/格式化）
  - [x] SubTask 2.1: 字段标签使用 i18n displayName
  - [x] SubTask 2.2: json 摘要/展开，datetime 友好格式

- [x] Task 3: 增强 new/edit 表单（校验/稳定性）
  - [x] SubTask 3.1: required 校验与 UI 提示
  - [x] SubTask 3.2: json 解析错误提示且不崩溃
  - [x] SubTask 3.3: number/boolean/datetime 输入与序列化一致性

- [x] Task 4: 回归与文档
  - [x] SubTask 4.1: e2e：list 分页/筛选/new/edit 不崩溃
  - [x] SubTask 4.2: README：说明 cursor/orderBy 限制与 UI 行为

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 1, Task 2, Task 3
