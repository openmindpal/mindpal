# Tasks
- [x] Task 1: 扩展工作流数据模型以支持 deadletter 与 re-exec
  - [x] SubTask 1.1: 新增 DB 迁移：steps deadletter 标记与 runs reexec 关联字段
  - [x] SubTask 1.2: 更新 workflow repo：deadletter 查询、标记、重试与取消

- [x] Task 2: 补齐 API：workflow deadletters 治理接口与 run 重执行接口
  - [x] SubTask 2.1: 新增 `GET /governance/workflow/deadletters` 与重试/取消动作接口
  - [x] SubTask 2.2: 新增 `POST /runs/:runId/reexec`（创建新 run 并入队/进入审批）
  - [x] SubTask 2.3: 审计事件接入：deadletter、deadletter_retry、deadletter_cancel、reexec

- [x] Task 3: Worker 在队列重试耗尽时落 deadletter
  - [x] SubTask 3.1: 捕获“最终失败”并将 step/job/run 置为 deadletter（写入错误摘要）
  - [x] SubTask 3.2: 确保治理重试后能再次入队并正确推进状态

- [x] Task 4: Web 增加 deadletters 治理页与 run 重执行入口
  - [x] SubTask 4.1: 新增 `/gov/workflow/deadletters` 列表页（分页、跳转到 run）
  - [x] SubTask 4.2: 列表提供“重试/取消”操作，错误时展示 errorCode/traceId
  - [x] SubTask 4.3: Run 详情页增加“重执行”按钮（创建新 run 并跳转）

- [x] Task 5: 测试与回归
  - [x] SubTask 5.1: API 测试覆盖：deadletter 列表/重试/取消、re-exec 行为
  - [x] SubTask 5.2: Worker 测试覆盖：重试耗尽→deadletter、治理重试→再次执行
  - [x] SubTask 5.3: Web e2e 覆盖：deadletters 页面可加载并能触发动作

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2
- Task 5 depends on Task 2, Task 3, Task 4
