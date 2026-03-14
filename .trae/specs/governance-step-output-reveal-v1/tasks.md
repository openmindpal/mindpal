# Tasks
- [x] Task 1: 设计并落地治理侧 reveal 权限
  - [x] SubTask 1.1: 新增 action（workflow.step.output.reveal）并接入现有策略判断
  - [x] SubTask 1.2: 确认租户/空间 scope 校验与错误码

- [x] Task 2: 新增治理 API：解密查看 step output
  - [x] SubTask 2.1: 新增 route（/governance/workflow/steps/:stepId/output/reveal）
  - [x] SubTask 2.2: 调用 envelope 解密并返回 JSON（不落日志、不写入普通 output 摘要）
  - [x] SubTask 2.3: 写入审计事件 workflow:step.output.reveal（success/denied/error）

- [x] Task 3: 测试与回归
  - [x] SubTask 3.1: API e2e：有权限成功 reveal；无权限拒绝
  - [x] SubTask 3.2: API e2e：非加密 step 返回 STEP_OUTPUT_NOT_ENCRYPTED
  - [x] SubTask 3.3: 回归：现有 runs/steps 列表与执行链路不受影响

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
