# Tasks
- [x] Task 1: 新增 RBAC 管理页面骨架
  - [x] SubTask 1.1: 添加 `/admin/rbac` 路由与基础布局
  - [x] SubTask 1.2: 从现有页面提供入口链接（最小可达）

- [x] Task 2: 实现 Role/Permission 管理 UI
  - [x] SubTask 2.1: Role 列表 + 创建表单（POST /rbac/roles）
  - [x] SubTask 2.2: Permission 列表（GET /rbac/permissions）与过滤
  - [x] SubTask 2.3: Role 详情页（GET /rbac/roles/:roleId）

- [x] Task 3: 实现授权与绑定操作
  - [x] SubTask 3.1: grant/revoke role permission（POST/DELETE /rbac/roles/:roleId/permissions）
  - [x] SubTask 3.2: create/delete binding（POST /rbac/bindings，DELETE /rbac/bindings/:bindingId）
  - [x] SubTask 3.3: 错误展示（errorCode/message/traceId）

- [x] Task 4: 回归与文档
  - [x] SubTask 4.1: e2e：role 创建→授权→绑定→页面可操作
  - [x] SubTask 4.2: README：补齐 /admin/rbac 使用说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
