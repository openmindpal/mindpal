# Tasks
- [x] Task 1: 设计并落地 Tool 治理数据模型
  - [x] SubTask 1.1: 新增 tool_rollouts（tenant/space + tool_ref + enabled）
  - [x] SubTask 1.2: 新增 tool_active_versions（tenant + tool_name + active_tool_ref）
  - [x] SubTask 1.3: 添加索引与迁移回滚策略（可重复执行）

- [x] Task 2: 实现 Governance API（tools enable/disable/setActive/list）
  - [x] SubTask 2.1: POST /governance/tools/:toolRef/enable（space/tenant scope）
  - [x] SubTask 2.2: POST /governance/tools/:toolRef/disable（space/tenant scope）
  - [x] SubTask 2.3: POST /governance/tools/:name/active（设置 active toolRef）
  - [x] SubTask 2.4: GET /governance/tools（返回 enabled + active 视图）

- [x] Task 3: 在工具执行入口增加治理闸门
  - [x] SubTask 3.1: /tools/:toolRef/execute 执行前校验 enabled
  - [x] SubTask 3.2: 未启用返回稳定错误码（TOOL_DISABLED）并写审计

- [x] Task 4: 回归测试与文档补齐
  - [x] SubTask 4.1: e2e：默认拒绝（未 enable 执行被拒绝）
  - [x] SubTask 4.2: e2e：enable 后可执行，disable 后立即生效
  - [x] SubTask 4.3: README 增加治理开关与 active 版本说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
