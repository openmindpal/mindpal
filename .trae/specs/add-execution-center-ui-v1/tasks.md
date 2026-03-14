# Tasks
- [x] Task 1: 对齐 Run API（列表/详情/取消/重试）
  - [x] 1.1：确认现有 Run/Step 数据与状态机字段满足 UI 展示需求
  - [x] 1.2：补齐/对齐接口：GET /runs、GET /runs/:runId（含 steps）、POST /runs/:runId/cancel、POST /runs/:runId/retry（或等价）
  - [x] 1.3：补齐 RBAC 与错误码/traceId 返回规范
  - [x] 1.4：为 cancel/retry 与拒绝路径补齐审计事件
  - [x] 1.5：添加 API 覆盖测试（至少：跨 space 拒绝、cancel finished 拒绝、retry 仅允许 failed）

- [x] Task 2: 实现 Web 执行中心（Run 列表/详情/轮询刷新）
  - [x] 2.1：在 ConsoleShell 导航增加“执行中心”入口（simple/governance 均可见）
  - [x] 2.2：新增 Run 列表页：筛选（status/时间范围）、分页（limit/offset 或 cursor，按现有 API 约定）
  - [x] 2.3：新增 Run 详情页：展示 run 元数据与 steps 表格
  - [x] 2.4：实现进行中轮询刷新与 finished 停止刷新
  - [x] 2.5：实现 Cancel/Retry 操作与错误展示（errorCode/message/traceId）

- [x] Task 3: i18n 与质量门槛
  - [x] 3.1：补齐 locales keys（zh-CN/en-US）并通过 check-no-zh
  - [x] 3.2：为执行中心关键交互添加基础 e2e（列表可见、进入详情、取消/重试的 UI 行为）

# Task Dependencies
- Task 2 depends on Task 1
