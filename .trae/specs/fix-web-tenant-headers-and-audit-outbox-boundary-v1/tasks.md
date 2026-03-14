# Tasks
- [x] Task 1: Web 端移除默认 tenant/space header
  - [x] 调整 `apiHeaders()`：默认不发送 `x-tenant-id/x-space-id`，仅在显式 opts 传入时发送
  - [x] 回归：页面加载与常用请求仍可正常工作（依赖后端以 Subject 为准）

- [x] Task 2: 明确并实现“成功写操作走 outbox”的统一边界
  - [x] 定义 API 侧最小语义：哪些 action 属于写操作、哪些路径允许同步审计写入
  - [x] 在 API 增加可复用 helper：在事务内写业务数据时同时入队审计 outbox，并标记本次请求跳过同步审计
  - [x] 增加护栏：写请求返回 2xx 但既未同步写审计也未入队 outbox 时，可观测地报警（指标/日志/测试断言）

- [x] Task 3: 迁移关键写路由到 outbox 策略并消除重复/遗漏风险
  - [x] 迁移范围优先：entities 写、secrets、connectors、tools publish、schemas publish、approvals decisions（以仓库现有写路径为准）
  - [x] 确保每个写路由：业务写与 outbox 入队同事务；且不会再被全局 hook 同步重复写入

- [x] Task 4: 回归测试与验证
  - [x] Web：默认请求不携带 `x-tenant-id/x-space-id` 的覆盖测试或最小校验
  - [x] API：关键写接口 e2e/集成测试，验证“最终仅一条审计事件”与“outbox 失败回滚业务写”

# Task Dependencies
- Task 3 depends on Task 2
- Task 4 depends on Task 1, Task 2, Task 3
