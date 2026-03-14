# Tasks
- [x] Task 1: 定义 /orchestrator/execute 请求/响应契约与审计事件
  - [x] SubTask 1.1: 对齐现有 tools execute 的 receipt 语义与字段
  - [x] SubTask 1.2: 定义 resourceType/action 与 outputDigest 摘要字段

- [x] Task 2: 实现 /orchestrator/execute（复用统一执行链路）
  - [x] SubTask 2.1: 校验 toolRef released + enabled + inputSchema（最小校验）
  - [x] SubTask 2.2: 复用创建 job/run/step 与审批分流（trigger=orchestrator）
  - [x] SubTask 2.3: 返回标准 receipt，并确保 traceId/requestId 贯通

- [x] Task 3: 测试与回归
  - [x] SubTask 3.1: API e2e：无需审批→queued
  - [x] SubTask 3.2: API e2e：需审批→needs_approval 且 approval binding 正确
  - [x] SubTask 3.3: API e2e：非法 toolRef/非法 input 返回稳定错误码

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
