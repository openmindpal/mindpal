# Tasks
- [x] Task 1: 新增对话页面路由与导航入口
  - [x] SubTask 1.1: 新增 Chat 页面（路由 + 基础布局 + 消息列表）
  - [x] SubTask 1.2: 接入 Home/ConsoleShell/AppShell 导航入口（不破坏现有导航）

- [x] Task 2: 接入 /orchestrator/turn 并以对话流渲染
  - [x] SubTask 2.1: 发送消息并追加 user/assistant 消息块
  - [x] SubTask 2.2: 错误状态块统一展示（errorCode/message/traceId）
  - [x] SubTask 2.3: uiDirective 展示与可跳转 page（若 openView=page）

- [x] Task 3: toolSuggestions 卡片与执行面板
  - [x] SubTask 3.1: 将 toolSuggestions 作为可操作块渲染（risk/approval/idempotencyKey）
  - [x] SubTask 3.2: 提供 inputDraft JSON 预览与编辑
  - [x] SubTask 3.3: 调用 /orchestrator/execute 并把 receipt/链接结果写入对话流

- [x] Task 4: i18n 与测试回归
  - [x] SubTask 4.1: 补齐 i18n keys（zh-CN/en-US），保持 TS/TSX 无中文
  - [x] SubTask 4.2: 扩展 Web e2e 覆盖 Chat：turn + execute（至少 queued 或 needs_approval）
  - [x] SubTask 4.3: 跑 Web lint（含 check-no-zh）与相关 tests

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 1, Task 2, Task 3
