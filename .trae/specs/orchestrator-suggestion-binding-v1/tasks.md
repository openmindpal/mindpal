# Tasks
- [x] Task 1: 设计 turn/suggestion 持久化数据模型与迁移
  - [x] SubTask 1.1: 新增 orchestrator_turns 表（turnId、tenantId、spaceId、subjectId、message、suggestionsDigest、createdAt）
  - [x] SubTask 1.2: 设计 suggestionId 生成与在 turn 内的稳定性规则

- [x] Task 2: 扩展 /orchestrator/turn 返回 turnId + suggestionId 并写入审计摘要
  - [x] SubTask 2.1: 落库 turn 记录并返回 turnId
  - [x] SubTask 2.2: 为每条 suggestion 注入 suggestionId
  - [x] SubTask 2.3: 审计 outputDigest 增加 turnId 与建议摘要

- [x] Task 3: 扩展 /orchestrator/execute 支持绑定执行并做一致性校验
  - [x] SubTask 3.1: 支持 {turnId, suggestionId, input} 请求体分支
  - [x] SubTask 3.2: 校验 suggestion 存在且 toolRef 一致；不一致返回 409（ORCH_SUGGESTION_MISMATCH）
  - [x] SubTask 3.3: 审计 outputDigest 增加 turnId/suggestionId

- [x] Task 4: 更新 Orchestrator 演示页使用绑定执行
  - [x] SubTask 4.1: turn 调用后保存 turnId，并在执行时提交 turnId+suggestionId
  - [x] SubTask 4.2: UI 展示 turnId/suggestionId，便于排障复制

- [x] Task 5: 测试与回归
  - [x] SubTask 5.1: API e2e：turn 返回 turnId/suggestionId；绑定执行成功
  - [x] SubTask 5.2: API e2e：turnId/suggestionId 不存在返回 404；不一致返回 409
  - [x] SubTask 5.3: Web e2e：Orchestrator 页面加载 + 绑定执行冒烟通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 4
