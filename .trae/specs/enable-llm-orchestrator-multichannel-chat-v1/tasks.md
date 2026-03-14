# Tasks

* [x] Task 1: 定义并实现 Orchestrator 会话化 turn 契约

  * [x] SubTask 1.1: 扩展 turn 入参/出参支持 conversationId，并保持错误契约一致

  * [x] SubTask 1.2: 接入会话上下文存取与窗口裁剪（读写审计、DLP 摘要）

  * [x] SubTask 1.3: 将模型调用接入 turn（复用模型网关路由/限流/安全治理）

* [x] Task 2: 贯通渠道对话（绑定后可聊）

  * [x] SubTask 2.1: 渠道入站触发 turn 时生成/推导稳定 conversationId（按 provider + chat/thread）

  * [x] SubTask 2.2: 将 replyText 投递回渠道并补齐 correlation（traceId/runId/approvalId 等可用字段）

  * [x] SubTask 2.3: 覆盖多 Provider 的一致行为（至少验证一个官方回调 + 一个桥接回调路径）

* [x] Task 3: Chat Console 支持会话化与重置入口

  * [x] SubTask 3.1: 前端保存 conversationId 并随 turn 透传

  * [x] SubTask 3.2: 提供“新会话/清空上下文”入口与 UX（busy/错误/回执块保持一致）

* [x] Task 4: i18n 与回归测试

  * [x] SubTask 4.1: 补齐新增文案 i18n keys（zh-CN/en-US），保持 Web TS/TSX 无中文

  * [x] SubTask 4.2: 更新 Web e2e 覆盖会话化 turn（含重置与至少一轮模型回复）

  * [x] SubTask 4.3: 更新 API e2e 覆盖渠道对话 happy path（至少一个 Provider）

# Task Dependencies

* Task 2 depends on Task 1

* Task 3 depends on Task 1

* Task 4 depends on Task 1, Task 2, Task 3
