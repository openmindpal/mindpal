# Tasks
- [x] Task 1: 设计 TriggerDefinition/TriggerRun 数据模型与迁移
  - [x] 定义 Cron/Event 触发最小字段、索引与去重键策略
  - [x] 定义 trigger_run 生命周期与可解释摘要字段

- [x] Task 2: 实现 Cron Trigger Runner（Worker）与投递标准件
  - [x] 计算 nextFireAt、处理 misfirePolicy、并发护栏
  - [x] 生成 idempotency key 并投递 workflow/job
  - [x] 写审计摘要与 run 关联

- [x] Task 3: 实现 Event Trigger Runner（Worker）与事件源适配
  - [x] 接入 ingress.envelope 与 governance.events 两类事件源（V1 最小闭环）
  - [x] 实现过滤与去重、记录 matched/miss 原因摘要

- [x] Task 4: Trigger 治理 API（create/update/enable/disable/preflight/list）
  - [x] 权限与 tenant/space 隔离对齐（trigger.read/trigger.manage/trigger.fire）
  - [x] 预检输出（Cron nextFireAt；Event 最近匹配/未匹配原因）
  - [x] 速率限制与配额护栏（V1 最小）

- [x] Task 5: Undo/补偿可视化标准件（Execution Center）
  - [x] Step 列表/详情展示 compensable 与 compensationStatus
  - [x] 展示补偿历史时间线（仅摘要/引用）
  - [x] 提供受控触发入口与稳定错误码展示

- [x] Task 6: 人机协作标准件（Task/Message 时间线增强）
  - [x] UI 组件：时间线、证据引用、相关 run/step 关联信息
  - [x] 人类注释/交接（handoff）写入与审计对齐

- [x] Task 7: 测试与验收
  - [x] 单测：去重键、过滤、misfire 与并发护栏
  - [x] e2e：Cron 触发→投递→Run 可见；Event 命中/未命中可解释
  - [x] e2e：补偿可视化与受控触发；人机协作事件可追溯

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1
- Task 5 depends on Task 4
- Task 6 depends on Task 4
- Task 7 depends on Task 2, Task 3, Task 4, Task 5, Task 6
