# Tasks
- [x] Task 1: 收敛认证上下文来源（禁止 header 注入）
  - [x] SubTask 1.1: 定义 subject/tenant/space 的唯一来源（token claims）
  - [x] SubTask 1.2: 移除或忽略 x-tenant-id/x-space-id 身份注入路径（保留为调试可选需强约束）
  - [x] SubTask 1.3: 更新 requirePermission/审计写入依赖的 subject 字段

- [x] Task 2: 引入 requestId 并贯穿到审计与响应
  - [x] SubTask 2.1: 在 onRequest 生成 requestId，与 traceId 并存
  - [x] SubTask 2.2: 审计事件落库包含 requestId
  - [x] SubTask 2.3: 对外回显 requestId（响应体或 header）

- [x] Task 3: 审计可靠写入边界（V1：写操作失败即失败）
  - [x] SubTask 3.1: 识别写操作 action 集合并标记强一致审计
  - [x] SubTask 3.2: 审计写入失败时对写操作返回 AUDIT_WRITE_FAILED
  - [x] SubTask 3.3: 保留 read 的尽力审计（并预留配置开关）

- [x] Task 4: 回归测试与文档补齐
  - [x] SubTask 4.1: 更新 e2e：不再依赖 x-tenant-id/x-space-id 伪造租户
  - [x] SubTask 4.2: 覆盖：requestId 存在且写入审计
  - [x] SubTask 4.3: 覆盖：写操作审计失败返回 AUDIT_WRITE_FAILED（可通过注入故障模拟）
  - [x] SubTask 4.4: 更新 README：统一请求头约定（traceId/requestId/locale/idempotencyKey）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 1, Task 2, Task 3
