# Tasks
- [x] Task 1: 增加 audit/verify RBAC permission 与 seed 默认绑定
  - [x] SubTask 1.1: seed 写入 permissions（audit/verify）
  - [x] SubTask 1.2: seed 为 admin 角色绑定该 permission

- [x] Task 2: /gov/audit 增加审计完整性校验 UI
  - [x] SubTask 2.1: 增加 from/to/limit 输入与执行按钮
  - [x] SubTask 2.2: 展示 verify 结果（ok/checkedCount/failures/lastEventHash）
  - [x] SubTask 2.3: i18n 补齐 zh-CN/en-US 文案

- [x] Task 3: 测试与回归
  - [x] SubTask 3.1: api e2e 覆盖 /audit/verify 基础链路
  - [x] SubTask 3.2: WEB_E2E smoke 断言审计页含完整性校验区块
  - [x] SubTask 3.3: 回归：api/web 测试通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
