# Tasks
- [x] Task 1: 定义并落地 step payload 留存配置项
  - [x] SubTask 1.1: 复用现有 settings 存储或新增配置表字段
  - [x] SubTask 1.2: 增加治理 API 读写 workflow.stepPayloadRetentionDays（权限控制）

- [x] Task 2: Worker 定时清理过期 step 密文 payload
  - [x] SubTask 2.1: 扫描已完成 steps 并按 created_at/finished_at 判断过期
  - [x] SubTask 2.2: 置空 input_encrypted_payload/output_encrypted_payload 并保持摘要字段
  - [x] SubTask 2.3: 写审计事件 workflow.step.payload.purge（聚合）

- [x] Task 3: Reveal/列表兼容与回归
  - [x] SubTask 3.1: reveal：过期时返回明确错误码（STEP_PAYLOAD_EXPIRED）
  - [x] SubTask 3.2: API/worker tests：覆盖未过期可 reveal、过期不可 reveal
  - [x] SubTask 3.3: 回归：回放/审批/编排/死信处置不受影响
 

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
