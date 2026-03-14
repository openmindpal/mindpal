# Tasks
- [x] Task 1: 定义 IMAP connector type 与配置校验
  - [x] SubTask 1.1: 在 connectors/types 注册 imap（字段 schema 与说明）
  - [x] SubTask 1.2: 校验 connectorInstance egressPolicy.allowedDomains 覆盖 IMAP host
  - [x] SubTask 1.3: 新增最小“连通性检查”入口（可选，MVP 可先跳过真实探测）

- [x] Task 2: Subscription Runner 扩展 imap provider
  - [x] SubTask 2.1: worker poller 支持 provider=imap 分支
  - [x] SubTask 2.2: watermark 计算与推进（uidNext/lastInternalDate）
  - [x] SubTask 2.3: 写入 channel_ingress_events（eventId/workspaceId/provider 幂等）
  - [x] SubTask 2.4: 失败写入 subscription_runs 并触发退避

- [x] Task 3: 摘要化与审计对齐
  - [x] SubTask 3.1: 入站事件 body_json 只存结构化摘要（不含正文/附件明文）
  - [x] SubTask 3.2: poll 审计 outputDigest 仅包含统计与水位摘要

- [x] Task 4: 回归与文档
  - [x] SubTask 4.1: worker 测试：imap provider 推进 watermark + 幂等去重（可用 mock）
  - [x] SubTask 4.2: e2e：创建 connector instance→创建 subscription→触发 poll→产生 ingress event
  - [x] SubTask 4.3: README：补齐 IMAP connector 与 subscription 的使用说明

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
