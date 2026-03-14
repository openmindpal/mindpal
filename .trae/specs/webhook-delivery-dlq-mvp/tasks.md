# Tasks
- [x] Task 1: IngressEvent 重试/DLQ 数据模型
  - [x] SubTask 1.1: 迁移扩展 channel_ingress_events（status/attemptCount/nextAttemptAt/lastErrorDigest/deadletteredAt）
  - [x] SubTask 1.2: repo 增强：markQueued/listByStatus/getById
  - [x] SubTask 1.3: 幂等与并发保护（单 event 互斥处理）

- [x] Task 2: WebhookConfig 支持 async deliveryMode
  - [x] SubTask 2.1: 扩展 webhook config（deliveryMode/maxAttempts/backoffMsBase）
  - [x] SubTask 2.2: ingress 路由按 deliveryMode 分支（sync 保持现有行为）

- [x] Task 3: Delivery Worker
  - [x] SubTask 3.1: 新增 delivery ticker（worker 定时扫描 queued/failed）
  - [x] SubTask 3.2: 实现 processor：attempt/退避/死信
  - [x] SubTask 3.3: 审计覆盖 attempt/succeeded/deadletter（仅摘要）

- [x] Task 4: DLQ 运营接口与回归
  - [x] SubTask 4.1: 新增治理路由：failed/deadletter/queued 列表查询
  - [x] SubTask 4.2: 新增治理路由：手动 retry（requeue）
  - [x] SubTask 4.3: 回归：async ingress→入队→worker 成功→status 终态
  - [x] SubTask 4.4: 回归：失败→重试→deadletter→手动 retry
  - [x] SubTask 4.5: README：补齐 Webhook async/DLQ 使用说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1 and Task 2
- Task 4 depends on Task 3
