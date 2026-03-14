# Tasks
- [x] Task 1: 新增审计保留策略与 legal hold 数据模型
  - [x] SubTask 1.1: DB migrations：audit_retention_policies / audit_legal_holds
  - [x] SubTask 1.2: Repo：读写 retention policy 与 legal holds（按 tenant 隔离）

- [x] Task 2: 新增审计导出作业模型与 API
  - [x] SubTask 2.1: DB migrations：audit_exports（query/status/artifactRef/error）
  - [x] SubTask 2.2: API：/audit/retention、/audit/legal-holds、/audit/exports 端点与 RBAC
  - [x] SubTask 2.3: 导出与策略变更写审计（export.* / retention.update / legalHold.*）

- [x] Task 3: Worker 实现 audit export job（jsonl→artifact）
  - [x] SubTask 3.1: 定义队列 jobName、payload（exportId/tenantId/filters）
  - [x] SubTask 3.2: 流式查询 audit_events 并生成 jsonl artifact
  - [x] SubTask 3.3: 失败重试与失败摘要（不泄露敏感信息）

- [x] Task 4: Console（治理模式）最小 UI 支持
  - [x] SubTask 4.1: /gov/audit 增加导出创建与导出列表（或新增 /gov/audit/exports）
  - [x] SubTask 4.2: /gov/audit 增加保留策略与 legal hold 的最小管理入口（可先占位表单）
  - [x] SubTask 4.3: i18n keys（zh-CN/en-US）并通过 check-no-zh

- [x] Task 5: 测试与回归
  - [x] SubTask 5.1: API e2e：创建 retention/hold/export，导出完成后可下载 artifact
  - [x] SubTask 5.2: Web e2e：治理模式下 audit 页面可打开并可创建导出
  - [x] SubTask 5.3: workspaces tests + web lint 通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2
- Task 5 depends on Task 3, Task 4
