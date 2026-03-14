# Tasks
- [x] Task 1: 扩展 DB 与 RBAC 管理面支持 rowFilters
  - [x] SubTask 1.1: DB 迁移为 permissions 增加 row_filters_read/row_filters_write
  - [x] SubTask 1.2: DB 迁移为 entity_records 增加 owner_subject_id 与必要索引
  - [x] SubTask 1.3: RBAC API 支持创建/授予权限时配置 rowFilters

- [x] Task 2: 授权引擎合并 rowFilters 并写入 Policy Snapshot
  - [x] SubTask 2.1: authorize 合并命中的 rowFilters（按 V1 规则）
  - [x] SubTask 2.2: policy snapshot/decision 返回结构包含 rowFilters

- [x] Task 3: 数据平面强制执行 owner_only
  - [x] SubTask 3.1: entity create 固定 owner_subject_id=subjectId
  - [x] SubTask 3.2: entity get/query/list/export 叠加 owner_subject_id 过滤
  - [x] SubTask 3.3: entity update/delete/import/restore 校验 owner_subject_id 约束

- [x] Task 4: 工具执行链路对齐与防绕过
  - [x] SubTask 4.1: tools.execute 将 rowFilters 透传至 toolContract 并绑定 snapshotRef
  - [x] SubTask 4.2: worker entity.create/update/delete 应用 rowFilters（owner_only）

- [x] Task 5: 测试与回归
  - [x] SubTask 5.1: e2e：owner_only 下仅能读到自己的记录（get/query）
  - [x] SubTask 5.2: e2e：owner_only 下禁止更新/删除他人记录（明确错误码或 404）
  - [x] SubTask 5.3: 回归：bulk io/backup restore/workflow/工具执行链路不受影响

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2
- Task 5 depends on Task 3
- Task 5 depends on Task 4
