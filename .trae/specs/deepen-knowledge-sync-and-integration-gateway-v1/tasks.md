# Tasks
- [x] Task 1: 证据链契约与读模型补齐（Knowledge）
  - [x] SubTask 1.1: 定义 retrieval log 与 evidenceRef 的统一最小字段集合
  - [x] SubTask 1.2: API 增强：证据链展示所需查询接口（过滤/权限/脱敏）
  - [x] SubTask 1.3: 增加证据链健康指标：缺失率/越权剔除计数/阶段耗时

- [x] Task 2: 离线同步复杂冲突处理与修复体验升级（Offline Sync）
  - [x] SubTask 2.1: 冲突分类扩展与诊断摘要（服务端与客户端契约对齐）
  - [x] SubTask 2.2: 修复策略扩展：字段选择/三方合并/保留副本（ops 追加）
  - [x] SubTask 2.3: 一致性与可观测：冲突率、修复耗时、重试/失败分布

- [x] Task 3: Integration Gateway 核心抽象与 API
  - [x] SubTask 3.1: 定义 Integration 定义模型（auth/ingress/egress/state/capabilities）
  - [x] SubTask 3.2: 统一运行记录与健康度：纳入 webhook delivery、subscription runner、oauth callback
  - [x] SubTask 3.3: 治理策略：重试/DLQ/回放入口统一（按 integrationId 可追溯）

- [x] Task 4: 治理面板与运营指标（Web + API）
  - [x] SubTask 4.1: /gov/knowledge 增加证据链健康/时延/缺失分类可视化
  - [x] SubTask 4.2: /gov/sync 增加冲突/队列/重试健康面板与跳转入口
  - [x] SubTask 4.3: /gov/integrations 增加列表/详情/健康/运行记录/DLQ 入口

- [x] Task 5: 连接器生态扩展示例与回归
  - [x] SubTask 5.1: 基于 Integration Gateway 落地 1 个新增连接器（优先 Webhook/SaaS 或低依赖协议）
  - [x] SubTask 5.2: 回归：关键链路 e2e（证据链、冲突修复、integration 运行记录与 DLQ）
  - [x] SubTask 5.3: 文档：Integration Gateway 抽象与连接器开发指南（最小可行）

# Task Dependencies
- Task 2 depends on Task 1
- Task 4 depends on Task 1, Task 2, Task 3
- Task 5 depends on Task 3, Task 4
