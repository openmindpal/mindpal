# Tasks
- [x] Task 1: 扩展 ConsoleShell 治理导航与入口
  - [x] SubTask 1.1: uiMode=governance 时新增 /gov 入口与分组链接
  - [x] SubTask 1.2: uiMode=simple 时保持治理入口折叠（仅直达 URL 由 RBAC 控制）
  - [x] SubTask 1.3: 补齐对应 i18n keys（zh-CN/en-US）

- [x] Task 2: 实现变更集（ChangeSet）页面组
  - [x] SubTask 2.1: /gov/changesets 列表与创建（scope/canaryTargets）
  - [x] SubTask 2.2: /gov/changesets/:id 详情：items 列表、add item、状态与 traceId 展示
  - [x] SubTask 2.3: 详情动作：submit/approve/preflight/release(full|canary)/promote/rollback
  - [x] SubTask 2.4: 统一错误模型展示（errorCode/message/traceId）

- [x] Task 3: 实现工具治理（Tool Governance）页面
  - [x] SubTask 3.1: /gov/tools 展示 rollouts 与 actives（可选 scope 过滤）
  - [x] SubTask 3.2: 支持 enable/disable 与 set active 操作并刷新状态

- [x] Task 4: 实现审批队列（Approvals）页面
  - [x] SubTask 4.1: /gov/approvals 列表（limit/分页占位即可）
  - [x] SubTask 4.2: /gov/approvals/:id 详情（approval + run/steps 摘要）
  - [x] SubTask 4.3: approve/reject 决策提交与结果刷新

- [x] Task 5: 实现审计（Audit）页面
  - [x] SubTask 5.1: /gov/audit 查询（traceId/subjectId/action）
  - [x] SubTask 5.2: /gov/audit/verify 触发校验并展示结论

- [x] Task 6: 实现模型网关观测（路由决策测试）页面
  - [x] SubTask 6.1: /gov/model-gateway 表单提交（purpose/messages/modelRef）
  - [x] SubTask 6.2: 展示 routingDecision/latencyMs/traceId 与错误分类

- [x] Task 7: 回归验证与规范收尾
  - [x] SubTask 7.1: 通过 Web lint（含 check-no-zh）并修复新增错误
  - [x] SubTask 7.2: 更新/新增 Web e2e：governance 模式下治理入口可见且关键页面可打开

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1
- Task 5 depends on Task 1
- Task 6 depends on Task 1
- Task 7 depends on Task 2, Task 3, Task 4, Task 5, Task 6
