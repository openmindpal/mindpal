# Tasks
- [x] Task 1: 增加 SIEM destinations RBAC permissions 与 seed 绑定
  - [x] SubTask 1.1: seed 写入 audit/siem.destination.{read,write,test,backfill}
  - [x] SubTask 1.2: seed 为 admin 角色绑定上述 permissions

- [x] Task 2: 对齐 SIEM destinations API 的审计 action 命名
  - [x] SubTask 2.1: read/write/test/backfill 与 requirePermission 保持一致
  - [x] SubTask 2.2: 回归 e2e 通过

# Task Dependencies
- Task 2 depends on Task 1
