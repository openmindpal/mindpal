# Tasks
- [x] Task 1: 设计并落地渠道映射与去重数据模型
  - [x] SubTask 1.1: 新增 channel_accounts/channel_chat_bindings
  - [x] SubTask 1.2: 新增 channel_ingress_events（eventId、idempotencyKey、correlation、status）
  - [x] SubTask 1.3: 增加签名 nonce 去重存储（可复用 ingress_events）

- [x] Task 2: 实现 Webhook Ingress 入口
  - [x] SubTask 2.1: provider 级验签与重放防护（timestamp + nonce）
  - [x] SubTask 2.2: 生成 Envelope 与 headers/body digest
  - [x] SubTask 2.3: 幂等去重与一致回执

- [x] Task 3: 对齐 Subject 映射与同步回执
  - [x] SubTask 3.1: 通过 ChannelAccount/ChatBinding 解析 tenant/space/subject
  - [x] SubTask 3.2: 调用 orchestrator turn（同步模式）并返回标准回执
  - [x] SubTask 3.3: 全链路写审计（received/deduped/denied/succeeded/failed）

- [x] Task 4: 回归测试与文档补齐
  - [x] SubTask 4.1: e2e：验签失败拒绝 + 写审计
  - [x] SubTask 4.2: e2e：幂等去重不重复执行
  - [x] SubTask 4.3: README 增加 Webhook 接入说明与示例

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
