# Tasks
- [x] Task 1: 回放聚合逻辑与数据访问
  - [x] SubTask 1.1: 实现 replayRepo：按 runId 读取 run/steps，并按 runId 聚合 audit timeline
  - [x] SubTask 1.2: 限制 timeline 最大条数与字段白名单（只输出摘要）

- [x] Task 2: 回放 API 与审计
  - [x] SubTask 2.1: 新增 `GET /runs/:runId/replay`（鉴权、tenant 隔离）
  - [x] SubTask 2.2: 回放调用写审计（workflow:run.replay）

- [x] Task 3: 回归测试与文档
  - [x] SubTask 3.1: e2e：创建一个 needs_approval run 并回放，timeline 至少包含 approval/request/enqueue 等事件
  - [x] SubTask 3.2: e2e：取消 run 后回放包含 canceled 事件
  - [x] SubTask 3.3: README：补齐 /runs/:runId/replay 示例

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
