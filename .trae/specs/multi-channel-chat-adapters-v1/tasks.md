# Tasks
- [x] Task 1: 扩展 webhook 配置支持 providerConfig 并提供查询接口
  - [x] SubTask 1.1: webhook config 支持 providerConfig（按 provider 存储所需参数）
  - [x] SubTask 1.2: 新增 webhook config 列表查询接口用于 Console 展示

- [x] Task 2: 实现飞书（Feishu）端到端接入（入站→turn→投递）
  - [x] SubTask 2.1: 入站 token 校验 + 重放防护 + 事件解析
  - [x] SubTask 2.2: 复用 ingress 去重/映射/orchestrator 并写 outbox/审计
  - [x] SubTask 2.3: 服务端直投递（调用 Feishu 发送消息 API）

- [x] Task 3: Console UI：渠道接入管理页（MVP）
  - [x] SubTask 3.1: 新增 `/gov/channels` 入口与导航
  - [x] SubTask 3.2: 支持配置 provider/workspace、群聊/用户映射、查看 deadletter

- [x] Task 4: 测试与回归（MVP）
  - [x] SubTask 4.1: e2e：url_verification + event_callback + token 失败路径
  - [x] SubTask 4.2: Web build 验证（确保 Console 页面可构建）

- [x] Task 5: 适配器抽象与注册表
  - [x] SubTask 5.1: 定义 ProviderAdapter 注册表与最小 Envelope 摘要能力
  - [x] SubTask 5.2: 将 Feishu 接入迁移为 adapter 并加入注册表

- [x] Task 6: Secret 引用与连通性测试
  - [x] SubTask 6.1: webhook config 支持 secretId（兼容 envKey）
  - [x] SubTask 6.2: 增加 provider 连通性测试接口与 UI

- [x] Task 7: 文档补齐
  - [x] SubTask 7.1: 追加 Feishu 接入步骤与本地模拟示例

- [x] Task 8: 接入 DingTalk（官方回调 + 发送）
  - [x] SubTask 8.1: 实现 DingTalk provider adapter（入站验签/重放防护/去重）
  - [x] SubTask 8.2: 实现 DingTalk send（服务端直投递 + backoff 重试）
  - [x] SubTask 8.3: Console 支持 DingTalk 字段与连通性测试

- [x] Task 9: 接入 企业微信（WeCom）（官方回调 + 发送）
  - [x] SubTask 9.1: 实现 WeCom provider adapter（入站验签/重放防护/去重）
  - [x] SubTask 9.2: 实现 WeCom send（服务端直投递 + backoff 重试）
  - [x] SubTask 9.3: Console 支持 WeCom 字段与连通性测试

- [x] Task 10: 接入 Slack（Events API + Web API）
  - [x] SubTask 10.1: 实现 Slack provider adapter（签名校验/重放防护/去重）
  - [x] SubTask 10.2: 实现 Slack send（chat.postMessage）与失败重试
  - [x] SubTask 10.3: Console 支持 Slack 字段与连通性测试

- [x] Task 11: 接入 Discord（Interactions/Webhook + Bot/REST）
  - [x] SubTask 11.1: 实现 Discord provider adapter（签名校验/重放防护/去重）
  - [x] SubTask 11.2: 实现 Discord send（Webhook 或 Bot）与失败重试
  - [x] SubTask 11.3: Console 支持 Discord 字段与连通性测试

- [x] Task 12: 接入 QQ（OneBot 桥接）
  - [x] SubTask 12.1: 定义 OneBot 桥接入站协议（HTTP webhook 版）
  - [x] SubTask 12.2: 实现 OneBot provider adapter（验签/重放防护/去重）
  - [x] SubTask 12.3: 实现 OneBot send（调用桥接服务）与失败重试
  - [x] SubTask 12.4: Console 支持 QQ(OneBot) 字段与连通性测试

- [x] Task 13: 接入 iMessage（桥接服务）
  - [x] SubTask 13.1: 定义 iMessage 桥接入站协议（HTTP webhook）
  - [x] SubTask 13.2: 实现 iMessage provider adapter（验签/重放防护/去重）
  - [x] SubTask 13.3: 实现 iMessage send（调用桥接服务）与失败重试
  - [x] SubTask 13.4: Console 支持 iMessage 字段与连通性测试

- [x] Task 14: 端到端测试与文档（全 Provider）
  - [x] SubTask 14.1: e2e：每个 Provider 的验签失败/去重/映射缺失路径
  - [x] SubTask 14.2: e2e：每个 Provider 的 happy path（本地 mock/桥接模拟）
  - [x] SubTask 14.3: 文档：各 Provider 接入步骤与本地模拟方式

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 2
- Task 6 depends on Task 1, Task 2
- Task 7 depends on Task 2, Task 3, Task 6
- Task 8 depends on Task 5, Task 6
- Task 9 depends on Task 5, Task 6
- Task 10 depends on Task 5, Task 6
- Task 11 depends on Task 5, Task 6
- Task 12 depends on Task 5, Task 6
- Task 13 depends on Task 5, Task 6
- Task 14 depends on Task 8, Task 9, Task 10, Task 11, Task 12, Task 13
