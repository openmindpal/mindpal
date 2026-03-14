# Tasks
- [x] Task 1: 新增 Orchestrator 演示页与导航入口
  - [x] SubTask 1.1: ConsoleShell 增加导航项（Orchestrator）
  - [x] SubTask 1.2: 新增页面路由与基础布局（message 输入 + 响应区域 + 建议区域）

- [x] Task 2: 接入 /orchestrator/turn 并渲染输出
  - [x] SubTask 2.1: 发起 turn 请求并展示 replyText
  - [x] SubTask 2.2: 展示 uiDirective（只读 + 可跳转 page）
  - [x] SubTask 2.3: 展示 toolSuggestions（toolRef/risk/approval/idempotencyKey/inputDraft）

- [x] Task 3: 接入 /orchestrator/execute（确认执行）
  - [x] SubTask 3.1: 提供 JSON 编辑/确认弹窗（input + idempotencyKey 可选）
  - [x] SubTask 3.2: 展示 receipt 并提供跳转：审批详情 / 执行中心 run 详情
  - [x] SubTask 3.3: 错误展示规范化（errorCode/message/traceId）

- [x] Task 4: i18n 与 e2e
  - [x] SubTask 4.1: 新增 locales keys（zh-CN/en-US），确保 TS/TSX 无中文
  - [x] SubTask 4.2: 扩展 console e2e 覆盖：turn + execute（至少 queued 或 needs_approval）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
