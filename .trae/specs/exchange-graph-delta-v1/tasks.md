# Tasks
- [x] Task 1: Graph client 与 OAuth 刷新接入
  - [x] SubTask 1.1: 抽象 ExchangeGraphClient（请求封装、超时、分页、重试边界）
  - [x] SubTask 1.2: 在 worker poller 中加载 oauthGrant+secret 并确保 token 可用（必要时 refresh）
  - [x] SubTask 1.3: 失败分类与 errorDigest 结构化输出（auth_required/policy_violation/rate_limited/retryable/fatal）

- [x] Task 2: provider=exchange 真实 delta 拉取与 watermark 迁移
  - [x] SubTask 2.1: 支持初次 delta 与 nextLink 分页，拿到 deltaLink 即更新 watermark
  - [x] SubTask 2.2: 旧 watermark（seq）迁移为 link watermark（兼容行为与审计摘要）
  - [x] SubTask 2.3: eventId/workspaceId 幂等写入 channel_ingress_events，统计去重数量

- [x] Task 3: 摘要化、审计与退避对齐
  - [x] SubTask 3.1: body_json 仅保存结构化摘要（hash/长度），不落邮件正文与附件内容
  - [x] SubTask 3.2: subscription_runs 记录 watermark_before/after、errorCategory、退避信息摘要
  - [x] SubTask 3.3: audit outputDigest 仅记录统计与水位摘要（不含链接/token 明文）

- [x] Task 4: 回归与文档
  - [x] SubTask 4.1: worker 单测：分页/去重/watermark 迁移/429 retry-after 退避
  - [x] SubTask 4.2: e2e：mock Graph（或 stub 层）覆盖成功与失败分类链路
  - [x] SubTask 4.3: README：Exchange 真实拉取的运维说明（授权失效、限流、回滚）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
