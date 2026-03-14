# Tasks
- [x] Task 1: 定义 mail.exchange connector type 与配置存储
  - [x] SubTask 1.1: 新增 connector_types=mail.exchange（auth_method=oauth，默认 allowedDomains 包含 graph）
  - [x] SubTask 1.2: 新增 exchange_connector_configs 表与 repo（oauthGrantId/mailbox/fetchWindowDays）
  - [x] SubTask 1.3: 新增 API：GET/POST /connectors/instances/:id/exchange（校验 instance enabled、egressPolicy、oauthGrant scope）

- [x] Task 2: Subscription Runner 扩展 provider=exchange
  - [x] SubTask 2.1: 创建 subscription 时校验 connectorInstanceId 类型与已配置 ExchangeConfig
  - [x] SubTask 2.2: worker poller 支持 provider=exchange 分支（MVP 先 mock 拉取）
  - [x] SubTask 2.3: watermark 推进（deltaLink/lastSyncTime）与 subscription_runs 记录
  - [x] SubTask 2.4: 写入 channel_ingress_events（eventId/workspaceId/provider 幂等去重）

- [x] Task 3: 摘要化与审计对齐
  - [x] SubTask 3.1: 入站事件 body_json 仅保存结构化摘要（不含正文/附件明文）
  - [x] SubTask 3.2: poll 审计 outputDigest 仅包含统计与水位摘要

- [x] Task 4: 回归与文档
  - [x] SubTask 4.1: worker 测试：exchange provider 推进 watermark + 幂等去重（mock）
  - [x] SubTask 4.2: e2e：创建 exchange connector instance→配置→创建 subscription→触发 poll→产生 ingress event
  - [x] SubTask 4.3: README：补齐 Exchange connector 与 subscription 的使用说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
