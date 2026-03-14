# Tasks
- [x] Task 1: 设计并落地 UI 配置数据模型与迁移
  - [x] SubTask 1.1: 定义 page_templates/page_template_versions 最小字段集合（含 i18n）
  - [x] SubTask 1.2: 定义页面类型白名单与绑定结构（DataBinding/ActionBinding）
  - [x] SubTask 1.3: 添加迁移并保证可重复执行

- [x] Task 2: 实现 UI 配置 API（草稿/发布/回滚/导航）
  - [x] SubTask 2.1: 实现页面配置的查询与列表（按 tenant/space）
  - [x] SubTask 2.2: 实现发布与回滚接口（仅治理权限可用）
  - [x] SubTask 2.3: 实现导航聚合接口（仅返回 released）
  - [x] SubTask 2.4: 为配置变更与发布链路写审计（成功/拒绝/失败）

- [x] Task 3: 实现绑定校验与安全护栏
  - [x] SubTask 3.1: 发布时校验 DataBinding 目标在允许清单内
  - [x] SubTask 3.2: 发布时校验 ActionBinding 的 toolRef 存在且 released
  - [x] SubTask 3.3: 非法 pageType 发布拒绝（稳定 errorCode）

- [x] Task 4: Web/UI 改造为配置驱动
  - [x] SubTask 4.1: Web 主页从 /ui/navigation 获取导航并渲染
  - [x] SubTask 4.2: 支持按 pageType 路由到白名单页面（entity.list/entity.new 等）
  - [x] SubTask 4.3: 写动作通过 ActionBinding 调用 tool.execute 并展示回执入口

- [x] Task 5: 回归测试与最小示例数据
  - [x] SubTask 5.1: 提供默认 PageTemplate（notes 列表/新建）并在 seed 中发布
  - [x] SubTask 5.2: 覆盖：未发布不可见、发布可见、绑定校验拒绝、审计落库
  - [x] SubTask 5.3: 更新 README：如何配置页面与回滚

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 2, Task 3, Task 4
