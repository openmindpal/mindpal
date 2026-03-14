# Tasks
- [x] Task 1: 落地 IM Outbox 数据模型
  - [x] SubTask 1.1: 新增 channel_outbox_messages（回执消息、correlation、ack 状态）
  - [x] SubTask 1.2: 新增索引（按 provider/workspace/chatId、未 ack 过滤）

- [x] Task 2: 实现 Mock IM Ingress API
  - [x] SubTask 2.1: message/command/callback 入站 schema 与统一 Envelope
  - [x] SubTask 2.2: 复用 channel_accounts/channel_chat_bindings 完成 subject 映射
  - [x] SubTask 2.3: 幂等去重与一致 correlation

- [x] Task 3: 实现回执投递与撤销
  - [x] SubTask 3.1: 写入 outbox（received/processing/succeeded/failed）
  - [x] SubTask 3.2: poll/ack API（拉取未 ack 并标记投递/确认）
  - [x] SubTask 3.3: cancel API（产生 canceled 回执并写审计）

- [x] Task 4: 回归测试与文档补齐
  - [x] SubTask 4.1: e2e：message 入站触发回执 + correlation 可追溯
  - [x] SubTask 4.2: e2e：去重命中不重复触发
  - [x] SubTask 4.3: README 增加 Mock IM 使用示例与后续对接点

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
