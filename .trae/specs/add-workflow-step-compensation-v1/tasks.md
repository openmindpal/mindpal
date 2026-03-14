# Tasks
- [x] Task 1: 为 step 增加补偿信息存储
  - [x] SubTask 1.1: DB 迁移新增 steps.compensation（或 undo_token/compensation_tool_ref）
  - [x] SubTask 1.2: 读写映射层（toStep/listSteps）透出可补偿标记（不暴露敏感字段）

- [x] Task 2: Worker 捕获 undoToken 并持久化
  - [x] SubTask 2.1: tool.execute 成功时从 output 提取 undoToken
  - [x] SubTask 2.2: 写入补偿字段，确保 steps.output 不包含 undoToken

- [x] Task 3: 治理 API 触发补偿并写审计
  - [x] SubTask 3.1: 新增 /governance/workflow/steps/:stepId/compensate
  - [x] SubTask 3.2: 接入权限 action=workflow.step.compensate 与 tenant/space scope 校验
  - [x] SubTask 3.3: 调用补偿工具执行，并写审计 workflow.step.compensate（聚合/摘要）

- [x] Task 4: 测试与回归
  - [x] SubTask 4.1: worker tests：undoToken 持久化且不泄露到 steps.output
  - [x] SubTask 4.2: API e2e：可补偿 step 成功触发；不可补偿返回 STEP_NOT_COMPENSABLE
  - [x] SubTask 4.3: 回归：审批/回放/重执行/死信处置用例通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2
- Task 4 depends on Task 3
