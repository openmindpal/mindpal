# Tasks
- [x] Task 1: 扩展权限模型以支持字段级规则
  - [x] SubTask 1.1: DB 迁移为 permissions 增加 field_rules_read/field_rules_write
  - [x] SubTask 1.2: 更新 RBAC 管理 API/Seed（如有）以可创建/更新字段规则

- [x] Task 2: 授权引擎输出稳定的 fieldRules 并写入快照
  - [x] SubTask 2.1: authorize 合并命中的 permission field rules
  - [x] SubTask 2.2: policy snapshot 存储与返回结构包含 fieldRules

- [x] Task 3: Effective Schema 与数据平面强制执行
  - [x] SubTask 3.1: effective schema 依据 fieldRules 裁剪字段与标记 writable
  - [x] SubTask 3.2: entities read 返回裁剪不可读字段
  - [x] SubTask 3.3: entities write 拒绝不可写字段并返回明确错误码

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: RBAC e2e：字段级规则生效（读裁剪/写拒绝）
  - [x] SubTask 4.2: effective schema e2e：writable 标记与字段裁剪一致
  - [x] SubTask 4.3: 回归：现有 CRUD、工具执行、回放链路不受影响

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
