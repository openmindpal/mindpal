# Tasks
- [x] Task 1: Subscription 数据模型与存储
  - [x] SubTask 1.1: 新增 migrations：subscriptions/subscription_runs 表与索引
  - [x] SubTask 1.2: 实现 subscriptionRepo（create/get/list/enable/disable/updateWatermark）
  - [x] SubTask 1.3: 实现 subscriptionRunRepo（append/getLastBySubscription）

- [x] Task 2: Subscriptions API
  - [x] SubTask 2.1: `POST /subscriptions`（创建订阅，写审计）
  - [x] SubTask 2.2: `GET /subscriptions`（分页/过滤）
  - [x] SubTask 2.3: `GET /subscriptions/:id`（详情 + 最近一次 run 摘要）
  - [x] SubTask 2.4: `POST /subscriptions/:id/enable`、`POST /subscriptions/:id/disable`

- [x] Task 3: Worker Poller
  - [x] SubTask 3.1: poller job 模型与调度（按 interval）
  - [x] SubTask 3.2: 单订阅并发限制（同一时刻最多 1 个 run）
  - [x] SubTask 3.3: watermark 推进与幂等写入 ingress_events（或等价）
  - [x] SubTask 3.4: 失败退避策略（MVP）

- [x] Task 4: 审计、隔离与回归
  - [x] SubTask 4.1: create/enable/disable/poll 写审计（仅摘要）
  - [x] SubTask 4.2: tenant/space 隔离校验（不可跨空间访问）
  - [x] SubTask 4.3: e2e：创建订阅→触发一次 poll（mock）→产生 ingress event→watermark 推进
  - [x] SubTask 4.4: README：补齐订阅运行器用法与运维说明（MVP）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2 and Task 3
